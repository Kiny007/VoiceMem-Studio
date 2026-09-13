'use strict';
const { app, BrowserWindow, ipcMain, Menu, dialog, session, systemPreferences, nativeTheme } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const runtime = require('./runtime.cjs');
const { createPet } = require('./pet-window.cjs');

app.setName('VoiceMem Studio');
if (process.env.VOICEMEM_DESKTOP_USER_DATA) app.setPath('userData', path.resolve(process.env.VOICEMEM_DESKTOP_USER_DATA));
const configurationFile = path.join(app.getPath('userData'), 'connection.json');
const launcherUrl = pathToFileURL(path.join(__dirname, 'launcher.html')).href;
const icon = path.join(__dirname, 'assets/icon.png');
let launcher, studio, current = { ...runtime.DEFAULTS }, attempt, generation = 0, activeOrigin = '';
let status = { kind: 'idle', message: '连接已运行的服务，或启动本机 Docker。' };
let writes = Promise.resolve();
let quitting = false;
let pet, petEnabled = true;
const microphoneGrants = new Set();

async function showPet() {
  if (!pet || !petEnabled || !studio || studio.isDestroyed()) return;
  try { await pet.open(activeOrigin); }
  catch (error) {
    dialog.showErrorBox('桌宠加载失败', `Studio 仍可正常使用。请检查 App 的桌宠资源是否完整。\n${error.message}`);
  }
}

function publish(kind, message) {
  status = { kind, message, serverUrl: current.serverUrl };
  if (launcher && !launcher.isDestroyed()) launcher.webContents.send('studio-desktop:status', status);
}

function cancelConnection() {
  generation += 1;
  attempt?.abort();
  attempt = undefined;
}

function assertLauncher(event) {
  if (!launcher || launcher.isDestroyed() || event.sender !== launcher.webContents
      || event.senderFrame !== launcher.webContents.mainFrame || event.senderFrame.url !== launcherUrl) {
    throw new Error('该操作只允许从本地配置设置页发起。');
  }
}

function lockNavigation(window, allowed) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!allowed(url)) event.preventDefault(); });
  window.webContents.on('will-redirect', (event, url) => { if (!allowed(url)) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
}

async function showLauncher() {
  if (launcher && !launcher.isDestroyed()) { launcher.show(); launcher.focus(); return launcher; }
  const window = new BrowserWindow({
    width: 1020, height: 730, minWidth: 800, minHeight: 620, title: 'VoiceMem Studio · 配置设置',
    backgroundColor: '#212121', icon, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  launcher = window;
  lockNavigation(window, url => url === launcherUrl);
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.on('closed', () => { if (launcher === window) launcher = undefined; cancelConnection(); });
  await window.loadURL(launcherUrl);
  if (!window.isDestroyed()) window.show();
  return window;
}

function installPermissions(studioSession) {
  function authorized(contents, permission, details, requestingUrl) {
    return studio && !studio.isDestroyed() && contents === studio.webContents
      && runtime.audioPermission(permission, details, activeOrigin, requestingUrl)
      && runtime.sameOrigin(contents.getURL(), activeOrigin);
  }
  studioSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    !!authorized(contents, permission, details, requestingOrigin) && microphoneGrants.has(activeOrigin));
  studioSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (!authorized(contents, permission, details, details.requestingUrl)) return callback(false);
    const origin = activeOrigin;
    const window = studio;
    if (microphoneGrants.has(origin)) return callback(true);
    void (async () => {
      const response = await dialog.showMessageBox(window, {
        type: 'question', title: '麦克风权限', message: '允许 VoiceMem Studio 使用麦克风？',
        detail: `语音会发送到你配置的服务：${origin}。只允许音频，不授权摄像头或屏幕录制。`,
        buttons: ['允许', '取消'], defaultId: 1, cancelId: 1,
      });
      let granted = response.response === 0;
      if (granted && process.platform === 'darwin') granted = await systemPreferences.askForMediaAccess('microphone');
      granted = granted && origin === activeOrigin && authorized(contents, permission, details, details.requestingUrl);
      if (granted) microphoneGrants.add(origin);
      callback(!!granted);
    })().catch(() => callback(false));
  });
}

async function openStudio(url, ownGeneration) {
  if (ownGeneration !== generation) return;
  const previous = studio;
  const studioSession = session.fromPartition(`persist:studio-${new URL(url).host}`);
  installPermissions(studioSession);
  const window = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1080, minHeight: 680, title: 'VoiceMem Studio',
    backgroundColor: '#212121', icon, show: false,
    webPreferences: { session: studioSession, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  let opened = false;
  studio = window;
  activeOrigin = url;
  pet?.close();
  previous?.destroy();
  lockNavigation(window, destination => runtime.sameOrigin(destination, url));
  window.webContents.on('page-title-updated', event => event.preventDefault());
  window.webContents.on('render-process-gone', () => {
    if (studio === window && !quitting) {
      publish('error', '界面进程已退出，请重新连接。');
      void showLauncher();
    }
  });
  window.on('closed', () => {
    if (studio !== window) return;
    studio = undefined;
    pet?.close();
    if (opened && launcher && !launcher.isDestroyed()) launcher.destroy();
  });
  try {
    await window.loadURL(`${url}/`);
    if (ownGeneration !== generation || window.isDestroyed()) { if (!window.isDestroyed()) window.destroy(); return; }
    opened = true;
    window.show();
    publish('connected', '已连接。');
    if (launcher && !launcher.isDestroyed()) launcher.hide();
    void showPet();
  } catch (error) {
    if (!window.isDestroyed()) window.destroy();
    throw new Error(`无法加载 Studio 页面：${error.message}`);
  }
}

async function connect(value, persist = true) {
  const next = runtime.settings(value);
  cancelConnection();
  const ownGeneration = generation;
  const control = new AbortController();
  attempt = control;
  current = next;
  try {
    if (persist) {
      writes = writes.catch(() => {}).then(() => runtime.saveSettings(configurationFile, next));
      await writes;
    }
    control.signal.throwIfAborted();
    let url = next.serverUrl;
    if (next.autoStartDocker) {
      publish('connecting', '正在启动本机 Docker 中的 studio 服务…');
      url = await runtime.startDocker(next.projectDir, { signal: control.signal });
      control.signal.throwIfAborted();
      current = { ...next, serverUrl: url };
      const discovered = current;
      writes = writes.catch(() => {}).then(() => runtime.saveSettings(configurationFile, discovered));
      await writes;
      control.signal.throwIfAborted();
    }
    publish('connecting', '正在连接 Studio…');
    await runtime.waitForStudio(url, {
      signal: control.signal,
      onWait: seconds => publish('connecting', `等待服务就绪 · ${seconds} 秒。首次模型预热可能需要几分钟。`),
    });
    control.signal.throwIfAborted();
    await openStudio(url, ownGeneration);
  } catch (error) {
    if (ownGeneration !== generation || control.signal.aborted) return;
    publish('error', error.message || '连接失败，请检查服务地址。');
  } finally {
    if (ownGeneration === generation) attempt = undefined;
  }
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'Studio', submenu: [
      { label: '配置设置', accelerator: 'CmdOrCtrl+,', click: () => { void showLauncher(); } },
      { label: '重新连接', click: () => { void showLauncher().then(() => connect(current)); } },
      { id: 'show-pet', label: '显示桌宠', type: 'checkbox', checked: petEnabled, click: item => {
        petEnabled = item.checked;
        if (petEnabled) void showPet(); else pet?.close();
      } },
      { label: '找回桌宠位置', click: () => pet?.resetPosition() },
      { type: 'separator' }, { role: 'quit', label: '退出' },
    ] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
  ]));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { const window = studio || launcher; if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('before-quit', () => { quitting = true; cancelConnection(); pet?.close(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => {
    if (studio && !studio.isDestroyed()) studio.show();
    else void showLauncher();
  });
  app.whenReady().then(async () => {
    nativeTheme.themeSource = 'dark';
    let configError;
    try { current = await runtime.loadSettings(configurationFile); } catch (error) { configError = error.message; }
    installMenu();
    try {
      pet = createPet({ onHidden: () => {
        petEnabled = false;
        Menu.getApplicationMenu().getMenuItemById('show-pet').checked = false;
      } });
      await pet.restorePosition();
    } catch (error) {
      petEnabled = false;
      Menu.getApplicationMenu().getMenuItemById('show-pet').checked = false;
      dialog.showErrorBox('桌宠资源缺失', `Studio 仍可正常使用。源码运行请先执行 npm run prepare:pet；安装包请重新安装。\n${error.message}`);
    }
    ipcMain.handle('studio-desktop:state', event => { assertLauncher(event); return { settings: current, status, platform: process.platform, version: app.getVersion() }; });
    ipcMain.handle('studio-desktop:choose-project', async event => {
      assertLauncher(event);
      const result = await dialog.showOpenDialog(launcher, { title: '选择已配置好的 VoiceMem-Studio 项目', properties: ['openDirectory'] });
      if (result.canceled) return null;
      return runtime.validateProject(result.filePaths[0]);
    });
    ipcMain.handle('studio-desktop:connect', async (event, value) => {
      assertLauncher(event);
      const next = runtime.settings(value);
      if (next.autoStartDocker && (!current.autoStartDocker || next.projectDir !== current.projectDir)) {
        const answer = await dialog.showMessageBox(launcher, {
          type: 'question', title: '启用本机 Docker 自动启动', message: '允许 App 按所选项目的 Compose 配置启动服务？',
          detail: '只选择你信任的项目。不会构建镜像、删除数据或停止现有服务；退出 App 后容器继续运行。',
          buttons: ['允许', '取消'], defaultId: 1, cancelId: 1,
        });
        if (answer.response !== 0) return false;
      }
      void connect(next);
      return true;
    });
    ipcMain.handle('studio-desktop:cancel', event => { assertLauncher(event); cancelConnection(); publish('idle', '已取消等待；已经启动的 Docker 服务不会被停止。'); });
    await showLauncher();
    if (configError) publish('error', configError);
    else void connect(current, false);
  }).catch(error => { dialog.showErrorBox('VoiceMem Studio 启动失败', error.message); app.quit(); });
}
