// Browser side of the live freestyle demo ("คุยกับ AI เอง"). Headless: no
// visible UI — demo-stage draws everything from the callbacks; we only stamp
// data-live-state on the container. Mic → 16 kHz PCM16 frames over /ws/live;
// AI audio (24 kHz PCM16) is played gaplessly and flushed on barge-in.
//
//   const live = mountLive(el, { lang, getCaptchaToken, onState, onTranscript,
//                                onVerdict, onTimer, onLevel, onEnd, onError });
//   button.onclick = () => live.start(); // call inside the click (AudioContext + mic need the gesture)
//   live.stop();    // caller hangs up → onEnd({ reason: 'client' })
//   live.destroy(); // silent teardown (panel closed); idempotent, safe before start() resolves
//
// onState: mic · connecting · live · closing (AI saying goodbye) · ended
// onEnd reasons: scam · message (message taken) · cap · idle · client · error
// onError codes: mic-denied · mic-missing · captcha {error, friendly, fallback}
//   · rate-limited {retryAfterSec} · day-cap · unavailable (fall back to the
//   pre-rendered scenarios — $0; no typed/STT path) · network
const MIC_RATE = 16000;
const AI_RATE = 24000;
const FRAME_SAMPLES = 1600; // 100 ms of 16 kHz audio per WS frame
const LEVEL_EVERY_MS = 100;

// Float32 [-1, 1] at inRate → Int16 PCM at outRate (box-filter average).
export function downsampleToPcm16(input, inRate, outRate = MIC_RATE) {
  const ratio = inRate / outRate;
  const n = Math.floor(input.length / ratio);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.max(start + 1, Math.min(input.length, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    const v = Math.max(-1, Math.min(1, sum / (end - start)));
    out[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
  }
  return out;
}

// Stateful wrapper: carries the fractional remainder between render quanta
// so 128-sample worklet blocks don't drift or click.
function createDownsampler(inRate) {
  const ratio = inRate / MIC_RATE;
  let carry = new Float32Array(0);
  return (block) => {
    const buf = new Float32Array(carry.length + block.length);
    buf.set(carry);
    buf.set(block, carry.length);
    const used = Math.floor(Math.floor(buf.length / ratio) * ratio);
    carry = buf.slice(used);
    return downsampleToPcm16(buf.subarray(0, used), inRate);
  };
}

async function defaultCaptchaToken(action) {
  const { captchaToken } = await import('./site.js');
  return captchaToken(action);
}

const rms = (a) => {
  let sq = 0;
  for (let i = 0; i < a.length; i++) sq += a[i] * a[i];
  return Math.sqrt(sq / (a.length || 1));
};

export function mountLive(el, opts = {}) {
  const {
    lang = 'th', getCaptchaToken = defaultCaptchaToken,
    onState, onTranscript, onVerdict, onTimer, onLevel, onEnd, onError,
  } = opts;
  const emit = (fn, arg) => { try { fn?.(arg); } catch (e) { console.error('[live] callback failed', e); } };

  let started = false;
  let done = false; // ended, failed or destroyed: no more callbacks
  let ending = false; // end frame received; draining the goodbye audio
  let state = '';
  let ctx = null;
  let stream = null;
  let ws = null;
  let maxMs = 0;
  let nextTime = 0;
  let aiOut = null; // gain → analyser → destination, for the AI level
  let analyser = null;
  let callerLevel = 0;
  let levelTimer = null;
  let stopTimer = null;
  let lastVerdict = null;
  const sources = new Set();

  const setState = (s) => {
    if (s === state || done) return;
    state = s;
    if (el) el.dataset.liveState = s;
    emit(onState, s);
  };
  const flushPlayback = () => {
    for (const src of sources) { try { src.stop(); } catch { /* not started */ } }
    sources.clear();
    nextTime = 0;
  };
  const stopMic = () => {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  };
  const cleanup = () => {
    done = true;
    clearInterval(levelTimer);
    clearTimeout(stopTimer);
    stopMic();
    flushPlayback();
    ctx?.close?.().catch(() => {});
    if (ws && ws.readyState <= 1) ws.close();
  };
  const fail = (err) => {
    if (done) return;
    cleanup();
    if (el) el.dataset.liveState = 'error';
    emit(onError, err);
  };
  const finish = (msg) => {
    if (done || ending) return;
    ending = true;
    stopMic();
    // Let already-received audio (the AI's goodbye) play out first.
    const tail = msg.reason === 'client' || !ctx ? 0 : Math.max(0, nextTime - ctx.currentTime);
    setTimeout(() => {
      if (done) return;
      setState('ended');
      cleanup();
      emit(onEnd, msg);
    }, tail * 1000 + 150);
  };

  const playPcm = (arrayBuf) => {
    if (done || !ctx) return;
    const pcm = new Int16Array(arrayBuf);
    if (!pcm.length) return;
    const audio = ctx.createBuffer(1, pcm.length, AI_RATE);
    const ch = audio.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = audio;
    src.connect(aiOut);
    const startAt = Math.max(ctx.currentTime + 0.04, nextTime);
    src.start(startAt);
    nextTime = startAt + audio.duration;
    sources.add(src);
    src.onended = () => sources.delete(src);
  };

  const startCapture = async () => {
    const source = ctx.createMediaStreamSource(stream);
    const mute = ctx.createGain();
    mute.gain.value = 0; // keeps the tap pulled by the graph without echoing the mic
    mute.connect(ctx.destination);
    const down = createDownsampler(ctx.sampleRate);
    let pending = new Int16Array(0);
    const onBlock = (block) => {
      if (done || ws?.readyState !== 1) return;
      callerLevel = Math.max(callerLevel, Math.min(1, rms(block) * 4));
      const pcm = down(block);
      const merged = new Int16Array(pending.length + pcm.length);
      merged.set(pending);
      merged.set(pcm, pending.length);
      pending = merged;
      while (pending.length >= FRAME_SAMPLES) {
        ws.send(pending.slice(0, FRAME_SAMPLES).buffer);
        pending = pending.slice(FRAME_SAMPLES);
      }
    };
    // AudioWorklet from a same-origin file (CSP script-src 'self'); if it
    // can't load, the deprecated-but-universal ScriptProcessor still works.
    if (ctx.audioWorklet && window.AudioWorkletNode) {
      try {
        await ctx.audioWorklet.addModule(new URL('./demo-live-worklet.js', import.meta.url));
        const tap = new AudioWorkletNode(ctx, 'krai-mic-tap');
        tap.port.onmessage = (e) => onBlock(e.data);
        source.connect(tap);
        tap.connect(mute);
        return;
      } catch (e) {
        console.info('[live] AudioWorklet unavailable, using ScriptProcessor:', e?.message || e);
      }
    }
    const sp = ctx.createScriptProcessor(4096, 1, 1);
    sp.onaudioprocess = (e) => onBlock(e.inputBuffer.getChannelData(0));
    source.connect(sp);
    sp.connect(mute);
  };

  const startLevels = () => {
    if (!onLevel) return;
    const buf = new Float32Array(analyser.fftSize);
    levelTimer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      emit(onLevel, { role: 'caller', level: callerLevel });
      emit(onLevel, { role: 'ai', level: Math.min(1, rms(buf) * 3) });
      callerLevel = 0;
    }, LEVEL_EVERY_MS);
  };

  const onMessage = (e) => {
    if (done) return;
    if (typeof e.data !== 'string') return playPcm(e.data);
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'transcript') emit(onTranscript, { role: msg.role, text: msg.text, final: msg.final });
    else if (msg.type === 'verdict') {
      lastVerdict = { verdict: msg.verdict, confidence: msg.confidence, reasonTh: msg.reasonTh, reasonEn: msg.reasonEn, engine: msg.engine };
      emit(onVerdict, lastVerdict);
    } else if (msg.type === 'timer') emit(onTimer, { remainingMs: msg.remainingMs, maxMs });
    else if (msg.type === 'interrupted') flushPlayback();
    else if (msg.type === 'closing') setState('closing');
    else if (msg.type === 'end') {
      if (msg.code === 'live-unavailable') return fail({ code: 'unavailable' });
      if (msg.reason === 'client') flushPlayback();
      finish({ reason: msg.reason, final: msg.final });
    }
  };

  async function start() {
    if (started || done) return;
    started = true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !window.WebSocket) return fail({ code: 'unavailable' });
    if (!navigator.mediaDevices?.getUserMedia) return fail({ code: 'mic-missing' });
    // Synchronously inside the user's click so playback is allowed.
    ctx = new AC();
    ctx.resume?.().catch(() => {});
    aiOut = ctx.createGain();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    aiOut.connect(analyser);
    analyser.connect(ctx.destination);

    setState('mic');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      const missing = ['NotFoundError', 'OverconstrainedError', 'NotReadableError'].includes(e?.name);
      return fail({ code: missing ? 'mic-missing' : 'mic-denied' });
    }
    if (done) return stopMic(); // destroyed while the permission prompt was open

    setState('connecting');
    const captchaToken = await Promise.resolve().then(() => getCaptchaToken('live_session')).catch(() => '');
    if (done) return;
    let res;
    let body;
    try {
      res = await fetch('/api/live/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lang, ...(captchaToken ? { captchaToken } : {}) }),
      });
      body = await res.json().catch(() => ({}));
    } catch {
      return fail({ code: 'network' });
    }
    if (done) return;
    if (res.status === 429) {
      return fail(body.scope === 'day'
        ? { code: 'day-cap', retryAfterSec: body.retryAfterSec }
        : { code: 'rate-limited', retryAfterSec: body.retryAfterSec });
    }
    if (res.status === 400 || res.status === 403) {
      return fail({ code: 'captcha', error: body.error, friendly: body.friendly, fallback: body.fallback });
    }
    if (!res.ok || !body.sessionId) return fail({ code: 'unavailable' });
    maxMs = (Number(body.maxSeconds) || 120) * 1000;

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws/live?session=${encodeURIComponent(body.sessionId)}`);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = onMessage;
    await new Promise((resolve) => {
      ws.onopen = () => {
        if (!done) {
          setState('live');
          startLevels();
          startCapture().catch(() => fail({ code: 'unavailable' })); // audio graph broke, not the mic
        }
        resolve();
      };
      ws.onclose = () => {
        resolve();
        if (done || ending) return;
        fail({ code: state === 'live' || state === 'closing' ? 'network' : 'unavailable' });
      };
    });
  }

  return {
    start,
    stop() {
      if (done) return;
      if (ws?.readyState === 1) {
        ws.send(JSON.stringify({ type: 'end' }));
        // The server answers with an end frame; if the network is gone, end locally.
        stopTimer = setTimeout(() => finish({ reason: 'client', final: lastVerdict }), 3000);
        return;
      }
      const wasStarted = started;
      cleanup();
      if (wasStarted) {
        state = 'ended';
        if (el) el.dataset.liveState = 'ended';
        emit(onState, 'ended');
        emit(onEnd, { reason: 'client', final: lastVerdict });
      }
    },
    destroy() {
      if (done) return;
      cleanup();
      if (el) el.dataset.liveState = 'ended';
    },
  };
}
