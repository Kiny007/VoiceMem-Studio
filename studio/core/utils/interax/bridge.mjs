/** Local IPC only; all backend protocol behavior belongs to the upstream SDK. */
import { pathToFileURL } from "node:url";
import path from "node:path";
import readline from "node:readline";

export async function createBridge({ root, baseUrl, allowedMethods, fetch, waitMs = 15000 }) {
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
  const scope = () => ({ sessionId: context.session?.id ?? null, requestId: context.request?.id ?? null });
  const pages = (snapshot) => (snapshot?.items || [])
    .filter((item) => item.canDisplay && item.documents?.length)
    .map((item) => ({ sessionId: context.session.id, itemId: item.id,
      revision: item.revision, title: item.title, summary: item.summary }));
  const selected = (token) => {
    if (!prepared || prepared.token !== token) throw new Error("Page selection is stale; reopen the page");
    return prepared.presentation;
  };
  return {
    async describe() {
      skills = await client.listSkills();
      return { catalog: catalog.map(({ key, help, example }) => ({ key, help, example })), skills,
        snapshot: context.session ? await context.session.poll() : null, ...scope() };
    },
    async execute(method, parameters = {}) {
      if (!allowed.has(method)) throw new Error("SDK method is not enabled");
      if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw new Error("parameters must be an object");
      if (method === "submit") {
        if (parameters.interaction !== undefined) throw new Error("Page interactions require a renderer");
        if (parameters.skills !== undefined && (!Array.isArray(parameters.skills) || parameters.skills.some((name) => !skills.some((skill) => skill.name === name)))) throw new Error("Choose skills from listSkills");
      }
      if (method === "request.wait") {
        parameters = { ...parameters, timeoutMs: Math.min(15000, Math.max(100, Number(parameters.timeoutMs) || 15000)) };
      }
      if (!["listSkills", "poll", "getHistory", "getPages", "getPage", "getView",
        "request.progress", "request.wait", "request.results", "result.refresh"].includes(method)) prepared = null;
      const value = await controller.execute(method, parameters);
      if (method !== "submit") return { value, ...scope() };
      // Acknowledgement and generated output are separate. Preserve submission
      // identity even when waiting or subsequent reads fail.
      const output = { submission: value, ...scope() };
      try {
        if (value.id) {
          try {
            output.progress = await value.wait({ timeoutMs: waitMs });
          } catch (error) {
            if (error.name !== "TimeoutError") throw error;
            output.waitTimedOut = true;
            output.progress = await value.progress();
          }
          output.results = await value.results();
        }
        output.snapshot = await context.session.poll();
        output.pages = pages(output.snapshot);
      } catch (error) {
        output.readError = { name: error.name, status: error.status ?? 0, code: error.code ?? "read_failed" };
      }
      return output;
    },
    async pages() {
      return context.session ? pages(await context.session.poll()) : [];
    },
    async openPage(page, token) {
      if (!token || page.sessionId !== context.session?.id) throw new Error("Page session is no longer selected");
      const snapshot = await context.session.poll();
      const item = snapshot.items.find((item) => item.id === page.itemId && item.revision === page.revision && item.canDisplay);
      if (!item) throw new Error("Page version is no longer available");
      prepared = null;
      const presentation = await item.prepare({ mode: "display" });
      prepared = { token, presentation };
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
      const view = await context.session.getView();
      if (!view.applied || view.view_id !== presentation.view.view_id) throw new Error("Displayed page has changed");
      const result = await context.session.submitInteraction(data);
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
          bridge = await createBridge(message.parameters);
          value = true;
        } else if (message.op === "describe") {
          value = await bridge.describe();
        } else if (message.op === "execute") {
          value = await bridge.execute(message.method, message.parameters);
        } else if (message.op === "pages") {
          value = await bridge.pages();
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
