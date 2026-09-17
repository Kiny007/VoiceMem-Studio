/* ============================================================
   Prism — React Bits component (JS + CSS variant), ported to
   dependency-free WebGL. Same GLSL as reactbits.dev/backgrounds/prism,
   ogl removed. Rendered as the page background only.
   Props: animationType "rotate", timeScale .5, height 3.5,
          baseWidth 5.5, scale 3.6, hueShift 0, colorFrequency 1,
          noise .5, glow 1
   ============================================================ */
(function initPrism() {
  const P = {
    height: 3.5, baseWidth: 5.5, animationType: 'rotate', glow: 1,
    offset: { x: 0, y: 0 }, noise: 0.0, transparent: true, scale: 3.6,
    hueShift: 0, colorFrequency: 1, bloom: 1, timeScale: 0.5
  };

  const container = document.getElementById('prism-layer');
  const canvas = document.createElement('canvas');
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block' });
  container.appendChild(canvas);

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let quality = 1;
  const gl = canvas.getContext('webgl', { alpha: P.transparent, antialias: false, premultipliedAlpha: false });
  if (!gl) {
    container.style.background = 'radial-gradient(55% 45% at 50% 55%, rgba(120,80,255,.5), rgba(20,10,40,.2) 60%, transparent)';
    return;
  }
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.BLEND);

  const H = Math.max(0.001, P.height);
  const BASE_HALF = Math.max(0.001, P.baseWidth) * 0.5;
  const SAT = P.transparent ? 1.5 : 1;
  const SCALE = Math.max(0.001, P.scale);
  const TS = Math.max(0, P.timeScale || 1);

  const vertex = `
attribute vec2 position;
void main(){ gl_Position = vec4(position, 0.0, 1.0); }
`;

  const fragment = `
precision highp float;

uniform vec2  iResolution;
uniform float iTime;
uniform float uHeight;
uniform float uBaseHalf;
uniform mat3  uRot;
uniform int   uUseBaseWobble;
uniform float uGlow;
uniform vec2  uOffsetPx;
uniform float uNoise;
uniform float uSaturation;
uniform float uScale;
uniform float uHueShift;
uniform float uColorFreq;
uniform float uBloom;
uniform float uCenterShift;
uniform float uInvBaseHalf;
uniform float uInvHeight;
uniform float uMinAxis;
uniform float uPxScale;
uniform float uTimeScale;

vec4 tanh4(vec4 x){
  vec4 e2x = exp(2.0*x);
  return (e2x - 1.0) / (e2x + 1.0);
}
float rand(vec2 co){
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453123);
}
float sdOctaAnisoInv(vec3 p){
  vec3 q = vec3(abs(p.x) * uInvBaseHalf, abs(p.y) * uInvHeight, abs(p.z) * uInvBaseHalf);
  float m = q.x + q.y + q.z - 1.0;
  return m * uMinAxis * 0.5773502691896258;
}
float sdPyramidUpInv(vec3 p){
  float oct = sdOctaAnisoInv(p);
  float halfSpace = -p.y;
  return max(oct, halfSpace);
}
mat3 hueRotation(float a){
  float c = cos(a), s = sin(a);
  mat3 W = mat3(0.299,0.587,0.114, 0.299,0.587,0.114, 0.299,0.587,0.114);
  mat3 U = mat3(0.701,-0.587,-0.114, -0.299,0.413,-0.114, -0.300,-0.588,0.886);
  mat3 V = mat3(0.168,-0.331,0.500, 0.328,0.035,-0.500, -0.497,0.296,0.201);
  return W + U * c + V * s;
}

void main(){
  vec2 f = (gl_FragCoord.xy - 0.5 * iResolution.xy - uOffsetPx) * uPxScale;

  float z = 5.0;
  float d = 0.0;
  vec3 p;
  vec4 o = vec4(0.0);

  float centerShift = uCenterShift;
  float cf = uColorFreq;

  mat2 wob = mat2(1.0, 0.0, 0.0, 1.0);
  if (uUseBaseWobble == 1) {
    float t = iTime * uTimeScale;
    float c0 = cos(t + 0.0);
    float c1 = cos(t + 33.0);
    float c2 = cos(t + 11.0);
    wob = mat2(c0, c1, c2, c0);
  }

  const int STEPS = 64;
  for (int i = 0; i < STEPS; i++) {
    p = vec3(f, z);
    p.xz = p.xz * wob;
    p = uRot * p;
    vec3 q = p;
    q.y += centerShift;
    d = 0.1 + 0.2 * abs(sdPyramidUpInv(q));
    z -= d;
    o += (sin((p.y + z) * cf + vec4(0.0, 1.0, 2.0, 3.0)) + 1.0) / d;
  }

  o = tanh4(o * o * (uGlow * uBloom) / 1e5);

  vec3 col = o.rgb;
  if (uNoise > 0.0001) {
    float n = rand(gl_FragCoord.xy + vec2(iTime));
    col += (n - 0.5) * uNoise;
  }
  // 8x8 ordered-ish dither: breaks 8-bit banding without visible grain
  float band = fract(dot(gl_FragCoord.xy, vec2(0.0625, 0.03125))) - 0.5;
  col += band * 0.0035;
  col = clamp(col, 0.0, 1.0);

  float L = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = clamp(mix(vec3(L), col, uSaturation), 0.0, 1.0);

  if (abs(uHueShift) > 0.0001) {
    col = clamp(hueRotation(uHueShift) * col, 0.0, 1.0);
  }

  gl_FragColor = vec4(col, o.a);
}
`;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
    return s;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vertex));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) console.error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const posLoc = gl.getAttribLocation(prog, 'position');
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  const U = n => gl.getUniformLocation(prog, n);
  gl.uniform1f(U('uHeight'), H);
  gl.uniform1f(U('uBaseHalf'), BASE_HALF);
  gl.uniform1i(U('uUseBaseWobble'), P.animationType === 'rotate' ? 1 : 0);
  gl.uniformMatrix3fv(U('uRot'), false, new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]));
  gl.uniform1f(U('uGlow'), Math.max(0, P.glow));
  gl.uniform2f(U('uOffsetPx'), (P.offset.x || 0) * dpr, (P.offset.y || 0) * dpr);
  gl.uniform1f(U('uNoise'), Math.max(0, P.noise));
  gl.uniform1f(U('uSaturation'), SAT);
  gl.uniform1f(U('uScale'), SCALE);
  gl.uniform1f(U('uHueShift'), P.hueShift || 0);
  gl.uniform1f(U('uColorFreq'), Math.max(0, P.colorFrequency || 1));
  gl.uniform1f(U('uBloom'), Math.max(0, P.bloom || 1));
  gl.uniform1f(U('uCenterShift'), H * 0.25);
  gl.uniform1f(U('uInvBaseHalf'), 1 / BASE_HALF);
  gl.uniform1f(U('uInvHeight'), 1 / H);
  gl.uniform1f(U('uMinAxis'), Math.min(BASE_HALF, H));
  gl.uniform1f(U('uTimeScale'), TS);
  const uTime = U('iTime'), uRes = U('iResolution'), uPxScale = U('uPxScale');

  function resize() {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.width = Math.floor(w * dpr * quality);
    canvas.height = Math.floor(h * dpr * quality);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uPxScale, 1 / ((canvas.height || 1) * 0.1 * SCALE));
  }
  new ResizeObserver(resize).observe(container);
  resize();

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const t0 = performance.now();
  let last = t0, slow = 0, clock = 0, raf = 0;

  function render(t) {
    raf=0;
    if(document.hidden){last=t;return;}
    if (!reduce) raf=requestAnimationFrame(render);

    // frame-rate independent clock: long frames no longer jump the animation
    const dt = Math.min((t - last) * 0.001, 0.05);
    last = t;
    clock += dt;
    gl.uniform1f(uTime, reduce ? 3.0 : clock);

    // if frames keep costing more than ~22ms, drop internal resolution once
    if (quality > 0.7 && dt > 0.022) { if (++slow > 45) { quality = 0.7; resize(); } }
    else if (dt < 0.02) slow = Math.max(0, slow - 1);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  raf=requestAnimationFrame(render);
  document.addEventListener('visibilitychange',()=>{cancelAnimationFrame(raf);raf=0;if(!document.hidden){last=performance.now();raf=requestAnimationFrame(render);}});
  window.addEventListener('pageshow',()=>{cancelAnimationFrame(raf);last=performance.now();raf=requestAnimationFrame(render);});
  window.addEventListener('pagehide',()=>cancelAnimationFrame(raf));
})();
