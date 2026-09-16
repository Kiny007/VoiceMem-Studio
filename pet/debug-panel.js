(() => {
  const panel = document.createElement('aside'); panel.id = 'avatar-debug';
  for (let action = 1; action <= 10; action++) {
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = `动作 ${String(action).padStart(2, '0')}`;
    button.addEventListener('click', event => {
      event.stopPropagation(); window.avatar?.wake?.(); window.avatar?.playAction?.(action);
    });
    panel.appendChild(button);
  }
  document.body.appendChild(panel);
  window.addEventListener('keydown', event => { if (event.key === 'F8') panel.hidden = !panel.hidden; });
  window.avatarDebug = { event() {}, ws() {}, toggle() { panel.hidden = !panel.hidden; } };
})();
