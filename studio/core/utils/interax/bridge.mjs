/** Local IPC only; all backend protocol behavior belongs to the upstream SDK. */
import { pathToFileURL } from "node:url";
import path from "node:path";
import readline from "node:readline";

export async function createBridge({ root, baseUrl, allowedMethods, fetch, waitMs = 15000, onDelivery = () => {} }) {
  const upstream = (relative) => import(pathToFileURL(path.join(root, relative)).href);
  const { InteraxClient } = await upstream("src/interax_sdk/index.js");
  const { methods } = await upstream("demo/web/catalog.js");
  const { FrontendController } = await upstream("demo/web/controller.js");
  const allowed = new Set(allowedMethods);
  const catalog = methods.filter(({ key }) => allowed.has(key));
  if (catalog.length !== allowed.size) throw new Error("Upstream SDK method catalog changed");
  const client = new InteraxClient({ baseUrl, ...(fetch ? { fetch } : {}) });
  const context = {
    client, session: null, request: null, result: null, question: null,
    async select(id) {
      // Only sessions created by this bridge can be selected.
      if (!client.sessions.has(id)) throw new Error("Session does not belong to this conversation");
      context.session = client.openSession(id);
      context.request = context.result = context.question = null;
    },
  };
  const controller = new FrontendController(context, { baseUrl });
  let skills = [];
  let prepared = null;
  const deliveries = new Map();
  const scope = () => ({ sessionId: context.session?.id ?? null, requestId: context.request?.id ?? null });
  const pages = (snapshot) => (snapshot?.items || [])
    .filter((item) => item.canDisplay && item.documents?.length)
    .map((item) => ({ sessionId: snapshot.sessionId, requestId: item.requestId, itemId: item.id,
      revision: item.revision, title: item.title, summary: item.summary }));
  const delivery = () => ({
    tasks: [...deliveries.values()].flatMap((state) => state.tasks),
    pages: [...deliveries.values()].flatMap((state) => state.pages),
    errors: [...deliveries.values()].flatMap((state) => state.error ? [state.error] : []),
  });
  const remember = (snapshot) => {
    const previous = deliveries.get(snapshot.sessionId);
    const tasks = new Map((previous?.tasks || []).map((task) => [task.requestId, task]));
    for (const request of snapshot.requests) {
      const items = snapshot.items.filter((item) => item.requestId === request.id && item.validity === 'current');
      tasks.set(request.id, {
        sessionId: snapshot.sessionId, requestId: request.id,
        title: request.request?.query || tasks.get(request.id)?.title || 'Interax 任务',
        stage: request.stage || 'unknown',
        failedResults: items.filter((item) => item.generation === 'failed').length,
        questions: snapshot.questions.filter((question) => question.status === 'open' && request.stage === 'waiting')
          .map((question) => ({ id: question.id, text: question.payload?.text || '', required: question.payload?.required !== false })),
      });
    }
    deliveries.set(snapshot.sessionId, { tasks: [...tasks.values()], pages: pages(snapshot) });
  };
  const accepted = (session, request, title) => {
    if (!request.id) return;
    const state = deliveries.get(session.id) || { tasks: [], pages: [] };
    state.tasks = [...state.tasks.filter((task) => task.requestId !== request.id), {
      sessionId: session.id, requestId: request.id, title: title || '页面交互',
      stage: 'accepted', questions: [], failedResults: 0,
    }];
    deliveries.set(session.id, state);
    onDelivery(delivery());
  };
  const selected = (token) => {
    if (!prepared || prepared.token !== token) throw new Error("Page selection is stale; reopen the page");
    return prepared.presentation;
  };
  return {
    async restore(ids) {
      for (const id of ids) client.openSession(id);
      context.session = ids.length ? client.openSession(ids.at(-1)) : null;
      return true;
    },
    async updates(sessionId, after, limit) {
      const session = client.sessions.get(sessionId);
      if (!session) throw new Error('Unknown owned Session');
      let batch, reset = false;
      try { batch = await session.getUpdates({ after, limit }); }
      catch (error) {
        if (error.status !== 409) throw error;
        reset = true;
        batch = await session.getUpdates({ after: 0, limit });
      }
      const snapshot = await session.poll();
      remember(snapshot);
      return { ...batch, snapshot, reset };
    },
    async describe() {
      skills = await client.listSkills();
      return { catalog: catalog.map(({ key, help, example }) => ({ key, help, example })), skills,
        snapshot: context.session ? await context.session.poll() : null, ...scope() };
    },
    async execute(method, parameters = {}) {
      if (!allowed.has(method)) throw new Error("SDK method is not enabled");
      if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw new Error("parameters must be an object");
      if (parameters.sessionId && method !== 'createSession') {
        await context.select(parameters.sessionId);
        parameters = { ...parameters }; delete parameters.sessionId;
      }
      if (method === "submit") {
        if (parameters.interaction !== undefined) throw new Error("Page interactions require a renderer");
        if (parameters.skills !== undefined && (!Array.isArray(parameters.skills) || parameters.skills.some((name) => !skills.some((skill) => skill.name === name)))) throw new Error("Choose skills from listSkills");
      }
      if (method === "request.wait") {
        parameters = { ...parameters, timeoutMs: Math.min(15000, Math.max(100, Number(parameters.timeoutMs) || 15000)) };
      }
      if (!["listSkills", "poll", "getHistory", "getPages", "getPage", "getView",
        "request.progress", "request.wait", "request.results", "result.refresh"].includes(method)) prepared = null;
      let value;
      if (method === 'createSession' && parameters.sessionId) {
        context.session = await client.createSession(parameters);
        context.request = context.result = context.question = null;
        value = { id: context.session.id };
      } else value = await controller.execute(method, parameters);
      if (method !== "submit") return { value, ...scope() };
      // Waiting and result delivery belong to the service scheduler.
      accepted(context.session, value, parameters.text);
      // Acknowledgement and generated output are separate. Preserve submission
      // identity even when waiting or subsequent reads fail.
      const output = { submission: value, ...scope() };
      return output;
    },
    async pages() {
      return (await this.delivery()).pages;
    },
    async delivery() {
      // Keep earlier goals visible after the model selects a new Session.
      await Promise.all([...client.sessions.values()].map(async (session) => {
        try {
          remember(await session.poll({ signal: AbortSignal.timeout(10000) }));
        } catch (error) {
          const state = deliveries.get(session.id) || { tasks: [], pages: [] };
          state.error = { sessionId: session.id, code: error.code || 'query_failed' };
          deliveries.set(session.id, state);
        }
      }));
      return delivery();
    },
    async openPage(page, token) {
      const session = client.sessions.get(page.sessionId);
      if (!token || !session) throw new Error("Page session does not belong to this conversation");
      const snapshot = await session.poll();
      const item = snapshot.items.find((item) => item.id === page.itemId && item.revision === page.revision && item.canDisplay);
      if (!item) throw new Error("Page version is no longer available");
      prepared = null;
      const presentation = await item.prepare({ mode: "display" });
      prepared = { token, presentation, session };
      return { ...page, token, documents: presentation.documents };
    },
    async confirmPage(token) {
      return selected(token).confirmDisplayed();
    },
    async failPage(token, message) {
      return selected(token).reportFailure(message);
    },
    async interact(token, data) {
      const presentation = selected(token);
      if (!presentation.displayed) throw new Error("Page has not been confirmed displayed");
      const session = prepared.session;
      const view = await session.getView();
      if (!view.applied || view.view_id !== presentation.view.view_id) throw new Error("Displayed page has changed");
      const result = await session.submitInteraction(data);
      accepted(session, result, '页面交互');
      return result;
    },
    dispose() { prepared = null; client.dispose(); },
  };
}

async function main() {
  let bridge;
  // Python serializes commands and owns the lifetime of this process.
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      let message;
      try {
        message = JSON.parse(line);
        let value;
        if (message.op === "initialize") {
          if (bridge) throw new Error("Already initialized");
          bridge = await createBridge({ ...message.parameters, onDelivery: (value) => {
            process.stdout.write(JSON.stringify({ event: "delivery", value }) + "\n");
          } });
          value = true;
        } else if (message.op === "describe") {
          value = await bridge.describe();
        } else if (message.op === "restore") {
          value = await bridge.restore(message.sessions);
        } else if (message.op === "updates") {
          value = await bridge.updates(message.sessionId, message.after, message.limit);
        } else if (message.op === "execute") {
          value = await bridge.execute(message.method, message.parameters);
        } else if (message.op === "pages") {
          value = await bridge.pages();
        } else if (message.op === "delivery") {
          value = await bridge.delivery();
        } else if (message.op === "openPage") {
          value = await bridge.openPage(message.page, message.token);
        } else if (message.op === "confirmPage") {
          value = await bridge.confirmPage(message.token);
        } else if (message.op === "failPage") {
          value = await bridge.failPage(message.token, message.message);
        } else if (message.op === "interact") {
          value = await bridge.interact(message.token, message.data);
        } else if (message.op === "dispose") {
          bridge?.dispose();
          return;
        } else throw new Error("Unknown bridge operation");
        process.stdout.write(JSON.stringify({ id: message.id, ok: true, value }) + "\n");
      } catch (error) {
        process.stdout.write(JSON.stringify({ id: message?.id, ok: false, error: {
          name: error.name, status: error.status ?? 0, code: error.code ?? "invalid_operation",
        } }) + "\n");
      }
    }
  } finally { bridge?.dispose(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { process.exitCode = 1; });
}
