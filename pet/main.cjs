const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { SIZES, RESIZE_CORNERS, clampScale, scaledSize, resizeFromCorner, selectPose, fitBounds } = require('./state.cjs');
let win, tray, mode = 'lie', anchor, dragging, resizing, saveTimer, scale = 1, manuallyCollapsed = false;
const smoke = process.argv.includes('--smoke-test');
// --ws=... 由 VoiceMem 后端拉起时传进来，原样转交给渲染进程里的 voicemem-link.js。
// 不传就是原来那只独立桌宠，不会去连任何东西。
const argOf = name => {
  const prefix = `--${name}=`;
  const hit = process.argv.find(a => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
};
const link = argOf('ws');
// 跟着 VoiceMem 一起启动时直接以角色形态出现：这种时候小人是被别人叫出来的，
// 再缩成一个小点等人点，等于白启动了。
const expanded = process.argv.includes('--expanded');
const settingsFile = () => path.join(app.getPath('userData'), 'position.json');
function flushSave() { clearTimeout(saveTimer); saveTimer = undefined; try { fs.writeFileSync(settingsFile(), JSON.stringify({ ...anchor, scale })); } catch {} }
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 250); }
function layout() {
  const area = screen.getDisplayNearestPoint(anchor).workArea;
  const bounds = fitBounds(anchor, scaledSize(mode, scale), area);
  win.setIgnoreMouseEvents(false);
  win.setBounds(bounds);
  anchor = { x: bounds.x + bounds.width, y: bounds.y + bounds.height };
}
function setMode(next) {
  if (!Object.hasOwn(SIZES, next) || mode === next) return;
  mode = next;
  if (mode === 'dot') { if (dragging || resizing) save(); dragging = resizing = undefined; }
  layout();
  win.webContents.send('mode', mode);
}
function setScale(next) { scale = clampScale(next); layout(); win.webContents.send('scale', scale); save(); }
function resize(step) { if (step === -1 || step === 1) setScale(Math.round((scale + step * .1) * 100) / 100); }
function collapse() { manuallyCollapsed = true; setMode('dot'); }
function toggle() { if (mode === 'dot') { manuallyCollapsed = false; setMode(selectPose()); } else collapse(); }
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
  app.whenReady().then(async () => {
    const area = screen.getPrimaryDisplay().workArea;
    anchor = { x: area.x + area.width - 24, y: area.y + area.height - 24 };
    if (!smoke) { try { const p = JSON.parse(fs.readFileSync(settingsFile())); if (Number.isFinite(p.x) && Number.isFinite(p.y)) anchor = { x: p.x, y: p.y }; scale = clampScale(p.scale); } catch {} }
    win = new BrowserWindow({ ...fitBounds(anchor, scaledSize(mode, scale), screen.getDisplayNearestPoint(anchor).workArea),
      frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false,
      maximizable: false, fullscreenable: false, show: false, hasShadow: false,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen:smoke, backgroundThrottling:!smoke } });
    if(smoke) win.webContents.on('console-message',event=>console.log('RENDER:',event.message));
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', e => e.preventDefault());
    ipcMain.handle('initial-mode', () => mode);
    ipcMain.handle('initial-scale', () => scale);
    ipcMain.on('toggle', toggle);
    ipcMain.on('activate', (_event, pose) => {
      if (manuallyCollapsed) return;
      if(['sit','lie'].includes(pose)&&mode!==pose)setMode(pose);
      else if(pose===undefined&&mode==='dot')setMode('lie');
    });
    ipcMain.on('collapse', collapse);
    ipcMain.on('resize', (_event, step) => resize(step));
    ipcMain.on('reset-size', () => setScale(1));
    ipcMain.on('pointer', (_e, hit) => { if (!dragging && !resizing && typeof hit === 'boolean') win.setIgnoreMouseEvents(!hit, { forward: true }); });
    ipcMain.on('drag-start', () => { resizing = undefined; dragging = { cursor: screen.getCursorScreenPoint(), bounds: win.getBounds() }; win.setIgnoreMouseEvents(false); });
    ipcMain.on('drag-move', () => {
      if (!dragging) return;
      const p = screen.getCursorScreenPoint(), b = dragging.bounds;
      const target = { x: b.x + b.width + p.x - dragging.cursor.x, y: b.y + b.height + p.y - dragging.cursor.y };
      const bounds = fitBounds(target, [b.width, b.height], screen.getDisplayNearestPoint(p).workArea);
      win.setBounds(bounds); anchor = { x: bounds.x + bounds.width, y: bounds.y + bounds.height };
    });
    ipcMain.on('drag-end', () => { if (dragging) { dragging = undefined; save(); } });
    ipcMain.on('resize-start', (_event, corner = 'se') => {
      if (mode === 'dot' || !Object.hasOwn(RESIZE_CORNERS, corner)) return;
      dragging = undefined;
      resizing = { cursor: screen.getCursorScreenPoint(), bounds: win.getBounds(), scale, corner };
      win.setIgnoreMouseEvents(false);
    });
    ipcMain.on('resize-move', () => {
      if (!resizing) return;
      const point = screen.getCursorScreenPoint(), start = resizing;
      const result = resizeFromCorner(mode, start, point.x - start.cursor.x, point.y - start.cursor.y, screen.getDisplayNearestPoint(point).workArea);
      const bounds = result.bounds;
      scale = result.scale;
      win.setBounds(bounds); anchor = { x: bounds.x + bounds.width, y: bounds.y + bounds.height };
      win.webContents.send('scale', scale);
    });
    ipcMain.on('resize-end', () => { if (resizing) { resizing = undefined; save(); } });
    win.on('close', () => { if (saveTimer || dragging || resizing) flushSave(); });
    const pixels = Buffer.alloc(16 * 16 * 4);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const i = (y * 16 + x) * 4; pixels[i] = 232; pixels[i+1] = 173; pixels[i+2] = 168; pixels[i+3] = Math.hypot(x-7.5,y-7.5) < 6 ? 255 : 0; }
    tray = new Tray(nativeImage.createFromBitmap(pixels, { width: 16, height: 16 }));
    tray.setToolTip('VoiceMem 雾铃');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: '展开 / 收起', click: toggle },
      { label: '缩小', click: () => resize(-1) }, { label: '放大', click: () => resize(1) }, { label: '恢复原始大小', click: () => setScale(1) },
      { label: '找回小点', click: () => { anchor = { x: area.x+area.width-24,y:area.y+area.height-24 }; collapse(); layout(); win.show(); save(); } },
      { type: 'separator' }, { label: '退出', click: () => app.quit() }]));
    tray.on('click', toggle);
    screen.on('display-removed', () => { layout(); save(); });
    const query = new URLSearchParams();
    if (link) query.set('ws', link);
    if (argOf('idle')) query.set('idle', argOf('idle'));   // --idle=4 放大待机幅度
    const search = query.toString();
    await win.loadFile('index.html', search ? { search } : undefined);
    // --devtools：调幅度的时候要能敲 petRig.tune()，无边框窗口没有菜单可以开。
    if (process.argv.includes('--devtools')) win.webContents.openDevTools({ mode: 'detach' });
    if (smoke) {
      try {
        const results = [];
        const checksDir = path.join(app.isPackaged ? app.getPath('userData') : __dirname, 'checks');
        fs.mkdirSync(checksDir, { recursive: true });
        for (const pose of ['dot','sit','lie','dot']) {
          setMode(pose);
          await new Promise(r => setTimeout(r, 200));
          const result = await win.webContents.executeJavaScript(`({mode:document.body.dataset.mode, imageReady:document.querySelector('#live').width > 0, nodeExposed:typeof process !== 'undefined'})`);
          if (result.mode !== pose || (pose !== 'dot' && !result.imageReady) || result.nodeExposed) throw new Error(JSON.stringify(result));
          if(pose!=='dot') {
            let status;
            for(let i=0;i<150;i++) {
              status=await win.webContents.executeJavaScript('window.petRig.status()');
              if((status.ready&&status.pose===pose)||status.error)break;
              await new Promise(r=>setTimeout(r,100));
            }
            if(!status.ready||status.pose!==pose)throw new Error('Avatar load failed: '+JSON.stringify(status));
            const diagnostics=await win.webContents.executeJavaScript(`(()=>{
              const common={ParamAngleX:0,ParamAngleY:0,ParamAngleZ:2,ParamBreath:.5,ParamEyeLOpen:1,ParamEyeROpen:1};
              const closed=petRig.inspectPose({...common,ParamMouthOpenY:0});
              const open=petRig.inspectPose({...common,ParamMouthOpenY:1});
              const equal=(a,b)=>a.length===b.length&&a.every((v,i)=>Math.abs(v-b[i])<1e-7);
              return {ready:true,pose:petRig.status().pose,mouthVertices:open.ArtMeshMouthOpen.length,bodyVertices:open.ArtMeshTopwear.length,mouthChanges:!equal(closed.ArtMeshMouthOpen,open.ArtMeshMouthOpen),headUnaffected:equal(closed.ArtMeshFace,open.ArtMeshFace),bodyUnaffected:equal(closed.ArtMeshTopwear,open.ArtMeshTopwear)};
            })()`);
            if(!diagnostics.mouthVertices||!diagnostics.bodyVertices||!diagnostics.mouthChanges||!diagnostics.headUnaffected||!diagnostics.bodyUnaffected)throw new Error(JSON.stringify(diagnostics));
            results.push(diagnostics);
            for(const [name,params] of Object.entries({neutral:{ParamAngleZ:0,ParamEyeLOpen:1,ParamEyeROpen:1,ParamMouthOpenY:0},talking:{ParamAngleZ:2,ParamEyeLOpen:1,ParamEyeROpen:1,ParamMouthOpenY:.8},blink:{ParamAngleZ:-2,ParamEyeLOpen:0,ParamEyeROpen:0,ParamMouthOpenY:0}})){
              await win.webContents.executeJavaScript('petRig.inspectPose('+JSON.stringify(params)+')');
              await new Promise(r=>setTimeout(r,100));
              fs.writeFileSync(path.join(checksDir,pose+'-'+name+'.png'),(await win.webContents.capturePage()).toPNG());
            }
            await win.webContents.executeJavaScript(`petRig.show('${pose}').then(()=>{petRig.talk(3);petRig.tilt()})`);
            await new Promise(r=>setTimeout(r,150));
            const before=await win.webContents.executeJavaScript('petRig.status().parameters');
            await new Promise(r=>setTimeout(r,250));
            const after=await win.webContents.executeJavaScript('petRig.status().parameters');
            const mouthRunning=Math.abs(before.ParamMouthOpenY-after.ParamMouthOpenY)>1e-5;
            const headRunning=pose==='lie'||Math.abs(before.ParamAngleZ-after.ParamAngleZ)>1e-5;
            if(!mouthRunning||!headRunning)throw new Error('Concurrent animation stalled: '+pose);
            const hitCheck=await win.webContents.executeJavaScript(`(()=>{const r=document.querySelector('#live').getBoundingClientRect();return {outside:petRig.hitTest(r.left+1,r.top+1),inside:petRig.hitTest(r.left+r.width*.5,r.top+r.height*.6)}})()`);
            if(hitCheck.outside||!hitCheck.inside)throw new Error('Alpha hit test failed: '+JSON.stringify(hitCheck));
            results.push({pose,concurrentAnimation:true,alphaHitTest:true});
            if(pose==='sit'){
              await win.webContents.executeJavaScript(`petRig.show('sit').then(()=>petRig.tilt())`);
              await new Promise(r=>setTimeout(r,1700));
              const held=await win.webContents.executeJavaScript(`(()=>{const s=petRig.status();return {action:s.action,eyes:s.parameters.ParamEyeLOpen,smile:s.parameters.ParamMouthForm,retrigger:petRig.tilt()}})()`);
              if(held.action!=='tilted-smile'||held.eyes>.05||held.smile<.8||held.retrigger)throw new Error('Smile button / hold failed: '+JSON.stringify(held));
              const coexist=await win.webContents.executeJavaScript(`(()=>{
                const b={ParamAngleZ:-10,ParamEyeLOpen:0,ParamEyeROpen:0,ParamMouthForm:1,ParamBreath:.5};
                const closed=petRig.inspectPose({...b,ParamMouthOpenY:0});
                const open=petRig.inspectPose({...b,ParamMouthOpenY:1});
                const equal=(a,b)=>a.length===b.length&&a.every((v,i)=>Math.abs(v-b[i])<1e-7);
                return !equal(closed.ArtMeshMouthOpen,open.ArtMeshMouthOpen)&&equal(closed.ArtMeshFace,open.ArtMeshFace)&&equal(closed.ArtMeshTopwear,open.ArtMeshTopwear);
              })()`);
              if(!coexist)throw new Error('Speech changed smile head/body');
              results.push({tiltedSmileButton:true,heldSmile:true,retriggerGuard:true,smileSpeechIndependent:true});
            }
          }
          results.push(result);
        }
        await win.webContents.executeJavaScript("document.querySelector('#dot').click()");
        await new Promise(r => setTimeout(r, 200));
        if (!['sit','lie'].includes(mode)) throw new Error('Wake click failed');
        await win.webContents.executeJavaScript("window.pet.collapse()");
        await new Promise(r => setTimeout(r, 200));
        if (mode !== 'dot') throw new Error('Collapse click failed');
        results.push({ wakeClick: true, collapseClick: true });
        fs.writeFileSync(path.join(checksDir, 'smoke.json'), JSON.stringify(results,null,2));
        console.log('SMOKE PASS', JSON.stringify(results)); app.exit(0);
      } catch (e) { console.error(e); app.exit(1); }
    } else {
      if (expanded) setMode('lie');
      win.showInactive();
    }
  });
  app.on('window-all-closed', () => app.quit());
}
