'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const state = require('../../../pet/state.cjs');

async function fixture(desktop, saved) {
  const windows = [], timers = new Map(), handles = new Map(), ipcMain = new EventEmitter();
  let stored = saved, cursor = { x: 800, y: 600 }, nextTimer = 0, hidden = 0;
  const area = { x: 0, y: 0, width: 1600, height: 1000 };
  ipcMain.handle = (name, handler) => handles.set(name, handler);
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.bounds = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, options[key]]));
      this.messages = []; this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: '' };
      this.webContents.send = (...args) => this.messages.push(args);
      this.webContents.setWindowOpenHandler = () => {};
      windows.push(this);
    }
    async loadURL(url) { this.webContents.mainFrame.url = url; }
    async loadFile() {}
    getBounds() { return { ...this.bounds }; }
    setBounds(bounds) { this.bounds = { ...bounds }; }
    setIgnoreMouseEvents(ignore) { this.ignoresMouse = ignore; }
    isDestroyed() { return !!this.destroyed; }
    showInactive() {} show() {} focus() {}
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const screen = Object.assign(new EventEmitter(), {
    getPrimaryDisplay: () => ({ workArea: area }), getDisplayNearestPoint: () => ({ workArea: area }),
    getCursorScreenPoint: () => ({ ...cursor }),
  });
  const ready = [];
  const app = Object.assign(new EventEmitter(), { getPath: () => '/fixture/profile', requestSingleInstanceLock: () => true,
    whenReady: () => ({ then: callback => { ready.push(Promise.resolve().then(callback)); } }), quit: () => {},
  });
  const electron = { app, BrowserWindow: Window, ipcMain, screen,
    session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } }) },
    Tray: class { setToolTip() {} setContextMenu() {} on() {} }, Menu: { buildFromTemplate: value => value },
    nativeImage: { createFromBitmap: () => ({}) },
  };
  const read = () => { if (!stored) throw Object.assign(new Error('Missing fixture'), { code: 'ENOENT' }); return JSON.stringify(stored); };
  const write = (_file, value) => { stored = JSON.parse(value); };
  const directory = desktop ? path.resolve(__dirname, '..') : path.resolve(__dirname, '../../../pet');
  const context = { __dirname: directory, module: { exports: {} }, console, URLSearchParams, Buffer, process: { argv: [] },
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
    require: name => {
      if (name === 'electron') return electron;
      if (name === 'node:fs/promises') return { readFile: async () => read(), writeFile: async (...args) => write(...args) };
      if (name === 'node:fs') return { readFileSync: read, writeFileSync: write };
      if (name.endsWith('state.cjs')) return state;
      if (name.startsWith('.')) return require(path.resolve(directory, name));
      return require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(directory, desktop ? 'pet-window.cjs' : 'main.cjs'), 'utf8'), context);
  const controller = desktop ? context.module.exports.createPet({ onHidden: () => hidden++ }) : undefined;
  if (desktop) { await controller.restorePosition(); await controller.open('http://127.0.0.1:8787'); }
  else await Promise.all(ready);
  const prefix = desktop ? 'studio-pet:' : '';
  const window = () => windows.at(-1);
  const event = () => ({ sender: window().webContents, senderFrame: window().webContents.mainFrame });
  return { controller, window, screen, area, windows, hidden: () => hidden, saved: () => stored,
    point: value => { cursor = value; },
    send: (name, value, sender = event()) => ipcMain.emit(prefix + name, sender, value),
    initial: (name, sender = event()) => handles.get(prefix + name)(sender),
    async flush() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } await new Promise(resolve => setImmediate(resolve)); },
  };
}

test('pet scale keeps the dot fixed, clamps input and preserves aspect ratio on a small display', () => {
  assert.deepEqual(state.scaledSize('dot', .4), [52, 52]);
  assert.deepEqual(state.scaledSize('sit', .4), [264, 172]);
  for (const invalid of [undefined, NaN, Infinity, '0.5']) assert.equal(state.clampScale(invalid), 1);
  assert.equal(state.clampScale(-4), .4);
  assert.equal(state.clampScale(4), 1.5);
  assert.equal(state.draggedScale(1, -330, -215), .5);
  assert.equal(state.draggedScale(1, 10, 215), 1.5);
  const bounds = state.fitBounds({ x: 5000, y: -5000 }, [990, 645], { x: -400, y: -300, width: 300, height: 200 });
  assert.deepEqual(bounds, { x: -400, y: -300, width: 300, height: 195 });
});

for (const desktop of [true, false]) {
  const label = desktop ? 'App pet' : 'standalone pet';
  test(`${label}: all four corners grow and shrink while the opposite corner stays fixed`, async () => {
    for (const [corner, sx, sy] of [['nw', -1, -1], ['ne', 1, -1], ['sw', -1, 1], ['se', 1, 1]]) {
      const f = await fixture(desktop, { x: 1000, y: 700 });
      const original = f.window().getBounds();
      const fixed = { x: original.x + (sx < 0 ? original.width : 0), y: original.y + (sy < 0 ? original.height : 0) };
      const cursor = { x: original.x + (sx > 0 ? original.width : 0), y: original.y + (sy > 0 ? original.height : 0) };
      f.point(cursor); f.send('resize-start', corner);
      for (const delta of [-.3, .2]) {
        f.point({ x: cursor.x + sx * 660 * delta, y: cursor.y + sy * 430 * delta }); f.send('resize-move');
        const bounds = f.window().getBounds();
        assert.equal(bounds.width, Math.round(660 * (1 + delta)), corner);
        assert.equal(bounds.height, Math.round(430 * (1 + delta)), corner);
        assert.equal(bounds.x + (sx < 0 ? bounds.width : 0), fixed.x, corner);
        assert.equal(bounds.y + (sy < 0 ? bounds.height : 0), fixed.y, corner);
      }
      f.send('resize-end'); await f.flush();
      assert.equal(f.saved().scale, 1.2);
      assert.equal(f.window().messages.some(([channel]) => channel.endsWith('mode')), false);
    }
  });

  test(`${label}: scale controls survive collapse and restart without restarting pose animations`, async () => {
    const f = await fixture(desktop, { x: 1000, y: 700, scale: .6 });
    assert.equal(f.initial('initial-scale'), .6);
    assert.equal(f.window().bounds.width, 396);
    f.send('resize', 1);
    assert.equal(f.window().bounds.width, 462);
    assert.equal(f.window().messages.filter(([channel]) => channel.endsWith('mode')).length, 0);
    f.send('collapse');
    assert.equal(f.window().bounds.width, 52);
    for (const pose of ['sit', 'lie', undefined]) f.send('activate', pose);
    assert.equal(f.window().bounds.width, 52);
    f.send('toggle');
    assert.equal(f.window().bounds.width, 462);
    f.send('activate', 'sit');
    assert.equal(f.initial(desktop ? 'initial' : 'initial-mode'), 'sit');
    await f.flush();
    assert.equal(f.saved().scale, .7);
    const restored = await fixture(desktop, f.saved());
    assert.equal(restored.window().bounds.width, 462);
    restored.send('reset-size');
    assert.equal(restored.window().bounds.width, 660);
    for (let i = 0; i < 30; i++) restored.send('resize', -1);
    assert.equal(restored.initial('initial-scale'), .4);
    for (let i = 0; i < 30; i++) restored.send('resize', 1);
    assert.equal(restored.initial('initial-scale'), 1.5);
  });

  test(`${label}: move and corner resize preserve anchors, pointer capture and saved geometry`, async () => {
    const f = await fixture(desktop, { x: 1000, y: 700 });
    const before = f.window().getBounds();
    f.point({ x: 500, y: 400 }); f.send('drag-start');
    f.point({ x: 580, y: 450 }); f.send('drag-move'); f.send('drag-end');
    assert.deepEqual(f.window().bounds, { ...before, x: before.x + 80, y: before.y + 50 });
    const moved = f.window().getBounds();
    f.point({ x: moved.x + moved.width, y: moved.y + moved.height }); f.send('resize-start');
    f.send('pointer', false);
    assert.equal(f.window().ignoresMouse, false);
    f.send('activate', 'sit');
    f.point({ x: moved.x + moved.width - 330, y: moved.y + moved.height - 215 }); f.send('resize-move'); f.send('resize-end');
    assert.deepEqual(f.window().bounds, { x: moved.x, y: moved.y, width: 330, height: 215 });
    await f.flush();
    assert.deepEqual(f.saved(), { x: moved.x + 330, y: moved.y + 215, scale: .5 });
    f.send('pointer', false);
    assert.equal(f.window().ignoresMouse, true);
    f.send('collapse'); f.send('resize-start'); f.send('resize-move');
    assert.equal(f.window().bounds.width, 52);
    f.send('toggle');
    assert.equal(f.window().bounds.width, 330);
  });
}

test('App pet rejects untrusted resize IPC and stale gestures after closing or changing service', async () => {
  const f = await fixture(true);
  const before = f.window().getBounds();
  for (const value of [0, 20, '1', NaN, null, {}]) f.send('resize', value);
  for (const corner of ['invalid', null, {}, 42]) {
    f.send('resize-start', corner); f.point({ x: 900, y: 800 }); f.send('resize-move');
  }
  f.send('resize', -1, { sender: {}, senderFrame: {} });
  assert.throws(() => f.initial('initial-scale', { sender: {}, senderFrame: {} }), /restricted/);
  assert.deepEqual(f.window().bounds, before);
  f.send('resize', -1);
  const old = f.window(), stale = { sender: old.webContents, senderFrame: old.webContents.mainFrame };
  f.send('resize-start');
  f.controller.close();
  await f.flush();
  assert.equal(f.saved().scale, .9);
  assert.equal(old.isDestroyed(), true);
  assert.equal(f.hidden(), 0);
  await f.controller.open('http://127.0.0.1:9898');
  assert.equal(f.window().bounds.width, 594);
  f.send('resize', -1, stale); f.send('resize-move');
  assert.equal(f.window().bounds.width, 594);
  f.window().destroy();
  assert.equal(f.hidden(), 1);
});
