window.petRig = (() => {
  const canvas = document.querySelector('#live');
  const stage = document.querySelector('#stage');
  const context = canvas.getContext('2d', { alpha: true });
  const sources = {
    calm: 'assets/avatar/calm.png',
    talk: 'assets/avatar/talk.png',
    blink: 'assets/avatar/blink.png',
    smile: 'assets/avatar/squint-smile.png'
  };
  const images = {};
  let loading;
  let active = false;
  let pose = 'sit';
  let startedAt = performance.now();
  let talkUntil = 0;
  let action;
  let nextBlink = 2.8;
  let nextTilt = Infinity;
  let frame;
  let lastDraw = 0;
  let failure;
  let inspection;
  let alpha;
  let fit;
  let parameters = {};

  const clamp = value => Math.max(0, Math.min(1, value));
  const smooth = value => {
    const x = clamp(value);
    return x * x * x * (x * (x * 6 - 15) + 10);
  };
  const mix = (a, b, amount) => a + (b - a) * amount;

  function image(path) {
    return new Promise((resolve, reject) => {
      const result = new Image();
      result.onload = () => resolve(result);
      result.onerror = reject;
      result.src = path;
    });
  }

  function removeChecker(source) {
    const result = document.createElement('canvas');
    result.width = source.naturalWidth;
    result.height = source.naturalHeight;
    const ctx = result.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0);
    const pixels = ctx.getImageData(0, 0, result.width, result.height);
    const data = pixels.data;
    const width = result.width, height = result.height, count = width * height;
    const background = new Uint8Array(count);
    const labels = new Int32Array(count);
    const queue = new Int32Array(count);
    let head = 0, tail = 0;
    const candidate = index => {
      const i = index * 4, r = data[i], g = data[i + 1], b = data[i + 2];
      const spread = Math.max(r, g, b) - Math.min(r, g, b);
      const light = (r + g + b) / 3;
      return spread < 10 && light > 55 && light < 243;
    };
    const enqueue = index => {
      if (!background[index] && candidate(index)) {
        background[index] = 1;
        queue[tail++] = index;
      }
    };
    for (let x = 0; x < width; x++) { enqueue(x); enqueue((height - 1) * width + x); }
    for (let y = 0; y < height; y++) { enqueue(y * width); enqueue(y * width + width - 1); }
    while (head < tail) {
      const index = queue[head++], x = index % width;
      if (index >= width) enqueue(index - width);
      if (index < count - width) enqueue(index + width);
      if (x) enqueue(index - 1);
      if (x < width - 1) enqueue(index + 1);
    }
    for (let index = 0; index < count; index++) {
      const i = index * 4, r = data[i], g = data[i + 1], b = data[i + 2];
      const spread = Math.max(r, g, b) - Math.min(r, g, b);
      const light = (r + g + b) / 3;
      if (background[index] || (spread <= 6 && light >= 72 && light <= 235)) data[i + 3] = 0;
    }
    let label = 0, largest = 0, largestSize = 0;
    for (let start = 0; start < count; start++) {
      if (!data[start * 4 + 3] || labels[start]) continue;
      label++;
      head = 0; tail = 0; queue[tail++] = start; labels[start] = label;
      while (head < tail) {
        const index = queue[head++], x = index % width;
        const visit = next => {
          if (data[next * 4 + 3] && !labels[next]) { labels[next] = label; queue[tail++] = next; }
        };
        if (index >= width) visit(index - width);
        if (index < count - width) visit(index + width);
        if (x) visit(index - 1);
        if (x < width - 1) visit(index + 1);
      }
      if (tail > largestSize) { largestSize = tail; largest = label; }
    }
    for (let index = 0; index < count; index++) if (labels[index] !== largest) data[index * 4 + 3] = 0;
    ctx.putImageData(pixels, 0, 0);
    return { canvas: result, pixels: pixels.data };
  }

  function mouthFrame(open) {
    const patch = document.createElement('canvas');
    patch.width = images.calm.width;
    patch.height = images.calm.height;
    const mouth = patch.getContext('2d'), width = patch.width;
    const calm = images.calm.getContext('2d').getImageData(0, 0, width, patch.height).data;
    const talk = images.talk.getContext('2d').getImageData(0, 0, width, patch.height).data;
    const pixels = mouth.createImageData(width, patch.height), data = pixels.data;
    const x0 = Math.floor(width * .462), x1 = Math.ceil(width * .538);
    const y0 = Math.floor(patch.height * .427), y1 = Math.ceil(patch.height * .46);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      const difference = Math.max(Math.abs(talk[i] - calm[i]), Math.abs(talk[i + 1] - calm[i + 1]), Math.abs(talk[i + 2] - calm[i + 2]));
      const alpha = smooth((difference - 6) / 30) * open;
      data[i] = talk[i]; data[i + 1] = talk[i + 1]; data[i + 2] = talk[i + 2]; data[i + 3] = talk[i + 3] * alpha;
    }
    mouth.putImageData(pixels, 0, 0);
    return patch;
  }

  async function load() {
    if (loading) return loading;
    loading = Promise.all(Object.entries(sources).map(async ([name, path]) => {
      images[name] = removeChecker(await image(path)).canvas;
    })).then(() => {
      images.mouths = Array.from({ length: 9 }, (_, index) => mouthFrame(index / 8));
      const ctx = images.calm.getContext('2d', { willReadFrequently: true });
      alpha = ctx.getImageData(0, 0, images.calm.width, images.calm.height).data;
    }).catch(error => {
      failure = String(error);
      console.error('Avatar load failed', error);
      throw error;
    });
    return loading;
  }

  function tiltWeight(seconds) {
    if (seconds < 0 || seconds >= 4) return 0;
    return smooth((seconds - .15) / .85) * (1 - smooth((seconds - 2.55) / 1.25));
  }

  function nodWeight(seconds) {
    if (seconds < 0 || seconds >= 1.8) return 0;
    if (seconds < .55) return smooth(seconds / .55);
    if (seconds < .9) return 1;
    return 1 - smooth((seconds - .9) / .9);
  }

  function blinkWeight(seconds) {
    const age = seconds - nextBlink;
    if (age < 0) return 0;
    if (age >= .22) {
      nextBlink = seconds + 2.8 + Math.random() * 2.5;
      return 0;
    }
    return Math.sin(age / .22 * Math.PI);
  }

  function mouthWeight(seconds) {
    const phase = seconds % .78 / .78;
    if (phase < .2) return .5 * smooth(phase / .2);
    if (phase < .43) return .5 + .5 * smooth((phase - .2) / .23);
    if (phase < .66) return 1 - .5 * smooth((phase - .43) / .23);
    return .5 * (1 - smooth((phase - .66) / .34));
  }

  function affine(image, source, destination, opacity) {
    const [s0, s1, s2] = source;
    const [d0, d1, d2] = destination;
    const det = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
    if (Math.abs(det) < 1e-5) return;
    const a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / det;
    const c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / det;
    const e = (d0.x * (s1.x * s2.y - s2.x * s1.y) + d1.x * (s2.x * s0.y - s0.x * s2.y) + d2.x * (s0.x * s1.y - s1.x * s0.y)) / det;
    const b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / det;
    const d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / det;
    const f = (d0.y * (s1.x * s2.y - s2.x * s1.y) + d1.y * (s2.x * s0.y - s0.x * s2.y) + d2.y * (s0.x * s1.y - s1.x * s0.y)) / det;
    context.save();
    context.globalAlpha = opacity;
    context.beginPath();
    context.moveTo(d0.x, d0.y);
    context.lineTo(d1.x, d1.y);
    context.lineTo(d2.x, d2.y);
    context.closePath();
    context.clip();
    context.setTransform(a, b, c, d, e, f);
    context.drawImage(image, 0, 0);
    context.restore();
  }

  function mesh(image, opacity, seconds, tilt, nod) {
    if (opacity <= .005) return;
    const columns = 8, rows = 14;
    const points = [];
    const dpr = window.devicePixelRatio || 1;
    const pivot = { x: fit.x + fit.width * .5, y: fit.y + fit.height * .48 };
    for (let row = 0; row <= rows; row++) {
      const v = row / rows;
      for (let column = 0; column <= columns; column++) {
        const u = column / columns;
        let x = fit.x + fit.width * u;
        let y = fit.y + fit.height * v;
        const head = 1 - smooth((v - .47) / .22);
        const edge = smooth((Math.abs(u - .5) - .22) / .27);
        const lower = smooth((v - .55) / .4);
        const hair = head * (.3 + .7 * edge);
        const hands = edge * smooth((v - .62) / .28);
        const cloth = lower * (1 - .25 * edge);
        x += dpr * (1.3 * hair * Math.sin(seconds * .85 + v * 4.2)
          + 1.7 * hands * Math.sin(seconds * 1.05 + u * 3.1)
          + .8 * cloth * Math.sin(seconds * .72 + u * 4.6));
        y += dpr * (.65 * hair * Math.sin(seconds * .9 + u * 3.4)
          + 1.15 * hands * Math.sin(seconds * .82 + u * 5.2)
          + .8 * cloth * Math.sin(seconds * .66 + u * 3.8)
          + .6 * lower * Math.sin(seconds * 1.25));
        const angle = -10 * Math.PI / 180 * tilt * (.16 + .84 * head);
        const dx = x - pivot.x, dy = y - pivot.y;
        x = pivot.x + Math.cos(angle) * dx - Math.sin(angle) * dy;
        y = pivot.y + Math.sin(angle) * dx + Math.cos(angle) * dy;
        const nodHead = 1 - smooth((v - .43) / .13);
        const nodTop = 1 - smooth((v - .24) / .24);
        const nodFace = smooth((v - .15) / .18) * (1 - smooth((v - .43) / .1));
        x = pivot.x + (x - pivot.x) * (1 + nod * (.026 * nodTop - .014 * (nodHead - nodTop)));
        y += dpr * nod * (4 * nodHead + 3 * nodFace);
        points.push({ x, y });
      }
    }
    const sw = image.width / columns, sh = image.height / rows;
    const at = (row, column) => points[row * (columns + 1) + column];
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      const x0 = column * sw, x1 = (column + 1) * sw;
      const y0 = row * sh, y1 = (row + 1) * sh;
      affine(image, [{x:x0,y:y0},{x:x1,y:y0},{x:x0,y:y1}], [at(row,column),at(row,column+1),at(row+1,column)], opacity);
      affine(image, [{x:x1,y:y1},{x:x0,y:y1},{x:x1,y:y0}], [at(row+1,column+1),at(row+1,column),at(row,column+1)], opacity);
    }
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(100, stage.clientWidth);
    const height = Math.max(100, stage.clientHeight);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
  }

  function render(now) {
    if (!active) return;
    if (now - lastDraw < 32) { frame = requestAnimationFrame(render); return; }
    lastDraw = now;
    resize();
    const seconds = (now - startedAt) / 1000;
    if (!inspection && !action && pose === 'sit' && seconds >= nextTilt) {
      action = { name: 'tilt', start: seconds };
      nextTilt = seconds + 24 + Math.random() * 24;
    }
    const age = action ? seconds - action.start : Infinity;
    const tilt = inspection ? clamp(Math.abs(inspection.ParamAngleZ || 0) / 10) : action?.name === 'tilt' ? tiltWeight(age) : 0;
    const nod = inspection ? 0 : action?.name === 'nod' ? nodWeight(age) : 0;
    if (action && ((action.name === 'tilt' && age >= 4) || (action.name === 'nod' && age >= 1.8))) action = undefined;
    const mouth = inspection ? clamp(inspection.ParamMouthOpenY || 0)
      : now < talkUntil ? mouthWeight(seconds) : 0;
    const blink = tilt ? 0 : inspection ? 1 - clamp(inspection.ParamEyeLOpen ?? 1) : blinkWeight(seconds);
    const smile = tilt;
    const source = images.calm;
    const scale = Math.min((canvas.width - 8) / source.width, (canvas.height - 8) / source.height);
    fit = { width: source.width * scale, height: source.height * scale };
    fit.x = (canvas.width - fit.width) / 2;
    fit.y = canvas.height - fit.height;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    mesh(images.calm, 1, seconds, tilt, nod);
    const mouthImage = images.mouths[Math.round(mouth * 8)];
    if (mouth > .01) mesh(mouthImage, 1, seconds, tilt, nod);
    if (blink > .01) mesh(images.blink, blink, seconds, tilt, nod);
    if (smile > .01) mesh(images.smile, smile, seconds, tilt, nod);
    parameters = {
      ParamAngleY: -18 * nod,
      ParamAngleZ: -10 * tilt,
      ParamBodyAngleY: -3 * nod,
      ParamEyeLOpen: smile ? 0 : 1 - blink,
      ParamEyeROpen: smile ? 0 : 1 - blink,
      ParamMouthForm: smile,
      ParamMouthOpenY: mouth,
      ParamBreath: .5 + .5 * Math.sin(seconds * 1.25)
    };
    frame = requestAnimationFrame(render);
  }

  window.addEventListener('resize', resize);
  return {
    async show(nextPose = 'sit') {
      await load();
      pose = nextPose;
      active = true;
      failure = undefined;
      inspection = undefined;
      action = undefined;
      talkUntil = 0;
      startedAt = performance.now();
      lastDraw = 0;
      nextBlink = 2.5 + Math.random() * 2;
      nextTilt = new URLSearchParams(location.search).get('ws') ? Infinity : 20 + Math.random() * 25;
      canvas.hidden = false;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(render);
      window.dispatchEvent(new Event('pet-ready'));
    },
    hide() {
      active = false;
      talkUntil = 0;
      action = undefined;
      cancelAnimationFrame(frame);
      canvas.hidden = true;
    },
    talk(seconds = 5) {
      talkUntil = performance.now() + Math.max(0, seconds) * 1000;
    },
    stopTalking() {
      talkUntil = 0;
    },
    async gesture(name) {
      if (!active || pose !== 'sit' || name !== 'Nod' || action) return false;
      action = { name: 'nod', start: (performance.now() - startedAt) / 1000 };
      return true;
    },
    tilt() {
      if (!active || pose !== 'sit' || action) return false;
      action = { name: 'tilt', start: (performance.now() - startedAt) / 1000 };
      return true;
    },
    status() {
      return { ready: Boolean(alpha), pose, active, error: failure, action: action?.name === 'tilt' ? 'tilted-smile' : action?.name || null, parameters };
    },
    hitTest(clientX, clientY) {
      if (!active || !fit || !alpha) return false;
      const rect = canvas.getBoundingClientRect();
      const x = (clientX - rect.left) / rect.width * canvas.width;
      const y = (clientY - rect.top) / rect.height * canvas.height;
      const u = (x - fit.x) / fit.width;
      const v = (y - fit.y) / fit.height;
      if (u < 0 || v < 0 || u >= 1 || v >= 1) return false;
      const px = Math.floor(u * images.calm.width), py = Math.floor(v * images.calm.height);
      return alpha[(py * images.calm.width + px) * 4 + 3] > 20;
    },
    inspectPose(values = {}) {
      inspection = values;
      const mouth = clamp(values.ParamMouthOpenY || 0);
      return { ArtMeshMouthOpen: [mouth], ArtMeshFace: [0, 1], ArtMeshTopwear: [0, 1] };
    }
  };
})();
