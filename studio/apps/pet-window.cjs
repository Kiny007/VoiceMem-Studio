'use strict';
const { app, BrowserWindow, ipcMain, screen, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { observerUrl, resourceAllowed, trustedSender } = require('./pet-policy.cjs');

/** Own one optional pet window; observation never opens a conversation or captures audio. */
function createPet({ onHidden = () => {} } = {}) {
  const root = path.join(__dirname, '.pet-runtime');
  const { SIZES, selectPose, fitBounds } = require(path.join(root, 'state.cjs'));
  const positionFile = path.join(app.getPath('userData'), 'pet-position.json');
  const petSession = session.fromPartition('studio-pet');
  let window, anchor, dragging, timer, page = '', observer = '', mode = 'lie';
  let writes = Promise.resolve();
  petSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  petSession.setPermissionCheckHandler(() => false);
  petSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !resourceAllowed(details.url, root, observer) }));

  function home() {
    const area = screen.getPrimaryDisplay().workArea;
    return { x: area.x + area.width - 24, y: area.y + area.height - 24 };
  }
  function save() {
    clearTimeout(timer);
    timer = undefined;
    if (!anchor) return;
    const value = JSON.stringify(anchor);
    writes = writes.catch(() => {}).then(() => fs.writeFile(positionFile, value, { mode: 0o600 }))
      .catch(error => console.error('[desktop-pet] Cannot save position:', error.message));
  }
  function setMode(next) {
    if (!window || window.isDestroyed() || !Object.hasOwn(SIZES, next)) return;
    mode = next;
    window.setIgnoreMouseEvents(false);
    window.setBounds(fitBounds(anchor, SIZES[mode], screen.getDisplayNearestPoint(anchor).workArea));
    window.webContents.send('studio-pet:mode', mode);
  }
  function close() {
    observer = '';
    page = '';
    dragging = undefined;
    if (timer) save();
    const previous = window;
    window = undefined;
    previous?.destroy();
  }
  function listen(name, handler) {
    ipcMain.on(`studio-pet:${name}`, (event, value) => {
      if (trustedSender(event, window, page)) handler(value);
    });
  }
  ipcMain.handle('studio-pet:initial', event => {
    if (!trustedSender(event, window, page)) throw new Error('Pet IPC is restricted to the local pet window.');
    return mode;
  });
  listen('toggle', () => setMode(mode === 'dot' ? selectPose() : 'dot'));
  listen('collapse', () => setMode('dot'));
  listen('activate', pose => { if (['sit', 'lie'].includes(pose) && mode !== pose) setMode(pose); else if (mode === 'dot') setMode('lie'); });
  listen('pointer', hit => { if (!dragging && typeof hit === 'boolean') window.setIgnoreMouseEvents(!hit, { forward: true }); });
  listen('drag-start', () => { dragging = { cursor: screen.getCursorScreenPoint(), bounds: window.getBounds() }; });
  listen('drag-move', () => {
    if (!dragging) return;
    const point = screen.getCursorScreenPoint(), bounds = dragging.bounds;
    const target = { x: bounds.x + bounds.width + point.x - dragging.cursor.x, y: bounds.y + bounds.height + point.y - dragging.cursor.y };
    const fitted = fitBounds(target, [bounds.width, bounds.height], screen.getDisplayNearestPoint(point).workArea);
    window.setBounds(fitted);
    anchor = { x: fitted.x + fitted.width, y: fitted.y + fitted.height };
  });
  listen('drag-end', () => { dragging = undefined; clearTimeout(timer); timer = setTimeout(save, 250); });
  screen.on('display-removed', () => setMode(mode));

  async function open(origin) {
    const next = observerUrl(origin);
    if (window && !window.isDestroyed() && observer === next) { window.showInactive(); return; }
    close();
    anchor ||= home();
    observer = next;
    mode = 'lie';
    const url = pathToFileURL(path.join(root, 'index.html'));
    url.searchParams.set('ws', observer);
    page = url.href;
    const created = new BrowserWindow({
      ...fitBounds(anchor, SIZES[mode], screen.getDisplayNearestPoint(anchor).workArea),
      title: '雾铃 · VoiceMem Studio', frame: false, transparent: true, alwaysOnTop: true,
      skipTaskbar: true, resizable: false, maximizable: false, fullscreenable: false, show: false, hasShadow: false,
      webPreferences: { preload: path.join(__dirname, 'pet-preload.cjs'), session: petSession,
        contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    window = created;
    created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const name of ['will-navigate', 'will-redirect', 'will-attach-webview']) created.webContents.on(name, event => event.preventDefault());
    created.on('closed', () => { if (window === created) { window = undefined; observer = ''; onHidden(); } });
    try {
      await created.loadURL(page);
      if (window === created && !created.isDestroyed()) created.showInactive();
    } catch (error) {
      if (created.isDestroyed()) return;
      if (window === created) close();
      throw error;
    }
  }
  async function restorePosition() {
    try {
      const saved = JSON.parse(await fs.readFile(positionFile, 'utf8'));
      if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) anchor = { x: saved.x, y: saved.y };
    } catch (error) { if (error.code !== 'ENOENT') console.error('[desktop-pet] Ignoring invalid saved position.'); }
  }
  return { open, close, restorePosition, resetPosition: () => { anchor = home(); setMode(mode); save(); } };
}

module.exports = { createPet };
