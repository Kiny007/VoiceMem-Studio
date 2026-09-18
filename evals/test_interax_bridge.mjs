/** Exercise upstream SDK/wrappers with injected fetch; no server or model runs. */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBridge } from "../studio/core/utils/interax/bridge.mjs";

const root = process.env.STUDIO_INTERAX_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../Interax");
const methods = ["createSession", "submit", "listSkills", "poll", "request.progress",
  "request.wait", "request.results", "question.answer", "question.skip", "cancel"];

function backend() {
  const calls = [];
  let stage = "completed";
  let requestId = "request_one";
  let failReads = false;
  let retrySubmit = false;
  let pageRevision = 0;
  let applied = false;
  let viewId = 0;
  let queryFailure = false;
  let progressGate = null;
  const reference = () => ({ artifact_id: `artifact_${pageRevision}`, media_type: "text/html" });
  const progress = () => ({ id: requestId, stage, status: "accepted", request: { query: "fixture" } });
  const item = (id, owner) => ({ item_id: id, request_id: owner, item_revision: pageRevision || 1,
    text: { title: "Fixture", summary: "Verified output", narration: "Actual narration" },
    kind: "text", preparation: { status: "prepared" }, eligibility: { can_present: pageRevision > 0, can_play: false },
    presentation: pageRevision ? [reference()] : [], display: { status: applied ? "displayed" : "not_displayed" }, validity: "current" });
  return {
    calls,
    setStage(value) { stage = value; },
    setRequestId(value) { requestId = value; },
    failReads() { failReads = true; },
    retrySubmit() { retrySubmit = true; },
    publishPage() { pageRevision++; applied = false; },
    setQueryFailure(value) { queryFailure = value; },
    holdProgress() { let release; progressGate = new Promise(resolve => { release = resolve; }); return release; },
    async fetch(url, options) {
      assert(url.pathname.startsWith("/proxy/v1/"), "SDK must preserve the proxy prefix");
      const relative = url.pathname.slice("/proxy/v1/".length);
      if (queryFailure && (relative.endsWith('/overview') || relative.endsWith('/updates'))) {
        return new Response(JSON.stringify({ error: 'Fixture unavailable' }), { status: 422 });
      }
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ relative, body });
      let result;
      let status = 200;
      if (relative === "skills") result = [{ name: "future-skill", description: "Upstream capability" }];
      else if (relative.endsWith("/commands")) {
        assert(body.command_id);
        assert(body.type);
        assert(body.name);
        if (body.name === "text") {
          result = { ok: true, epoch: 1, request_id: requestId };
          if (retrySubmit) { retrySubmit = false; status = 503; }
        } else if (body.name === "answer" && body.payload.skip) {
          result = { error: "Required question" }; status = 409;
        } else if (body.name === "item.acquire") {
          assert.equal(body.payload.mode, "present");
          applied = false;
          result = { presentation: [reference()], view: { view_id: `view_${++viewId}`, epoch: 1 } };
        } else if (body.name === "view.applied") {
          assert.equal(body.payload.view_id, `view_${viewId}`);
          applied = true;
          result = { ok: true };
        } else result = { ok: true, epoch: 1 };
      } else if (relative.includes("/items/")) {
        result = item(relative.split("/").at(-1), "request_one");
      } else if (relative.includes("/artifacts/")) {
        return new Response('<!doctype html><html><head></head><body><button>Next search step</button></body></html>');
      } else if (relative.includes("/requests/")) {
        if (progressGate) await progressGate;
        if (failReads) { result = { error: "Read failed" }; status = 422; }
        else result = progress();
      } else if (relative.endsWith("/overview")) {
        result = { session_id: relative.split("/")[1], goal: "fixture goal", cursor: 0,
          status: stage, view: { displayed_page: null, page: null }, pages: { pages: [], total: 0 },
          items: [item("result_one", "request_one"), item("other_result", "other_request")],
          preparations: [], requests: requestId ? [progress()] : [],
          questions: [{ id: "question_one", status: "open", payload: { text: "Choose", required: true } }],
          delivery: {},
        };
      } else if (relative.endsWith("/messages")) result = { messages: [{ id: "message_one", role: "assistant", text: "Verified answer" }], next_cursor: 0, has_more: false };
      else if (relative.endsWith("/updates")) result = { updates: pageRevision ? [{ type: "item.changed", payload: {} }] : [], next_cursor: 0, has_more: false };
      else if (relative.endsWith("/view")) result = { epoch: 1, view_id: `view_${viewId}`, applied,
        displayed_page: applied ? reference() : null };
      else throw new Error(`Unexpected SDK path: ${relative}`);
      return new Response(JSON.stringify(result), { status, headers: { "Content-Type": "application/json" } });
    },
  };
}

async function fixture(run) {
  const server = backend();
  const updates = [];
  let notify;
  const notified = new Promise(resolve => { notify = resolve; });
  const bridge = await createBridge({ root, baseUrl: "https://interax.invalid/proxy/", allowedMethods: methods,
    fetch: server.fetch, waitMs: 5, onDelivery: state => { updates.push(structuredClone(state)); notify(); } });
  try { await bridge.describe(); await run(bridge, server, { updates, notified }); }
  finally { bridge.dispose(); }
}

await fixture(async (bridge, server) => {
  const description = await bridge.describe();
  assert.equal(description.skills[0].name, "future-skill");
  assert(description.catalog.find((entry) => entry.key === "submit").help.includes("effort"));
  await bridge.execute("createSession", {});
  server.retrySubmit();
  const output = await bridge.execute("submit", { text: "Draw the fixture", skills: ["future-skill"], effort: "high" });
  assert.equal(output.submission.id, "request_one");
  output.results = (await bridge.execute("request.results", {})).value;
  assert.equal(output.results.length, 1, "request.results must exclude another request's output");
  assert.equal(output.results[0].narration, "Actual narration");
  assert.equal(output.results[0].display, "not_displayed");
  const submissions = server.calls.filter((call) => call.body?.name === "text");
  assert.equal(submissions.length, 2);
  assert.deepEqual(submissions[0].body, submissions[1].body, "SDK retries preserve command ID and body");
  assert.deepEqual(submissions[0].body.payload.skills, ["future-skill"]);
  await bridge.execute("question.answer", { questionId: "question_one", text: "My answer" });
  assert(server.calls.some((call) => call.body?.payload.question_id === "question_one"));
  await assert.rejects(() => bridge.execute("question.skip", { questionId: "question_one" }), (error) => error.status === 409);
  for (const method of ["delete", "openSession", "listSessions", "content.confirmDisplayed", "content.reportPlayback"]) {
    await assert.rejects(() => bridge.execute(method, {}));
  }
  await assert.rejects(() => bridge.execute("submit", { text: "fixture", skills: ["invented"] }));
  assert(!server.calls.some((call) => call.body?.type === "receipt"));
});

for (const stage of ["waiting", "failed", "rejected", "cancelled", "running"]) {
  await fixture(async (bridge, server) => {
    server.setStage(stage);
    await bridge.execute("createSession", {});
    const result = await bridge.execute("submit", { text: "fixture" });
    assert.equal(result.submission.id, "request_one");
    assert.equal((await bridge.delivery()).tasks[0].stage, stage);
    assert(!server.calls.some(call => call.relative.includes("/requests/")));
  });
}
await fixture(async (bridge, server) => {
  server.setRequestId(null);
  await bridge.execute("createSession", {});
  const result = await bridge.execute("submit", { text: "fixture control" });
  assert.equal(result.submission.id, null);
  assert.equal(result.snapshot, undefined);
  assert(!server.calls.some((call) => call.relative.includes("/requests/")));
});
await fixture(async (bridge, server) => {
  await bridge.execute("createSession", {});
  server.failReads();
  const result = await bridge.execute("submit", { text: "fixture" });
  assert.equal(result.submission.id, "request_one");
  assert.equal(result.readError, undefined, "Submission acknowledgement does not wait for reads");
});
await fixture(async (bridge, server) => {
  await bridge.execute("createSession", {});
  server.setStage("running");
  const pending = await bridge.execute("submit", { text: "Create an interactive binary search page" });
  assert.equal(pending.submission.id, "request_one");
  assert.deepEqual(await bridge.pages(), []);
  server.publishPage();
  const pages = await bridge.pages();
  assert.equal(pages.length, 2);
  assert(!server.calls.some((call) => call.body?.name === "item.acquire"), "Discovery must not invalidate page selections");
  const page = await bridge.openPage(pages[0], "selection_one");
  assert(page.documents[0].content.includes("Next search step"));
  assert(!server.calls.some((call) => call.body?.type === "receipt"), "Downloading HTML is not display");
  await assert.rejects(() => bridge.interact("selection_one", { action: "next" }), /not been confirmed/);
  await bridge.confirmPage("selection_one");
  await bridge.interact("selection_one", { action: "next" });
  await bridge.interact("selection_one", { action: "next" });
  assert.equal(server.calls.filter((call) => call.body?.name === "ui_action").length, 2);
  const interaction = server.calls.find((call) => call.body?.name === "ui_action").body;
  assert.deepEqual(interaction.payload.data, { action: "next" });
  assert.equal(interaction.payload.artifact_id, "artifact_1");
  assert.equal(interaction.payload.view_id, "view_1");
  server.publishPage();
  const revised = await bridge.pages();
  assert.equal(revised[0].revision, 2);
  await assert.rejects(() => bridge.openPage(pages[0], "old_version"), /no longer available/);
  await bridge.openPage(revised[0], "selection_two");
  await assert.rejects(() => bridge.confirmPage("selection_one"), /stale/);
  await bridge.failPage("selection_two", "Renderer failed");
  assert(server.calls.some((call) => call.body?.name === "view.failed"));
  await bridge.execute("createSession", {});
  await assert.rejects(() => bridge.confirmPage("selection_two"), /stale/);
  server.publishPage();
  const all = await bridge.delivery();
  const latePage = all.pages.find(page => page.sessionId === revised[0].sessionId);
  assert.equal(latePage.revision, 3, 'Earlier Sessions deliver revisions after a new goal is selected');
  await bridge.openPage(latePage, "earlier_session");
  await bridge.confirmPage("earlier_session");
  await bridge.interact("earlier_session", { action: "next" });
  assert.equal(server.calls.filter(call => call.body?.name === 'ui_action').at(-1).relative,
    `sessions/${revised[0].sessionId}/commands`, 'Old pages interact with their own Session');
  await assert.rejects(() => bridge.openPage({ ...revised[0], sessionId: 'foreign_session' }, 'foreign'), /session/i);
  assert(!server.calls.some((call) => call.body?.name?.startsWith("playback.")));
});
await fixture(async (bridge, server, { updates, notified }) => {
  await bridge.execute('createSession', {});
  const release = server.holdProgress();
  let finished = false;
  const submit = bridge.execute('submit', { text: 'Make a page' }).then(result => { finished = true; return result; });
  await notified;
  assert(updates.length, 'Acknowledgement is published independently of polling');
  assert.equal(updates[0].tasks[0].stage, 'accepted');
  assert.equal(updates[0].tasks[0].title, 'Make a page');
  assert.deepEqual(updates[0].pages, []);
  release();
  await submit;
  assert.equal((await bridge.delivery()).tasks[0].stage, 'completed');
});
await fixture(async (bridge, server) => {
  await bridge.execute('createSession', {});
  server.setStage('waiting');
  await bridge.execute('submit', { text: 'Make a page' });
  let state = await bridge.delivery();
  assert.equal(state.tasks[0].questions[0].text, 'Choose', 'Session questions are attached to the waiting request');
  server.publishPage();
  state = await bridge.delivery();
  server.setQueryFailure(true);
  const failed = await bridge.delivery();
  assert.deepEqual(failed.pages, state.pages, 'Transient query failure preserves known pages');
  assert.equal(failed.errors.length, 1);
  server.setQueryFailure(false);
  server.setStage('failed');
  const recovered = await bridge.delivery();
  assert.deepEqual(recovered.errors, []);
  assert.equal(recovered.tasks[0].stage, 'failed');
});
console.log("Interax SDK/wrapper and page delivery offline contracts passed");
