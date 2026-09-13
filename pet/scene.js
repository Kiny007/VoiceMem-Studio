(() => {
  const canvas = document.querySelector('#leaves');
  const stage = document.querySelector('#stage');
  const context = canvas.getContext('2d');
  const colors = ['#d4ecdfb8', '#b9d9e6b0', '#ddd2ef9f', '#a8cbb8a8'];
  let leaves = [];
  let last = performance.now();
  let lastDraw = 0;

  function reset(leaf, initial = false) {
    leaf.x = Math.random() * canvas.width;
    leaf.y = initial ? Math.random() * canvas.height : -20;
    leaf.size = (3.5 + Math.random() * 5) * (window.devicePixelRatio || 1);
    leaf.speed = (11 + Math.random() * 19) * (window.devicePixelRatio || 1);
    leaf.drift = (7 + Math.random() * 14) * (Math.random() < .5 ? -1 : 1) * (window.devicePixelRatio || 1);
    leaf.phase = Math.random() * Math.PI * 2;
    leaf.spin = (Math.random() - .5) * 1.4;
    leaf.angle = Math.random() * Math.PI * 2;
    leaf.color = colors[Math.floor(Math.random() * colors.length)];
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(stage.clientWidth * dpr));
    const height = Math.max(1, Math.round(stage.clientHeight * dpr));
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
    leaves = Array.from({ length: 15 }, () => { const leaf = {}; reset(leaf, true); return leaf; });
  }

  function drawLeaf(leaf) {
    context.save();
    context.translate(leaf.x, leaf.y);
    context.rotate(leaf.angle);
    context.scale(1, .55 + .18 * Math.sin(leaf.phase));
    context.fillStyle = leaf.color;
    context.beginPath();
    context.moveTo(-leaf.size, 0);
    context.quadraticCurveTo(0, -leaf.size * .8, leaf.size, 0);
    context.quadraticCurveTo(0, leaf.size * .8, -leaf.size, 0);
    context.fill();
    context.restore();
  }

  function animate(now) {
    requestAnimationFrame(animate);
    if (now - lastDraw < 32 || document.body.dataset.mode === 'dot') return;
    const delta = Math.min(.05, (now - last) / 1000);
    last = lastDraw = now;
    resize();
    context.clearRect(0, 0, canvas.width, canvas.height);
    for (const leaf of leaves) {
      leaf.phase += delta * 1.6;
      leaf.angle += delta * leaf.spin;
      leaf.x += delta * (leaf.drift + Math.sin(leaf.phase) * leaf.size * 1.8);
      leaf.y += delta * leaf.speed;
      if (leaf.y > canvas.height + 24 || leaf.x < -40 || leaf.x > canvas.width + 40) reset(leaf);
      drawLeaf(leaf);
    }
  }

  new ResizeObserver(resize).observe(stage);
  resize();
  requestAnimationFrame(animate);
})();
