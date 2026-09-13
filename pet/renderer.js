const dot = document.querySelector('#dot'), character = document.querySelector('#character'), live = document.querySelector('#live'), stage = document.querySelector('#stage'), bubble = document.querySelector('#bubble');
// Browser preview uses the same interaction UI without desktop privileges.
const api = window.pet || { initial: async () => 'dot', onMode: () => {}, toggle: () => render(document.body.dataset.mode === 'dot' ? (Math.random()<0.5?'sit':'lie') : 'dot'), collapse: () => render('dot'), pointer: () => {}, dragStart: () => {}, dragMove: () => {}, dragEnd: () => {} };
let renderEpoch=0;
async function render(mode) {
  const epoch=++renderEpoch;
  document.body.dataset.mode = mode; dot.hidden = mode !== 'dot'; character.hidden = mode === 'dot';
  window.petRig.hide();bubble.hidden=true;
  stage.hidden=mode==='dot';
  if(mode!=='dot') {
    try {await window.petRig.show(mode);}
    catch {if(epoch===renderEpoch){bubble.textContent='模型暂时没有加载成功，请重新启动。';bubble.hidden=false;}}
  }
}
api.onMode(render); api.initial().then(render);
let gesture, suppressClick = false;
for (const el of [dot,live]) {
  el.addEventListener('pointerdown', e => { if (e.button !== 0 || (el===live&&!window.petRig.hitTest(e.clientX,e.clientY))) return; el.setPointerCapture(e.pointerId); gesture = { x:e.screenX,y:e.screenY,moved:false }; api.dragStart(); });
  el.addEventListener('pointermove', e => { if (!gesture) return; if (Math.hypot(e.screenX-gesture.x,e.screenY-gesture.y)>4) gesture.moved=true; if (gesture.moved) api.dragMove(); });
  const end = () => { if (!gesture) return; suppressClick=gesture.moved; gesture=undefined; api.dragEnd(); };
  el.addEventListener('pointerup',end); el.addEventListener('pointercancel',end); el.addEventListener('lostpointercapture',end);
}
dot.addEventListener('click', () => { if (!suppressClick) api.toggle(); suppressClick=false; });
live.addEventListener('dblclick', () => { if (!suppressClick) api.collapse(); });
document.addEventListener('keydown',e => { if(e.key==='Escape') api.collapse(); });
document.addEventListener('pointermove',e => api.pointer(Boolean(gesture || e.target===dot || (e.target===live&&window.petRig.hitTest(e.clientX,e.clientY)))));
document.addEventListener('pointerleave',() => { if (!gesture) api.pointer(false); });
