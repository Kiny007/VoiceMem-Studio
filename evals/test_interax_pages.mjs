/** Deterministic UI state checks with a fake DOM; no browser or server starts. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor() { this.children = []; this.textContent = ''; this.open = false; }
  set innerHTML(value) {
    this.nodes = Object.fromEntries(['strong', 'p', 'button', '.interax-canvas'].map(key => [key, new Element()]));
  }
  querySelector(selector) { return this.nodes[selector]; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren() { this.children = []; }
  addEventListener() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
}
const source = readFileSync(new URL('../studio/web/interax-pages.js', import.meta.url), 'utf8');
let releaseRender, interaction, failRender = false;
let notifyRender;
const beganRendering = new Promise(resolve => { notifyRender = resolve; });
const renderStarted = [];
const context = vm.createContext({
  document: { body: new Element(), createElement: () => new Element() },
  crypto: globalThis.crypto, AbortController,
  loadRenderer: async () => ({ createIframeRenderer: (container, options) => {
    interaction = options.onInteraction;
    return async (documents, { signal }) => {
      renderStarted.push(documents);
      notifyRender();
      if (failRender) throw new Error('Fixture rendering failure');
      await new Promise(resolve => { releaseRender = resolve; });
      signal.throwIfAborted();
    };
  } }),
});
vm.runInContext(source.replace('export class InteraxPages', 'globalThis.InteraxPages = class InteraxPages')
  .replace("await import('/interax-sdk/browser.js')", 'await loadRenderer()'), context);
const sent = [], notices = [];
const session = { space: 'space_a', ui: {} };
let current = session, connected = true;
const ui = new context.InteraxPages({
  send: (owner, message) => { assert.equal(owner, session); if (!connected) return false; sent.push(message); return true; },
  isCurrent: owner => owner === current,
  notify: message => notices.push(message), changed: () => {},
});
const page = { sessionId: 'sdk_session', itemId: 'result_one', revision: 1, title: '<script>unsafe title</script>', summary: 'Binary search' };
const socket = {};
ui.update(session, [page], socket);
const cards = new Element();
ui.cards(session, cards);
assert.equal(cards.children.length, 1);
assert.equal(cards.children[0].children[0].textContent, page.title, 'Page metadata must be text, not HTML');
cards.children[0].children[2].onclick();
assert.equal(sent[0].action, 'openPage');
const token = sent[0].token;
assert.equal(ui.dialog.open, true);
const response = (action, extra = {}) => ({ action, token, space: 'space_a', ok: true, ...extra });
const rendering = ui.result(response('openPage', { result: { documents: [{ content: '<html>fixture</html>' }] } }));
await beganRendering;
assert.equal(renderStarted.length, 1);
assert.equal(sent.length, 1, 'Receipt must wait for renderer readiness');
interaction({ action: 'next' });
assert.equal(sent.length, 1, 'GUI must wait for confirmed display');
releaseRender();
await rendering;
assert.equal(sent.at(-1).action, 'confirmPage');
await ui.result(response('confirmPage'));
interaction({ action: 'next' });
assert.equal(sent.at(-1).action, 'interact');
assert.deepEqual(sent.at(-1).data, { action: 'next' });
const count = sent.length;
interaction({ action: 'duplicate' });
assert.equal(sent.length, count, 'Only one interaction may be pending');
await ui.result(response('interact'));
assert.equal(ui.active.confirmed, true);
ui.update(session, [{ ...page, revision: 2 }], socket);
assert.equal(ui.dialog.open, false);
assert.equal(notices.length, 1);
await ui.result(response('confirmPage'));
assert.equal(ui.active, null, 'Late receipt must not resurrect an old selection');

ui.open(session, page);
const secondToken = ui.active.token;
assert.notEqual(secondToken, token);
failRender = true;
await ui.result({ ...response('openPage'), token: secondToken, result: { documents: [] } });
assert.equal(sent.at(-1).action, 'failPage');
assert.equal(ui.active.confirmed, false);
assert(ui.status.textContent.includes('失败'));
await ui.result({ ...response('confirmPage'), token: secondToken, ok: false, error: { code: 'stale_presentation' } });
assert(ui.status.textContent.includes('stale_presentation'));
current = { space: 'other_space' };
await ui.result({ ...response('confirmPage'), token: secondToken });
assert.equal(ui.active.confirmed, false);
current = session;
connected = false;
ui.open(session, page);
assert(ui.status.textContent.includes('连接已结束'));
ui.close();

const task = { sessionId: page.sessionId, requestId: 'request_one', title: '<b>Make a page</b>', stage: 'accepted', questions: [] };
const ownedPage = { ...page, requestId: task.requestId };
const taskSocket = { interaxOwners: new Map([['space_a', session]]) };
const texts = element => [element.textContent, ...element.children.flatMap(texts)].join(' ');
const buttons = element => element.children.flatMap(child => child.type === 'button' ? [child] : buttons(child));
ui.receive('space_a', { tasks: [task], pages: [], errors: [] }, taskSocket);
cards.replaceChildren(); ui.cards(session, cards);
assert.equal(cards.children.length, 1, 'An accepted task has a card before any page exists');
assert(texts(cards).includes('任务已接收'));
assert.equal(buttons(cards).length, 0);
assert.equal(cards.children[0].children[0].textContent, task.title);

ui.receive('space_a', { tasks: [{ ...task, stage: 'waiting', questions: [{ text: 'Which range?', required: true }] }], pages: [], errors: [] }, taskSocket);
cards.replaceChildren(); ui.cards(session, cards);
assert(texts(cards).includes('需要回答：Which range?'));

const newer = { space: 'space_a', ui: {} };
taskSocket.interaxOwners.set('space_a', newer);
const secondTask = { ...task, sessionId: 'sdk_second', requestId: 'request_two', stage: 'running' };
ui.receive('space_a', { tasks: [{ ...task, stage: 'completed' }, secondTask], pages: [ownedPage], errors: [] }, taskSocket);
assert.equal(session.ui.interaxPages.length, 1, 'Late results keep the original chat owner');
assert.equal(newer.ui.interaxTasks[0].requestId, 'request_two');
assert.equal(newer.ui.interaxPages.length, 0);
cards.replaceChildren(); ui.cards(session, cards);
assert.equal(buttons(cards).length, 1);
assert.equal(buttons(cards)[0].disabled, false);

ui.receive('space_a', { tasks: [{ ...task, stage: 'failed' }], pages: [ownedPage], errors: [{ sessionId: task.sessionId }] }, taskSocket);
cards.replaceChildren(); ui.cards(session, cards);
assert(texts(cards).includes('生成失败'));
assert(texts(cards).includes('状态查询失败'));
assert.equal(buttons(cards).length, 1, 'Read failures retain the existing page entry');
ui.disconnect(taskSocket);
cards.replaceChildren(); ui.cards(session, cards);
assert(texts(cards).includes('状态更新已停止'));
assert.equal(buttons(cards)[0].disabled, true);

// Syntax-check the actual inline scripts, including their WebSocket dispatch.
const html = readFileSync(new URL('../studio/web/voicemem.html', import.meta.url), 'utf8');
for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script);
assert(html.includes("handleInterax(msg,connectedSocket)"));
assert(html.includes('interaxPagesUI?.cards(s,box)'));
console.log('Interax page UI readiness, interaction, revision, stale selection and syntax checks passed');
