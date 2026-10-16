// Shared phone-call demo (krai-a.com + demo.krai-a.com). One phone screen,
// four phases: incoming call → "transferring to the KRAI-A assistant" →
// in-call (timer, live waveform, captions, risk meter) → ended (verdict +
// the LINE card the family gets). Replays calls recorded from a real engine
// run (/demo/scenarios.json): zero API calls per visitor.
// notify: 'line' (default, business site krai-a.com) ends on the LINE alert
// card; 'result' (hackathon demo.krai-a.com, not wired to LINE) ends on a
// neutral call-result card with a note on where the real service sends it.
//
//   import { mount } from '/js/call-demo.js';
//   const demo = mount(el, { lang: 'auto', cases: [...ids], initial, compact, chips, notify, onEvent });
//   demo.play(id) · select(id) · pause() · resume() · stop() · setLang('th'|'en') · destroy()
//
// Self-contained: no site.js, no inline script, static files only (CSP).
// Sound starts only on the visitor's tap. Ring, transfer chime and the
// turn-switch tones are synthesised with WebAudio, never baked into the mp3.
import { createPlayer, verdictAt, finalOf, autoPauseOnHidden, riskOf, scenarioFor } from '/demo-player.js';

const RING_MS = 2200;
const TRANSFER_MS = 1200;
const CUE_LEAD_MS = 140; // the turn-switch tone, then the voice
const DEFAULT_CASES = ['scam-police', 'scam-parcel', 'scam-bank', 'legit-hospital', 'unsure-survey'];

const STR = {
  incoming: ['สายเรียกเข้า', 'Incoming call'],
  unknown: ['ไม่มีในรายชื่อ', 'Not in contacts'],
  mobile: ['มือถือแม่', "Mom's phone"],
  tap: ['แตะเพื่อฟังสายนี้', 'Tap to hear this call'],
  tapSub: ['มีเสียง · ประมาณ %s วินาที', 'With sound · about %s s'],
  ringing: ['AI จะรับสายแทนแม่…', 'The AI is about to pick up for Mom…'],
  transferTop: ['กำลังโอนสายไปให้', 'Transferring the call to'],
  transferName: ['ใครอะ', 'the KRAI-A assistant'],
  transferSub: ['แม่ไม่ต้องรับเอง · ไม่ต้องลงแอป', "Mom doesn't pick up · no app needed"],
  talking: ['ใครอะ กำลังคุย', 'KRAI-A is on the call'],
  ai: ['ใครอะ', 'KRAI-A'],
  brand: ['ใครอะ', 'KRAI-A'],
  caller: ['ปลายสาย', 'Caller'],
  risk: ['ความเสี่ยง', 'Risk'],
  listening: ['กำลังฟัง', 'Listening'],
  SCAM: ['สายหลอก', 'Scam'],
  LEGIT: ['สายจริง', 'Real call'],
  UNSURE: ['ไม่แน่ใจ', 'Not sure'],
  outSCAM: ['AI วางสายแล้ว — แม่ไม่ต้องรับ ไม่เสียเงิน', 'The AI hung up — Mom never had to answer'],
  outLEGIT: ['สายจริง — ส่งต่อถึงแม่แล้ว', 'A real call — passed on to Mom'],
  outUNSURE: ['ไม่แน่ใจ — ถามคนในบ้านก่อน', 'Not sure — the family decides'],
  ended: ['วางสายแล้ว', 'Call ended'],
  lcSCAM: ['มีสายหลอกโทรหาแม่ AI รับไว้แล้ว', 'A scam call tried Mom — the AI took it'],
  lcLEGIT: ['สายจริงถึงแม่ — ฝากเบอร์โทรกลับไว้แล้ว', 'A real call for Mom — callback number saved'],
  lcUNSURE: ['สายไม่แน่ใจ — ช่วยดูหน่อย', 'Unsure call — please take a look'],
  now: ['เมื่อสักครู่', 'now'],
  result: ['ผลการคัดกรอง', 'Call result'],
  resultNote: ['ในบริการจริง ผลนี้ส่งถึงครอบครัวทาง LINE ได้ และต่อกับแอปแชทอื่นในภูมิภาค เช่น WhatsApp, Telegram, KakaoTalk ได้ · เดโมนี้ไม่ได้ส่งจริง',
    'In the real service this goes to the family on LINE, and other regional chat apps like WhatsApp, Telegram or KakaoTalk can plug in. This demo sends nothing.'],
  again: ['ฟังอีกครั้ง', 'Play again'],
  next: ['สายถัดไป', 'Next call'],
  pause: ['หยุด', 'Pause'],
  resume: ['เล่นต่อ', 'Resume'],
  skip: ['ข้าม', 'Skip'],
  stop: ['วางสาย', 'Hang up'],
  mute: ['ปิดเสียง', 'Mute'],
  unmute: ['เปิดเสียง', 'Unmute'],
  noAudio: ['ไม่มีเสียง', 'No audio'],
  thAudio: ['เสียงภาษาไทย · คำบรรยายภาษาอังกฤษ', 'Thai audio · English captions'],
  honestReal: ['สายตัวอย่างบันทึกจากการรันจริงของระบบ (%s)', 'Sample calls recorded from a real run of the system (%s)'],
  honest: ['สายตัวอย่างบันทึกไว้ล่วงหน้า', 'Pre-recorded sample calls'],
  loadErr: ['โหลดสายตัวอย่างไม่ได้ — รีเฟรชหน้านี้', "Couldn't load the sample calls — refresh the page"],
  cases: ['สายตัวอย่าง', 'Sample calls'],
  callLabel: ['สายตัวอย่าง: %s', 'Sample call: %s'],
};

const CASE_HINT = {
  'legit-hospital': ['คนจริง', 'real'],
  'unsure-survey': ['ไม่ชัวร์', 'unsure'],
};

// Line icons (24px grid, stroked).
const ICON = {
  phone: 'M6.6 3.5h2.6l1.4 4-2 1.3a11 11 0 0 0 6.6 6.6l1.3-2 4 1.4v2.6a2 2 0 0 1-2.2 2A17 17 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z',
  police: 'M12 3l7 3v5c0 4.4-3 8.3-7 9.5-4-1.2-7-5.1-7-9.5V6z M12 8.3l1.1 2.3 2.4.3-1.8 1.7.5 2.4-2.2-1.2-2.2 1.2.5-2.4-1.8-1.7 2.4-.3z',
  parcel: 'M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5z M3.5 7.5L12 12l8.5-4.5 M12 12v9 M7.8 5.3l8.4 4.5',
  bank: 'M3 9.5L12 4l9 5.5 M5.5 10.5v6.5 M10 10.5v6.5 M14 10.5v6.5 M18.5 10.5v6.5 M3.5 20h17',
  hospital: 'M7 4h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M12 8.5v7 M8.5 12h7',
  survey: 'M9 3.8h6v2.8H9z M7.5 5.2H6.2a1.2 1.2 0 0 0-1.2 1.2v13.4A1.2 1.2 0 0 0 6.2 21h11.6a1.2 1.2 0 0 0 1.2-1.2V6.4a1.2 1.2 0 0 0-1.2-1.2h-1.3 M8.5 11h7 M8.5 14.5h7 M8.5 18h4',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4.5 20.5a7.5 7.5 0 0 1 15 0',
  family: 'M9 11a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 9 11z M3 20a6 6 0 0 1 12 0 M16.5 11.5a2.6 2.6 0 1 0 0-5.2 M17 14.2a5 5 0 0 1 4 5.3',
  official: 'M4 6.5h16v11H4z M7.5 10a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 0 0-3.2 0z M6.5 15c.6-1.4 3.6-1.4 4.2 0 M13.5 10h4 M13.5 13h3',
  shield: 'M12 3l7.5 3v5.5c0 4.6-3.2 8.4-7.5 9.5-4.3-1.1-7.5-4.9-7.5-9.5V6z M8.6 12.2l2.4 2.4 4.6-4.8',
  pause: 'M8.5 6v12 M15.5 6v12',
  play: 'M8 5.5v13l10.5-6.5z',
  skip: 'M5.5 6l9 6-9 6z M18 6v12',
  hang: 'M3.2 13.6c4.9-4.4 12.7-4.4 17.6 0l-1.9 2.6-3.4-1.2-.4-2.3a10 10 0 0 0-6.2 0l-.4 2.3-3.4 1.2z',
  vol: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4z M15.5 9a4 4 0 0 1 0 6 M18 6.5a7.5 7.5 0 0 1 0 11',
  volOff: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4z M16 9.5l5 5 M21 9.5l-5 5',
  replay: 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3 M4.5 4.5v4h4',
  next: 'M5 12h13 M13 6.5l5.5 5.5-5.5 5.5',
};
const svg = (name, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON[name] || ICON.phone}"/></svg>`;
const VERDICTS = new Set(['SCAM', 'LEGIT', 'UNSURE']);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtClock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// One manifest fetch per page, however many phones mount.
let manifestP = null;
function loadManifest(url) {
  manifestP = manifestP || fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))).then((d) => {
    if (!Array.isArray(d?.scenarios) || !d.scenarios.length) throw new Error('empty manifest');
    return d;
  });
  manifestP.catch(() => { manifestP = null; }); // a later mount retries
  return manifestP;
}

// ---- sound: one <audio> for the voices (never two at once) + WebAudio for
// the waveform, the ring and the tones. Built inside the visitor's tap. ----
function silentWavUrl(ms = 120) {
  const rate = 8000;
  const n = Math.round((rate * ms) / 1000);
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  w(36, 'data'); v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

function createSound() {
  const el = new Audio();
  el.preload = 'auto';
  const cache = new Map(); // clip url → Promise<blob url | null>
  let pending = null;
  let seq = 0;
  let silent = null;
  let paused = false;
  let muted = false;
  let ctx = null;
  let master = null;
  let analyser = null;
  let wave = null;
  const synthNodes = new Set();

  const settle = (ok, err) => {
    const p = pending;
    pending = null;
    if (p) (ok ? p.resolve() : p.reject(err));
  };
  const playNow = (cur) => {
    const p = el.play();
    if (p) p.catch((e) => { if (e?.name !== 'AbortError' && pending === cur) settle(false, e); });
  };
  el.addEventListener('ended', () => settle(true));
  el.addEventListener('error', () => settle(false, el.error || new Error('audio-error')));
  el.addEventListener('playing', () => pending?.onStart?.());

  function graph() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 1;
      master.connect(ctx.destination);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      wave = new Uint8Array(analyser.fftSize);
      ctx.createMediaElementSource(el).connect(analyser);
      analyser.connect(master);
    } catch {
      // No graph: the voices still play through the element; no live waveform.
      analyser = null;
      if (ctx && !master) ctx = null;
    }
  }

  // A soft sine note with a quick attack and an exponential release.
  function note(freq, at, dur, gainDb = -22, toFreq = 0) {
    if (!ctx || !master) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const peak = 10 ** (gainDb / 20);
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, at);
    if (toFreq) o.frequency.exponentialRampToValueAtTime(toFreq, at + dur * 0.8);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(master);
    o.start(at);
    o.stop(at + dur + 0.02);
    synthNodes.add(o);
    o.onended = () => { synthNodes.delete(o); g.disconnect(); };
  }

  return {
    el,
    prefetch(urls) {
      for (const u of urls) {
        if (!u || cache.has(u)) continue;
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 15000);
        cache.set(u, fetch(u, { signal: ctrl.signal })
          .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((b) => URL.createObjectURL(b))
          .catch(() => { cache.delete(u); return null; })
          .finally(() => clearTimeout(t)));
      }
    },
    // Inside the tap: Safari only lets later play() through on an element
    // that already played during a gesture; the AudioContext needs it too.
    unlock() {
      silent = silent || silentWavUrl();
      settle(true);
      seq += 1;
      el.src = silent;
      const p = el.play();
      if (p) p.catch(() => {});
      graph();
    },
    async play(url, { onStart } = {}) {
      settle(true);
      const my = ++seq;
      const src = cache.has(url)
        ? await Promise.race([cache.get(url), new Promise((r) => setTimeout(() => r(url), 1500))])
        : url;
      if (my !== seq) return;
      if (!src) throw new Error('clip-unavailable');
      await new Promise((resolve, reject) => {
        pending = { resolve, reject, onStart };
        el.src = src;
        if (!paused) playNow(pending);
      });
    },
    pause() { paused = true; el.pause(); ctx?.suspend?.().catch(() => {}); },
    resume() {
      paused = false;
      if (ctx?.state === 'suspended') ctx.resume().catch(() => {});
      if (pending) playNow(pending);
    },
    stop() {
      paused = false;
      seq += 1;
      el.pause();
      settle(true);
      for (const o of synthNodes) { try { o.stop(); } catch { /* done */ } }
      synthNodes.clear();
      if (ctx?.state === 'suspended') ctx.resume().catch(() => {});
    },
    get muted() { return muted; },
    setMuted(m) {
      muted = Boolean(m);
      if (master) master.gain.value = muted ? 0 : 1;
      else el.muted = muted;
    },
    // Phone ring: two soft rising triads (~2 s). Silent before the tap.
    ring() {
      if (!ctx) return;
      const t0 = ctx.currentTime + 0.05;
      for (const k of [0, 1]) {
        const at = t0 + k * 1.05;
        [659.25, 830.61, 987.77, 830.61].forEach((f, i) => note(f, at + i * 0.11, 0.32, -20));
      }
    },
    transfer() {
      if (!ctx) return;
      const t0 = ctx.currentTime + 0.02;
      note(783.99, t0, 0.22, -24);
      note(1046.5, t0 + 0.14, 0.34, -24);
    },
    // Turn switch: higher when the AI starts, lower when the caller starts.
    cue(role) {
      if (!ctx) return;
      const t0 = ctx.currentTime + 0.01;
      if (role === 'ai') note(880, t0, 0.09, -24, 1320);
      else note(520, t0, 0.08, -24);
    },
    // Time-domain samples of the voice now playing (null without a graph).
    waveform() {
      if (!analyser) return null;
      analyser.getByteTimeDomainData(wave);
      return wave;
    },
  };
}

// ---- the component ----
export function mount(root, opts = {}) {
  if (!root) throw new TypeError('call-demo: mount(el) needs an element');
  const o = {
    lang: 'auto', cases: DEFAULT_CASES, initial: null, compact: false, chips: true, note: true, notify: 'line',
    manifestUrl: '/demo/scenarios.json', onEvent: () => {}, ...opts,
  };
  const siteLang = () => (document.documentElement.lang === 'en' ? 'en' : 'th');
  let lang = o.lang === 'auto' ? siteLang() : (o.lang === 'en' ? 'en' : 'th');
  const pick = (th, en) => (lang === 'en' ? (en || th) : th);
  const t = (k, n) => pick(...STR[k]).replace('%s', n ?? '');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const resultMode = o.notify === 'result';

  let manifest = null;
  let selected = o.initial || o.cases[0];
  let current = null;      // { scenario, audioLang } while a call is on
  let lastVerdict = null;
  let callStart = 0;
  let pausedAt = 0;
  let pausedTotal = 0;
  let clockIv = 0;
  let raf = 0;
  let visible = true;
  let destroyed = false;
  let failed = false;

  root.classList.add('kcd-host');
  root.innerHTML = `
<div class="kcd" data-phase="idle" data-notify="${resultMode ? 'result' : 'line'}"${o.compact ? ' data-compact' : ''}>
  <div class="kcd-cases" role="group" data-k="cases"${o.chips ? '' : ' hidden'}></div>
  <div class="kcd-phone">
    <div class="kcd-screen" role="region" data-k="screen">
      <div class="kcd-bar" aria-hidden="true"><span class="kcd-bar-t">9:41</span><span class="kcd-bar-i"><i></i><i></i><i></i><i></i></span></div>

      <section class="kcd-incoming" data-k="incoming">
        <p class="kcd-in-label" data-k="inLabel"></p>
        <div class="kcd-avatar" data-k="avatar"></div>
        <b class="kcd-num" data-k="num"></b>
        <span class="kcd-claim" data-k="unknown"></span>
        <span class="kcd-to" data-k="to"></span>
        <p class="kcd-ringing" data-k="ringing" aria-live="polite"></p>
        <button type="button" class="kcd-tap" data-k="tap">
          <span class="kcd-tap-ic" aria-hidden="true">${svg('play')}</span>
          <span class="kcd-tap-tx"><b data-k="tapTx"></b><small data-k="tapSub"></small></span>
        </button>
        <div class="kcd-in-btns" aria-hidden="true"><span class="kcd-fake no">${svg('hang')}</span><span class="kcd-fake yes">${svg('phone')}</span></div>
      </section>

      <section class="kcd-transfer" data-k="transfer" aria-live="polite">
        <div class="kcd-shield">${svg('shield')}</div>
        <p class="kcd-tr-top" data-k="trTop"></p>
        <b class="kcd-tr-name" data-k="trName"></b>
        <p class="kcd-tr-sub" data-k="trSub"></p>
        <span class="kcd-tr-bar" aria-hidden="true"><i></i></span>
      </section>

      <section class="kcd-incall" data-k="incall">
        <div class="kcd-ic-head">
          <span class="kcd-badge"><i aria-hidden="true"></i><span data-k="talking"></span></span>
          <span class="kcd-clock" data-k="clock">00:00</span>
        </div>
        <div class="kcd-ic-who"><span class="kcd-ic-av" data-k="icAv"></span><span class="kcd-ic-num" data-k="icNum"></span><span class="kcd-ic-claim" data-k="icClaim"></span></div>
        <canvas class="kcd-wave" data-k="wave" aria-hidden="true"></canvas>
        <div class="kcd-cap">
          <p class="kcd-prev" data-k="prev" aria-hidden="true"></p>
          <div class="kcd-now" data-k="now" aria-live="polite">
            <span class="kcd-sp" data-k="sp"></span>
            <p class="kcd-tx" data-k="tx"></p>
          </div>
        </div>
        <div class="kcd-risk" data-k="risk">
          <div class="kcd-risk-top"><span data-k="riskLabel"></span><b data-k="riskWord"></b></div>
          <span class="kcd-meter" aria-hidden="true"><i data-k="meter"></i></span>
          <p class="kcd-why" data-k="why"></p>
        </div>
        <div class="kcd-ctl">
          <button type="button" class="kcd-c" data-k="mute" aria-pressed="false">${svg('vol', 'on')}${svg('volOff', 'off')}<span data-k="muteTx"></span></button>
          <button type="button" class="kcd-c pp" data-k="pp" aria-pressed="false">${svg('pause', 'on')}${svg('play', 'off')}<span data-k="ppTx"></span></button>
          <button type="button" class="kcd-c" data-k="skip">${svg('skip')}<span data-k="skipTx"></span></button>
          <button type="button" class="kcd-c end" data-k="stop">${svg('hang')}<span data-k="stopTx"></span></button>
        </div>
      </section>

      <section class="kcd-ended" data-k="ended">
        <p class="kcd-end-top"><span data-k="endTop"></span> · <span class="kcd-end-t" data-k="endTime"></span></p>
        <div class="kcd-verdict" data-k="verdict">
          <b class="kcd-v-word" data-k="vWord"></b>
          <p class="kcd-v-out" data-k="vOut"></p>
          <p class="kcd-v-why" data-k="vWhy"></p>
        </div>
        <div class="kcd-line" data-k="line" role="status">
          <span class="kcd-line-app" aria-hidden="true">${resultMode ? svg('shield') : 'ค'}</span>
          <div class="kcd-line-main">
            <div class="kcd-line-top"><b data-k="lineBrand"></b><span>LINE</span><time data-k="lineNow"></time></div>
            <b class="kcd-line-title" data-k="lineTitle"></b>
            <p class="kcd-line-body" data-k="lineBody"></p>
          </div>
        </div>
        <p class="kcd-result-note" data-k="resultNote"${resultMode ? '' : ' hidden'}></p>
        <div class="kcd-end-btns">
          <button type="button" class="kcd-b ghost" data-k="again">${svg('replay')}<span data-k="againTx"></span></button>
          <button type="button" class="kcd-b" data-k="next"><span data-k="nextTx"></span>${svg('next')}</button>
        </div>
      </section>
    </div>
  </div>
  <p class="kcd-note" data-k="note"${o.note ? '' : ' hidden'}></p>
</div>`;
  const $ = {};
  for (const n of root.querySelectorAll('[data-k]')) $[n.dataset.k] = n;
  const box = root.querySelector('.kcd');

  const sound = createSound();
  const emit = (e) => { try { o.onEvent(e); } catch (err) { console.error(err); } };
  const player = createPlayer({
    audio: sound,
    ringMs: RING_MS,
    transferMs: TRANSFER_MS,
    beforeLine: (turn) => { sound.cue(turn.role); return CUE_LEAD_MS; },
    onEvent: onPlayer,
  });
  const stopHidden = autoPauseOnHidden(player, document);

  const scenarioOf = (id) => (manifest ? scenarioFor(manifest, id, lang) : { scenario: null, audioLang: 'th' });
  const caseIds = () => o.cases.filter((id) => manifest?.scenarios?.some((s) => s.id === id));

  function approxSeconds(sc) {
    const ms = sc.turns.reduce((a, tr) => a + (tr.ms || 0) + CUE_LEAD_MS, 0) + 600 * (sc.turns.length - 1) + RING_MS + TRANSFER_MS;
    return Math.max(5, Math.round(ms / 5000) * 5);
  }

  function setPhase(p) {
    box.dataset.phase = p;
    if (p !== 'incall') delete box.dataset.speaking;
  }

  function swapIn(el) {
    if (!el.animate) return;
    el.animate(reduceMotion.matches
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [{ opacity: 0, transform: 'translateY(6px)', filter: 'blur(3px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }],
    { duration: reduceMotion.matches ? 160 : 260, easing: 'cubic-bezier(.23,1,.32,1)' });
  }

  // ---- static copy ----
  function renderCopy() {
    $.screen.setAttribute('aria-label', t('callLabel', current?.scenario ? pick(current.scenario.titleTh, current.scenario.titleEn) : ''));
    $.cases.setAttribute('aria-label', t('cases'));
    $.inLabel.textContent = t('incoming');
    $.unknown.textContent = t('unknown');
    $.to.textContent = `→ ${t('mobile')}`;
    $.tapTx.textContent = t('tap');
    $.trTop.textContent = t('transferTop');
    $.trName.textContent = t('transferName');
    $.trSub.textContent = t('transferSub');
    $.talking.textContent = t('talking');
    $.riskLabel.textContent = t('risk');
    $.skipTx.textContent = t('skip');
    $.stopTx.textContent = t('stop');
    $.endTop.textContent = t('ended');
    $.lineBrand.textContent = resultMode ? t('result') : t('brand');
    $.resultNote.textContent = resultMode ? t('resultNote') : '';
    $.lineNow.textContent = t('now');
    $.againTx.textContent = t('again');
    $.nextTx.textContent = t('next');
    for (const b of [$.skip, $.stop]) b.setAttribute('aria-label', b.textContent.trim());
    renderMute();
    renderPause();
    renderNote();
  }

  function renderChips() {
    const ids = caseIds();
    $.cases.innerHTML = ids.map((id) => {
      const s = scenarioOf(id).scenario; // the current language's case (EN may be its own case)
      const hint = CASE_HINT[id];
      return `<button type="button" class="kcd-chip" data-id="${esc(id)}" aria-pressed="${id === selected}"><span>${esc(pick(s.titleTh, s.titleEn))}</span>${hint ? `<small>${esc(pick(...hint))}</small>` : ''}</button>`;
    }).join('');
  }

  function renderNote() {
    const e = manifest?.engine || {};
    const judge = String(e.judge || '');
    const real = judge && !/stub|canned/i.test(`${judge} ${e.persona || ''}`);
    const who = [/gemini/i.test(`${e.persona || ''} ${e.tts || ''}`) && 'Gemini', /jev/i.test(judge) && 'Jev'].filter(Boolean).join(' + ');
    let s = manifest ? (real && who ? t('honestReal', who) : t('honest')) : '';
    if (failed) s = t('loadErr');
    if (current?.audioLang === 'th' && lang === 'en' && !failed) s = `${s} · ${t('thAudio')}`;
    $.note.textContent = s;
  }

  function renderCaller(sc) {
    $.avatar.innerHTML = svg('person'); // a stranger ringing: never the logo they claim
    $.num.textContent = sc?.callerPhone || '';
    $.icAv.innerHTML = svg(sc?.icon || 'phone');
    $.icNum.textContent = sc?.callerPhone || '';
    $.icClaim.textContent = sc ? pick(sc.callerTh, sc.callerEn) : '';
  }

  function renderIdle() {
    const { scenario: sc } = scenarioOf(selected);
    current = null;
    setPhase('idle');
    renderCaller(sc);
    $.ringing.textContent = '';
    $.tapSub.textContent = sc ? t('tapSub', approxSeconds(sc)) : '';
    $.tap.disabled = !sc;
    for (const c of $.cases.querySelectorAll('.kcd-chip')) c.setAttribute('aria-pressed', String(c.dataset.id === selected));
    renderNote();
    renderCopy();
  }

  function renderPause() {
    const p = player.paused;
    if (p) box.dataset.paused = ''; else delete box.dataset.paused;
    $.pp.setAttribute('aria-pressed', String(p));
    $.ppTx.textContent = p ? t('resume') : t('pause');
    $.pp.setAttribute('aria-label', $.ppTx.textContent);
  }

  function renderMute() {
    const m = sound.muted || failed;
    $.mute.setAttribute('aria-pressed', String(m));
    $.muteTx.textContent = $.mute.dataset.failed ? t('noAudio') : sound.muted ? t('unmute') : t('mute');
    $.mute.setAttribute('aria-label', $.muteTx.textContent);
  }

  const speaker = (role) => (role === 'ai' ? t('ai') : t('caller'));
  const lineText = (turn) => (current?.audioLang === 'en' ? (turn.textEn || turn.textTh) : pick(turn.textTh, turn.textEn));

  function renderLine(i, { animate = false } = {}) {
    const sc = current.scenario;
    const turn = sc.turns[i];
    const prev = sc.turns[i - 1];
    $.prev.innerHTML = prev ? `<b>${esc(speaker(prev.role))}</b> ${esc(lineText(prev))}` : '';
    $.sp.dataset.role = turn.role;
    $.sp.textContent = speaker(turn.role);
    $.tx.textContent = lineText(turn);
    $.tx.lang = current.audioLang === 'en' || lang === 'en' ? 'en' : 'th';
    box.dataset.role = turn.role;
    if (animate) swapIn($.now);
  }

  function renderRisk(v, { animate = false } = {}) {
    const r = riskOf(v);
    $.risk.dataset.v = v?.verdict || '';
    $.riskWord.textContent = v ? (v.verdict === 'SCAM' ? `${t('SCAM')} ${Math.min(99, Math.round((v.confidence || 0) * 100))}%` : t(v.verdict)) : t('listening');
    $.meter.style.transform = `scaleX(${r == null ? 0.04 : Math.max(0.04, r).toFixed(3)})`;
    $.why.textContent = v ? pick(v.reasonTh, v.reasonEn) : '';
    if (animate && $.riskWord.animate && !reduceMotion.matches) {
      $.riskWord.animate([{ opacity: 0.3, transform: 'scale(.94)' }, { opacity: 1, transform: 'none' }], { duration: 280, easing: 'cubic-bezier(.23,1,.32,1)' });
    }
  }

  function renderEnded(f = {}) {
    const v = VERDICTS.has(f.verdict) ? f.verdict : 'UNSURE';
    box.dataset.v = v;
    $.verdict.dataset.v = v;
    $.line.dataset.v = v;
    $.vWord.textContent = t(v);
    $.vOut.textContent = t(`out${v}`);
    $.vWhy.textContent = pick(f.reasonTh, f.reasonEn) || '';
    const body = String(pick(f.lineTh || f.reasonTh, f.lineEn || f.reasonEn) || '').split('\n').map((x) => x.trim()).filter(Boolean);
    const own = body.length > 1;
    $.lineTitle.textContent = own ? body[0] : t(`lc${v}`);
    $.lineBody.textContent = (own ? body.slice(1) : body).join('\n');
    $.endTime.textContent = $.clock.textContent;
    const ids = caseIds();
    $.next.hidden = ids.length < 2;
  }

  // ---- clock + waveform ----
  const elapsed = () => (callStart ? (pausedAt || performance.now()) - callStart - pausedTotal : 0);
  function startClock() {
    clearInterval(clockIv);
    clockIv = setInterval(() => { $.clock.textContent = fmtClock(elapsed()); }, 250);
  }
  function stopClock() { clearInterval(clockIv); clockIv = 0; }

  const ctx2d = $.wave.getContext?.('2d') || null;
  let fakePhase = 0;
  function sizeCanvas() {
    if (!ctx2d) return;
    const r = $.wave.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if ($.wave.width !== w || $.wave.height !== h) { $.wave.width = w; $.wave.height = h; }
  }
  // Mirrored bars from the playing voice's amplitude. Without a WebAudio
  // graph the bars breathe gently while someone speaks (still honest: no data).
  const BARS = 36;
  const levels = new Float32Array(BARS);
  function drawWave() {
    raf = 0;
    if (!ctx2d || destroyed) return;
    const speaking = box.dataset.speaking !== undefined && !player.paused;
    const data = speaking ? sound.waveform() : null;
    const w = $.wave.width;
    const h = $.wave.height;
    ctx2d.clearRect(0, 0, w, h);
    const color = getComputedStyle($.wave).color;
    ctx2d.fillStyle = color;
    const step = w / BARS;
    const bw = Math.max(2, step * 0.42);
    fakePhase += 0.12;
    for (let i = 0; i < BARS; i += 1) {
      let target = 0.04;
      if (data) {
        const seg = Math.floor(data.length / BARS);
        let peak = 0;
        for (let j = i * seg; j < (i + 1) * seg; j += 1) peak = Math.max(peak, Math.abs(data[j] - 128) / 128);
        target = Math.min(1, 0.04 + peak * 1.9);
      } else if (speaking) {
        target = 0.12 + 0.18 * (0.5 + 0.5 * Math.sin(fakePhase + i * 0.55)) * (0.6 + 0.4 * Math.sin(fakePhase * 0.37 + i));
      }
      levels[i] += (target - levels[i]) * (target > levels[i] ? 0.55 : 0.18);
      const bh = Math.max(bw, levels[i] * h * 0.92);
      const x = i * step + (step - bw) / 2;
      const y = (h - bh) / 2;
      ctx2d.beginPath();
      if (ctx2d.roundRect) ctx2d.roundRect(x, y, bw, bh, bw / 2); else ctx2d.rect(x, y, bw, bh);
      ctx2d.fill();
    }
    if (box.dataset.phase === 'incall' && visible && !document.hidden) raf = requestAnimationFrame(drawWave);
  }
  function kickWave() {
    if (raf || !ctx2d) return;
    sizeCanvas();
    raf = requestAnimationFrame(drawWave);
  }

  // ---- player events ----
  function onPlayer(e) {
    if (destroyed) return;
    switch (e.type) {
      case 'ring':
        lastVerdict = null;
        callStart = 0; pausedAt = 0; pausedTotal = 0;
        $.clock.textContent = '00:00';
        delete box.dataset.v;
        setPhase('ringing');
        renderCaller(current.scenario);
        $.ringing.textContent = t('ringing');
        renderRisk(null);
        renderPause();
        sound.ring();
        emit({ type: 'incoming', id: current.scenario.id });
        break;
      case 'transfer':
        setPhase('transfer');
        sound.transfer();
        emit({ type: 'transfer', id: current.scenario.id });
        break;
      case 'line':
        if (!callStart) { callStart = performance.now(); startClock(); }
        if (box.dataset.phase !== 'incall') { setPhase('incall'); kickWave(); }
        box.dataset.speaking = '';
        renderLine(e.index, { animate: true });
        kickWave();
        emit({ type: 'line', id: current.scenario.id, index: e.index, role: e.turn.role, text: lineText(e.turn) });
        break;
      case 'line-end':
        delete box.dataset.speaking;
        break;
      case 'verdict':
        lastVerdict = e.verdict;
        renderRisk(e.verdict, { animate: true });
        emit({ type: 'verdict', id: current.scenario.id, verdict: e.verdict });
        break;
      case 'final': {
        stopClock();
        $.clock.textContent = fmtClock(elapsed());
        const f = e.final || lastVerdict || {};
        renderEnded(f);
        setPhase('ended');
        renderPause();
        if (!reduceMotion.matches && $.line.animate) {
          $.verdict.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.23,1,.32,1)', fill: 'backwards' });
          $.line.animate([{ opacity: 0, transform: 'translateY(18px) scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: 420, easing: 'cubic-bezier(.23,1,.32,1)', fill: 'backwards' });
        }
        emit({ type: 'final', id: current.scenario.id, final: f });
        break;
      }
      case 'audio-error':
        $.mute.dataset.failed = '1';
        renderMute();
        break;
      case 'paused':
        pausedAt = performance.now();
        renderPause();
        emit({ type: 'paused' });
        break;
      case 'resumed':
        if (callStart && pausedAt) pausedTotal += performance.now() - pausedAt;
        pausedAt = 0;
        renderPause();
        kickWave();
        emit({ type: 'resumed' });
        break;
      case 'stopped':
        stopClock();
        renderIdle();
        renderPause();
        emit({ type: 'stopped' });
        break;
      default:
    }
  }

  // ---- interaction ----
  function select(id) {
    if (!manifest || !caseIds().includes(id)) return;
    if (player.phase !== 'idle') player.stop();
    selected = id;
    renderIdle();
    emit({ type: 'select', id });
  }

  function play(id = selected) {
    if (!manifest) return;
    const pickd = scenarioOf(id);
    if (!pickd.scenario) return;
    selected = id;
    for (const c of $.cases.querySelectorAll('.kcd-chip')) c.setAttribute('aria-pressed', String(c.dataset.id === id));
    sound.unlock();
    sound.prefetch(pickd.scenario.turns.map((tr) => tr.audio));
    delete $.mute.dataset.failed;
    current = pickd;
    renderNote();
    renderMute();
    player.start(pickd.scenario);
    const r = box.getBoundingClientRect();
    if (r.top < 0 || r.bottom > innerHeight) box.scrollIntoView({ block: 'nearest', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  }

  function nextCase() {
    const ids = caseIds();
    const i = ids.indexOf(selected);
    play(ids[(i + 1) % ids.length]);
  }

  const togglePause = () => (player.paused ? player.resume() : player.pause());
  const on = (el, ev, fn) => el.addEventListener(ev, fn);
  on($.tap, 'click', () => play(selected));
  on($.cases, 'click', (e) => {
    const b = e.target.closest('.kcd-chip');
    if (b) play(b.dataset.id);
  });
  on($.pp, 'click', togglePause);
  on($.skip, 'click', () => player.skip());
  on($.stop, 'click', () => { player.stop(); $.tap.focus({ preventScroll: true }); });
  on($.mute, 'click', () => {
    if ($.mute.dataset.failed) return;
    sound.setMuted(!sound.muted);
    renderMute();
  });
  on($.again, 'click', () => play(selected));
  on($.next, 'click', nextCase);

  // Space pauses / resumes the call that is playing on screen.
  const onKey = (e) => {
    if (e.key !== ' ' || e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
    const el = e.target;
    if (el?.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|A|SUMMARY)$/.test(el?.tagName || '')) return; // Space presses the focused control
    if (document.querySelector('dialog[open]')) return;
    if (!['ring', 'transfer', 'line', 'gap'].includes(player.phase) || !visible) return;
    e.preventDefault();
    togglePause();
  };
  document.addEventListener('keydown', onKey);

  const io = 'IntersectionObserver' in window ? new IntersectionObserver((en) => {
    visible = en.some((x) => x.isIntersecting);
    if (visible) kickWave();
  }) : null;
  io?.observe(box);
  const ro = 'ResizeObserver' in window ? new ResizeObserver(() => sizeCanvas()) : null;
  ro?.observe($.wave);

  const onSiteLang = () => { if (o.lang === 'auto') api.setLang(siteLang()); };
  window.addEventListener('krai-a:lang', onSiteLang);
  // A page that sets <html lang> without the site event still switches the call.
  const langObs = o.lang === 'auto' && 'MutationObserver' in window ? new MutationObserver(onSiteLang) : null;
  langObs?.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });

  const api = {
    play, select,
    pause: () => player.pause(),
    resume: () => player.resume(),
    stop: () => player.stop(),
    // A new language is a different recording: end the call, show the new
    // language's incoming screen for the same case.
    setLang(l) {
      const next = l === 'en' ? 'en' : 'th';
      if (next === lang) return;
      lang = next;
      if (player.phase !== 'idle') player.stop();
      if (manifest) renderChips();
      renderIdle();
    },
    destroy() {
      destroyed = true;
      player.stop();
      stopClock();
      cancelAnimationFrame(raf);
      stopHidden();
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('krai-a:lang', onSiteLang);
      langObs?.disconnect();
      io?.disconnect();
      ro?.disconnect();
      root.innerHTML = '';
      root.classList.remove('kcd-host');
    },
    get phase() { return player.phase; },
    get lang() { return lang; },
    get selected() { return selected; },
    player,
  };

  renderCopy();
  renderCaller(null);
  $.tap.disabled = true;
  loadManifest(o.manifestUrl).then((m) => {
    if (destroyed) return;
    manifest = m;
    if (!caseIds().includes(selected)) selected = caseIds()[0] || m.scenarios[0].id;
    renderChips();
    renderIdle();
  }).catch(() => {
    if (destroyed) return;
    failed = true;
    renderNote();
  });
  return api;
}

export const mountCallDemo = mount; // alias
if (typeof window !== 'undefined') window.KraiCallDemo = { mount };
