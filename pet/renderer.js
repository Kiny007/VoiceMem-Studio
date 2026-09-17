const dot = document.querySelector('#dot'), character = document.querySelector('#character'), live = document.querySelector('#live'), stage = document.querySelector('#stage'), bubble = document.querySelector('#bubble');
// Browser preview uses the same interaction UI without desktop privileges.
const api = window.pet || { initial: async () => 'dot', onMode: () => {}, toggle: () => render(document.body.dataset.mode === 'dot' ? (Math.random()<0.5?'sit':'lie') : 'dot'), collapse: () => render('dot'), pointer: () => {}, dragStart: () => {}, dragMove: () => {}, dragEnd: () => {}, initialScale: async () => 1, onScale: () => {}, resize: () => {}, resetSize: () => {}, resizeStart: () => {}, resizeMove: () => {}, resizeEnd: () => {} };
let renderEpoch=0;
async function render(mode) {
  const epoch=++renderEpoch;
  document.body.dataset.mode = mode; dot.hidden = mode !== 'dot'; character.hidden = mode === 'dot';
  if(mode==='dot')window.avatar.hide();bubble.hidden=true;
  stage.hidden=mode==='dot';
  if(mode!=='dot') {
    try {await window.avatar.show(mode);}
    catch {if(epoch===renderEpoch){bubble.textContent='模型暂时没有加载成功，请重新启动。';bubble.hidden=false;}}
  }
}
api.onMode(render); api.initial().then(render);
let gesture, suppressClick = false;
for (const el of [dot,character]) {
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest?.('#avatar-debug')) return;
    const corner = e.target.closest('[data-resize-corner]')?.dataset.resizeCorner;
    el.setPointerCapture(e.pointerId);
    gesture = { x:e.screenX,y:e.screenY,moved:false,resize:Boolean(corner) };
    if(corner)api.resizeStart(corner);else api.dragStart();
  });
  el.addEventListener('pointermove', e => { if (!gesture) return; if (Math.hypot(e.screenX-gesture.x,e.screenY-gesture.y)>4) gesture.moved=true; if (gesture.moved) { if(gesture.resize)api.resizeMove();else api.dragMove(); } });
  const end = () => { if (!gesture) return; suppressClick=gesture.moved||gesture.resize; if(gesture.resize)api.resizeEnd();else api.dragEnd(); gesture=undefined; };
  el.addEventListener('pointerup',end); el.addEventListener('pointercancel',end); el.addEventListener('lostpointercapture',end);
}
dot.addEventListener('click', () => { if (!suppressClick) api.toggle(); suppressClick=false; });
character.addEventListener('dblclick', () => { if (!suppressClick) api.collapse(); });
document.addEventListener('keydown',e => { if(e.key==='Escape') api.collapse(); });
document.addEventListener('pointermove',e => api.pointer(Boolean(gesture || e.target===dot || character.contains(e.target))));
document.addEventListener('pointerleave',() => { if (!gesture) api.pointer(false); });
