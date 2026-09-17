/* Map VoiceMem events to the public avatar API. Mouth motion only follows actual playback RMS. */
(() => {
  const url = new URLSearchParams(location.search).get('ws'); if (!url) return;
  const seen = new Set();
  let socket, retries = 0, idleTimer, output = '', session = `connection-${Date.now()}`;
  let speaking = false, lipActive = false;
  const pools = { normal: [1, 2, 3, 4, 5], backchannel: [6, 7, 8], sad: [9, 10] };
  const cursor = Object.fromEntries(Object.entries(pools).map(([key, values]) =>
    [key, Math.floor(Math.random() * values.length)]));
  let lastSadAt = -Infinity;
  function playNext(kind) {
    const pool = pools[kind], action = pool[cursor[kind]++ % pool.length];
    window.avatar.playAction(action);
  }
  const remember = message => {
    const key = [message.session_id || session, message.output_id || '-', message.type,
      message.event_id || '-', message.state || '-', message.rendered_samples ?? '-',
      message.active ?? '-', message.emotion || '-'].join(':');
    if (seen.has(key)) return false; seen.add(key);
    if (seen.size > 256) seen.delete(seen.values().next().value); return true;
  };
  const event = value => window.avatarDebug?.event(value);
  function armSleep() { clearTimeout(idleTimer); idleTimer = setTimeout(() => window.avatar.sleep(), 20000); }
  function stopSpeaking(next = 'idle') {
    speaking = false; lipActive = false; output = ''; window.avatar.setSpeaking(false); window.avatar.setState(next); armSleep();
  }
  function wake(state = 'idle') { clearTimeout(idleTimer); window.avatar.wake(); window.avatar.setState(state); }
  function handle(message) {
    if (!message || typeof message !== 'object' || !remember(message)) return;
    event(`${message.type}${message.state ? `:${message.state}` : ''}`);
    if (message.session_id) session = String(message.session_id);
    if (message.type === 'conversation_started') { wake('listening'); playNext('normal'); armSleep(); return; }
    if (message.type === 'conversation_ended') { stopSpeaking(); return; }
    if (message.type === 'user_voice') {
      if (message.active === true) { wake('listening'); playNext('normal'); }
      else { window.avatar.setState(speaking ? 'speaking' : 'thinking'); armSleep(); }
      return;
    }
    if (message.type === 'backchannel') { wake('listening'); playNext('backchannel'); return; }
    if ((message.type === 'memory_hits' || message.type === 'tag_update') &&
        ['悲伤', 'sad'].includes(String(message.emotion || '').trim().toLowerCase())) {
      if (performance.now() - lastSadAt > 6000) { lastSadAt = performance.now(); wake('listening'); playNext('sad'); }
      return;
    }
    if (message.type === 'answer_interrupt') { stopSpeaking('interrupted'); return; }
    if (message.type === 'avatar_audio_level') {
      if (message.output_id && (!output || output === message.output_id)) {
        if (!speaking) wake('speaking');
        output = message.output_id; speaking = true;
        if (!lipActive) { window.avatar.setSpeaking(true); lipActive = true; }
        window.avatar.feedAudioLevel(message.rms, performance.now());
      }
      return;
    }
    if (message.type === 'error') { stopSpeaking('error'); window.avatar.setEmotion('concerned', .8, 3000); return; }
    if (message.type !== 'playback_checkpoint' || !message.output_id) return;
    if (message.state === 'playing') {
      if (!speaking || output !== message.output_id) wake('speaking');
      if (!speaking || output !== message.output_id) playNext('normal');
      output = message.output_id; speaking = true;
      if (!lipActive) { window.avatar.setSpeaking(true); lipActive = true; }
      return;
    }
    if (message.output_id !== output) return;
    if (message.state === 'paused' || message.state === 'stalled') { lipActive = false; window.avatar.setSpeaking(false); return; }
    if (message.state === 'interrupted') { stopSpeaking('interrupted'); return; }
    if (message.state === 'drained') {
      stopSpeaking();
    }
  }
  function schedule() { setTimeout(connect, Math.min(5000, 250 * 2 ** retries++)); }
  function connect() {
    try { socket = new WebSocket(url); } catch { schedule(); return; }
    socket.onopen = () => { retries = 0; session = `connection-${Date.now()}`; window.avatarDebug?.ws('connected'); };
    socket.onmessage = incoming => { try { handle(JSON.parse(incoming.data)); } catch {} };
    socket.onerror = () => { try { socket.close(); } catch {} };
    socket.onclose = () => { window.avatarDebug?.ws('reconnecting'); stopSpeaking(); schedule(); };
  }
  connect();
})();
