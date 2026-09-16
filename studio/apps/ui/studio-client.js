/* Same-origin Studio transport. Each page owns one cancellable conversation. */
(() => {
  'use strict';
  const RATE = 24000;
  function resample(input, from, to) {
    if (from === to) return input;
    const ratio = from / to;
    const output = new Float32Array(Math.max(1, Math.round(input.length / ratio)));
    for (let i = 0; i < output.length; i++) {
      const position = i * ratio, a = Math.min(Math.floor(position), input.length - 1);
      const b = Math.min(a + 1, input.length - 1), t = position - a;
      output[i] = input[a] * (1 - t) + input[b] * t;
    }
    return output;
  }
  function create({ onEvent = () => {}, onState = () => {}, onPhase = () => {} } = {}) {
    let run = null;
    const active = owner => run === owner && !owner.closed;
    const emit = (owner, event) => { if (active(owner)) onEvent(event); };
    const sendJSON = (owner, message) => {
      if (active(owner) && owner.socket?.readyState === WebSocket.OPEN)
        owner.socket.send(JSON.stringify(message));
    };
    function stopMic(owner) {
      const mic = owner?.mic;
      if (!mic) return;
      owner.mic = null;
      mic.stream?.getTracks().forEach(track => track.stop());
      if (mic.node) {
        mic.node.port.onmessage = null;
        mic.node.port.close();
        mic.node.disconnect();
        try { owner.bus.disconnect(mic.node); } catch {}
      }
      mic.source?.disconnect();
      onState(false);
    }
    function end() {
      const owner = run;
      if (!owner) return;
      stopMic(owner);
      owner.closed = true;
      run = null;
      clearTimeout(owner.timeout);
      clearTimeout(owner.thinking);
      owner.reject?.(new Error('会话已结束'));
      owner.socket?.close();
      owner.clips.forEach(source => { source.onended = null; try { source.stop(); } catch {} });
      if (owner.player) { owner.player.port.onmessage = null; owner.player.port.close(); owner.player.disconnect(); }
      owner.bus?.disconnect();
      void owner.context?.close().catch(() => {});
      onPhase('idle');
      onEvent({ type: 'disconnected' });
    }
    function fail(owner, error) {
      if (!active(owner)) return;
      end();
      VMUI.notify(error.message || 'Studio 连接失败，请检查后端是否已启动。');
    }
    function phase(owner, value) {
      clearTimeout(owner.thinking);
      if (!active(owner)) return;
      onPhase(value);
      if (value === 'short-thinking') owner.thinking = setTimeout(() => {
        if (active(owner)) onPhase('long-thinking');
      }, 1500);
    }
    function audio(owner, buffer) {
      if (!owner.output) return;
      const pcm = new Int16Array(buffer), native = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) native[i] = pcm[i] / 32768;
      const samples = resample(native, owner.rate, owner.context.sampleRate);
      owner.player.port.postMessage({ type: 'audio', samples, sourceFrames: native.length }, [samples.buffer]);
    }
    function backchannel(owner, message) {
      if (!message.pcm) return;
      const bytes = atob(message.pcm), count = bytes.length >> 1;
      if (!count) return;
      const buffer = owner.context.createBuffer(1, count, Number(message.sample_rate) || RATE);
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < count; i++) samples[i] = ((bytes.charCodeAt(i * 2) | bytes.charCodeAt(i * 2 + 1) << 8) << 16 >> 16) / 32768;
      const source = owner.context.createBufferSource(), gain = owner.context.createGain();
      source.buffer = buffer; gain.gain.value = .72;
      source.connect(gain); gain.connect(owner.bus); owner.clips.add(source);
      source.onended = () => {
        owner.clips.delete(source); source.disconnect(); gain.disconnect();
        if (!active(owner)) return;
        if (!owner.clips.size && !owner.paused) owner.player.port.postMessage({ type: 'resume' });
        if (message.filler_id) sendJSON(owner, { type: 'filler_done', filler_id: message.filler_id });
      };
      source.start();
    }
    function handle(owner, message) {
      if (!active(owner)) return;
      if (message.output_id && message.type !== 'answer_start' && message.output_id !== owner.output) return;
      switch (message.type) {
        case 'session_ready':
          owner.player.port.postMessage({ type: 'config', prebuffer: message.mode === 'realtime' ? .08 : .16 });
          clearTimeout(owner.timeout); owner.resolve(owner); break;
        case 'user_transcript':
          phase(owner, 'short-thinking'); break;
        case 'answer_start':
          owner.output = message.output_id || '';
          owner.rate = Number(message.sample_rate) || RATE;
          owner.paused = false;
          owner.player.port.postMessage({ type: 'start', outputId: owner.output, sampleRate: owner.rate });
          if (owner.clips.size) owner.player.port.postMessage({ type: 'pause' });
          phase(owner, 'short-thinking'); break;
        case 'answer_pause':
          owner.paused = true; owner.player.port.postMessage({ type: 'pause' }); phase(owner, 'listening'); break;
        case 'answer_resume':
          owner.paused = false;
          if (!owner.clips.size) owner.player.port.postMessage({ type: 'resume' });
          break;
        case 'answer_done':
          owner.player.port.postMessage({ type: 'drain' }); break;
        case 'answer_interrupt':
          owner.player.port.postMessage({ type: 'clear', reason: 'interrupted' });
          owner.output = ''; phase(owner, owner.mic ? 'listening' : 'idle'); break;
        case 'backchannel':
          backchannel(owner, message); break;
        case 'error':
          owner.player.port.postMessage({ type: 'clear', reason: 'interrupted' });
          owner.output = ''; phase(owner, owner.mic ? 'listening' : 'idle');
          VMUI.notify(message.message || '服务返回错误，请重试。'); break;
      }
      emit(owner, message);
    }
    async function setup(owner) {
      try {
        const ctx = owner.context;
        await ctx.resume();
        await ctx.audioWorklet.addModule('/pcm-player-worklet.js');
        if (!active(owner)) return;
        owner.bus = ctx.createGain(); owner.bus.connect(ctx.destination);
        owner.player = new AudioWorkletNode(ctx, 'voicemem-pcm-player', { outputChannelCount: [1] });
        owner.player.connect(owner.bus);
        owner.player.port.onmessage = ({ data }) => {
          if (!active(owner)) return;
          const states = { buffer: 'playing', started: 'playing', resumed: 'playing', underflow: 'stalled' };
          if (data.outputId) sendJSON(owner, {
            type: 'playback_checkpoint', output_id: data.outputId,
            rendered_samples: Number(data.renderedSamples || 0), sample_rate: Number(data.sampleRate || RATE),
            buffered_samples: Math.round(Number(data.bufferedMs || 0) * Number(data.sampleRate || RATE) / 1000),
            state: states[data.type] || data.type, event: data.type,
          });
          if (data.outputId !== owner.output) return;
          if (data.type === 'started' || data.type === 'resumed') phase(owner, 'speaking');
          if (data.type === 'drained') {
            phase(owner, owner.mic ? 'listening' : 'idle');
            emit(owner, { type: 'playback_done', output_id: owner.output });
            if (owner.memoryClip) {
              const id = owner.memoryClip; owner.memoryClip = '';
              void playMemory(owner, id);
            }
          }
        };
        const url = new URL('/ws', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = owner.socket = new WebSocket(url.href); socket.binaryType = 'arraybuffer';
        socket.onmessage = event => {
          if (!active(owner)) return;
          try {
            if (event.data instanceof ArrayBuffer) audio(owner, event.data);
            else {
              const message = JSON.parse(event.data);
              if (message.type === 'play_memory') owner.memoryClip = message.memory_id;
              handle(owner, message);
            }
          } catch (error) { fail(owner, error); }
        };
        socket.onerror = () => fail(owner, new Error('无法连接 Studio，请先在命令行启动后端。'));
        socket.onclose = () => fail(owner, new Error('Studio 连接已断开，请重新开始对话。'));
      } catch (error) { fail(owner, error); }
    }
    async function playMemory(owner, id) {
      try {
        const response = await fetch(`/api/audio/${encodeURIComponent(id)}`);
        if (!response.ok) throw new Error('记忆录音暂不可用。');
        const buffer = await owner.context.decodeAudioData(await response.arrayBuffer());
        if (!active(owner)) return;
        const source = owner.context.createBufferSource(); source.buffer = buffer;
        source.connect(owner.bus); owner.clips.add(source);
        source.onended = () => { owner.clips.delete(source); source.disconnect(); };
        source.start();
      } catch (error) { if (active(owner)) VMUI.notify(error.message); }
    }
    function connect() {
      if (run) return run.ready;
      const owner = run = { closed: false, clips: new Set(), rate: RATE, output: '' };
      owner.ready = new Promise((resolve, reject) => { owner.resolve = resolve; owner.reject = reject; });
      // A handler is attached immediately so cancellation never leaves an unhandled rejection.
      owner.ready.catch(() => {});
      owner.timeout = setTimeout(() => fail(owner, new Error('连接超时，请检查 Studio 服务。')), 15000);
      try {
        owner.context = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' });
        void setup(owner);
      } catch (error) { fail(owner, error); }
      return owner.ready;
    }
    async function start() {
      const ready = connect(), owner = run;
      if (!owner || owner.mic) return;
      const mic = owner.mic = {};
      onState(true);
      try {
        await ready;
        if (!active(owner) || owner.mic !== mic) return;
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (!active(owner) || owner.mic !== mic) { stream.getTracks().forEach(track => track.stop()); return; }
        mic.stream = stream;
        await owner.context.audioWorklet.addModule('/mic-capture-worklet.js');
        if (!active(owner) || owner.mic !== mic) return;
        mic.source = owner.context.createMediaStreamSource(stream);
        mic.node = new AudioWorkletNode(owner.context, 'voicemem-mic-capture', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1] });
        mic.source.connect(mic.node, 0, 0); owner.bus.connect(mic.node, 0, 1); mic.node.connect(owner.context.destination);
        mic.node.port.onmessage = ({ data }) => {
          if (!active(owner) || owner.mic !== mic || data.type !== 'mic' || owner.socket.readyState !== WebSocket.OPEN) return;
          const samples = resample(data.samples, owner.context.sampleRate, RATE), pcm = new Int16Array(samples.length);
          let peak = 0;
          for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); pcm[i] = s < 0 ? s * 32768 : s * 32767; peak = Math.max(peak, Math.abs(s)); }
          window.liquidOrb?.setAudioLevel(peak);
          owner.socket.send(pcm.buffer);
        };
        phase(owner, 'listening');
      } catch (error) { if (active(owner)) { stopMic(owner); VMUI.notify(`麦克风未启动：${error.message}`); } }
    }
    async function send(text) {
      const owner = await connect();
      if (!active(owner)) throw new Error('会话已结束');
      sendJSON(owner, { type: 'user_text', text });
      phase(owner, 'short-thinking');
    }
    function toggle() { if (run?.mic) end(); else void start(); }
    window.addEventListener('pagehide', end);
    document.addEventListener('visibilitychange', () => { if (document.hidden) end(); });
    document.addEventListener('settings-open', end);
    let language = window.VMSettings?.language || 'zh-CN';
    document.addEventListener('display-settings-change', () => {
      const next = window.VMSettings?.language || 'zh-CN';
      if (next === language) return;
      language = next; end();
      fetch('/api/lang', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: next === 'en' ? 'en' : 'zh' }) })
        .then(response => { if (!response.ok) throw new Error('语言切换失败'); })
        .catch(error => VMUI.notify(error.message));
    });
    return { send, start, toggle, cancel: end, stop: end };
  }
  function applyUser(messages, event, role) {
    const id = event.input_turn_id;
    const finalized = messages.find(message => message.role === role && message.inputIds?.includes(id));
    if (finalized && !event.replace_input_turn_id) return finalized;
    let item = messages.find(message => message.role === role &&
      ((id && message.inputId === id) || (event.replace_input_turn_id && message.inputId === event.replace_input_turn_id)));
    if (!item) item = messages.find(message => message.role === role && message.pending && message.text === event.text);
    if (!item) { item = {role, time:new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}; messages.push(item); }
    Object.assign(item, {text:event.text, inputId:id, pending:false,
      inputIds:[...new Set([...(item.inputIds || []), id].filter(Boolean))]});
    return item;
  }
  function acceptsPartial(messages, event) {
    return !event.input_turn_id || !messages.some(message => message.inputIds?.includes(event.input_turn_id));
  }
  window.VMStudio = { create, applyUser, acceptsPartial };
})();
