// /demo: one stage that replays calls recorded from a real engine run
// (public/demo/scenarios.json — zero API calls per visitor), plus a secondary
// live panel that hosts /demo-live.js (the only public path that calls Gemini).
import { initNav, i18n, api, captchaToken, escapeHtml } from '/site.js';
import { createPlayer, verdictAt, finalOf, autoPauseOnHidden, GAP_MS, RING_MS } from '/demo-player.js';

initNav('demo');

const $ = (id) => document.getElementById(id);
const pick = (th, en) => (i18n.lang === 'en' ? (en || th) : th);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

const STR = {
  ai: ['AI ใครอะ', 'Krai-A AI'],
  caller: ['ปลายสาย', 'Caller'],
  ringing: ['สายเข้าเบอร์แม่ — AI กำลังรับแทน', "Calling Mom's number — the AI is picking up"],
  listening: ['กำลังฟัง', 'Listening'],
  idleWhy: ['AI จะตัดสินระหว่างคุย', 'The AI decides as the call goes'],
  SCAM: ['มิจฉาชีพ', 'Scam'],
  LEGIT: ['คนจริง', 'Real caller'],
  UNSURE: ['ไม่ชัวร์', 'Not sure'],
  lcSCAM: ['ตัดสายมิจฉาชีพให้แม่แล้ว', 'Scam call cut off for Mom'],
  lcLEGIT: ['มีคนฝากข้อความถึงแม่', 'A message for Mom'],
  lcUNSURE: ['สายไม่ชัวร์ — เก็บข้อความไว้ให้', 'Unsure call — message kept'],
  mute: ['ปิดเสียง', 'Mute'],
  pause: ['หยุดชั่วคราว', 'Pause'],
  resume: ['เล่นต่อ', 'Resume'],
  unmute: ['เปิดเสียง', 'Unmute'],
  noAudio: ['เล่นเสียงไม่ได้ — ดูคำบรรยายแทน', "Audio can't play — follow the subtitles"],
  about: ['ประมาณ %s วินาที', 'about %s seconds'],
  loadErr: ['โหลดสายตัวอย่างไม่ได้ — รีเฟรชหน้านี้อีกครั้ง', "Couldn't load the sample calls — refresh this page"],
};
const t = (k, n) => pick(...STR[k]).replace('%s', n ?? '');

// Line icons for the caller avatar (24px grid, stroked).
const ICON = {
  phone: 'M6.6 3.5h2.6l1.4 4-2 1.3a11 11 0 0 0 6.6 6.6l1.3-2 4 1.4v2.6a2 2 0 0 1-2.2 2A17 17 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z',
  police: 'M12 3l7 3v5c0 4.4-3 8.3-7 9.5-4-1.2-7-5.1-7-9.5V6z M12 8.3l1.1 2.3 2.4.3-1.8 1.7.5 2.4-2.2-1.2-2.2 1.2.5-2.4-1.8-1.7 2.4-.3z',
  parcel: 'M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5z M3.5 7.5L12 12l8.5-4.5 M12 12v9 M7.8 5.3l8.4 4.5',
  bank: 'M3 9.5L12 4l9 5.5 M5.5 10.5v6.5 M10 10.5v6.5 M14 10.5v6.5 M18.5 10.5v6.5 M3.5 20h17',
  hospital: 'M7 4h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M12 8.5v7 M8.5 12h7',
  survey: 'M9 3.8h6v2.8H9z M7.5 5.2H6.2a1.2 1.2 0 0 0-1.2 1.2v13.4A1.2 1.2 0 0 0 6.2 21h11.6a1.2 1.2 0 0 0 1.2-1.2V6.4a1.2 1.2 0 0 0-1.2-1.2h-1.3 M8.5 11h7 M8.5 14.5h7 M8.5 18h4',
};
const VERDICTS = new Set(['SCAM', 'LEGIT', 'UNSURE']);
const iconSvg = (name) => `<svg viewBox="0 0 24 24"><path d="${ICON[name] || ICON.phone}"/></svg>`;

const els = {
  chips: [...document.querySelectorAll('#chips .chip')],
  stage: $('stage'), av: $('stAv'), num: $('stNum'), claim: $('stClaim'), time: $('stTime'),
  prev: $('stPrev'), now: $('stNow'), sp: $('stSp'), spName: $('stSpName'), tx: $('stTx'), tx2: $('stTx2'),
  play: $('stPlay'), playSub: $('stPlaySub'), v: $('stV'), why: $('stWhy'), dots: $('stDots'),
  end: $('stEnd'), again: $('stAgain'), card: $('lineCard'), lcTitle: $('lcTitle'), lcBody: $('lcBody'),
  ctl: $('ctl'), mute: $('ctlMute'), muteTx: $('ctlMuteTx'), skip: $('ctlSkip'), replay: $('ctlReplay'),
  stop: $('ctlStop'), pp: $('stPause'),
};

// ---- audio out: ONE <audio> element, so two voices can never overlap ----
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

function createAudioOut() {
  const el = new Audio();
  el.preload = 'auto';
  const cache = new Map(); // clip url → Promise<blob url | url>
  let pending = null;
  let seq = 0; // bumped by play/stop: a play still awaiting its clip gives up
  let silent = null;
  let paused = false;
  // A pause() interrupting a pending play() rejects it with AbortError: not a failure.
  const playNow = (cur) => {
    const p = el.play();
    if (p) p.catch((e) => { if (e?.name !== 'AbortError' && pending === cur) settle(false, e); });
  };
  const settle = (ok, err) => {
    const p = pending;
    pending = null;
    if (p) (ok ? p.resolve() : p.reject(err));
  };
  el.addEventListener('ended', () => settle(true));
  el.addEventListener('error', () => settle(false, el.error || new Error('audio-error')));
  el.addEventListener('playing', () => pending?.onStart?.()); // sound began: the player's end watchdog starts
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
          .catch(() => { cache.delete(u); return null; }) // missing clip: play() rejects, subtitles carry on; a replay retries
          .finally(() => clearTimeout(t)));
      }
    },
    // Called inside the tap: Safari only lets later play() calls through on an
    // element that already played during a user gesture.
    unlock() {
      silent = silent || silentWavUrl();
      settle(true);
      seq += 1;
      el.src = silent;
      const p = el.play();
      if (p) p.catch(() => {});
    },
    async play(url, { onStart } = {}) {
      settle(true);
      const my = ++seq;
      // A slow prefetch never blocks the line: after 1.5 s stream the clip directly.
      const src = cache.has(url)
        ? await Promise.race([cache.get(url), new Promise((r) => setTimeout(() => r(url), 1500))])
        : url;
      if (my !== seq) return; // stopped or superseded while loading
      if (!src) throw new Error('clip-unavailable');
      await new Promise((resolve, reject) => {
        pending = { resolve, reject, onStart };
        el.src = src;
        if (!paused) playNow(pending); // paused while loading: resume() starts it
      });
    },
    pause() {
      paused = true;
      el.pause();
    },
    resume() {
      paused = false;
      if (pending) playNow(pending);
    },
    stop() {
      paused = false;
      seq += 1;
      el.pause();
      settle(true);
    },
  };
}

// ---- state ----
const audio = createAudioOut();
let manifest = null;
let selected = 'scam-police';
let timerIv = 0;
let lineStartAt = 0;
let pausedAt = 0;    // clock freezes while paused
let pausedTotal = 0;
let lastVerdict = null;
let cardTimer = 0;

const player = createPlayer({ audio, onEvent: onPlayerEvent });
if (new URLSearchParams(location.search).has('debug')) window.__demo = { player, audio };

const scenarioById = (id) => manifest?.scenarios.find((s) => s.id === id) || null;

function approxSeconds(sc) {
  const ms = sc.turns.reduce((a, tr) => a + (tr.ms || 0), 0) + GAP_MS * (sc.turns.length - 1) + RING_MS;
  return Math.max(5, Math.round(ms / 5000) * 5);
}

function swapIn(el) {
  if (!el.animate) return;
  el.animate(reduceMotion.matches
    ? [{ opacity: 0 }, { opacity: 1 }]
    : [{ opacity: 0, transform: 'translateY(6px)', filter: 'blur(3px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }],
  { duration: reduceMotion.matches ? 180 : 280, easing: 'cubic-bezier(.23,1,.32,1)' });
}

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ---- rendering ----
function verdictWord(v) {
  if (!v) return t('listening');
  // Never display certainty: the score tops out at 99%.
  return v.verdict === 'SCAM' ? `${t('SCAM')} ${Math.min(99, Math.round((v.confidence || 0) * 100))}%` : t(v.verdict);
}

function renderVerdict(v, { animate = false, idle = false } = {}) {
  const changed = (els.v.dataset.v || '') !== (v ? v.verdict : idle ? '' : 'listen');
  els.v.dataset.v = v ? v.verdict : idle ? '' : 'listen';
  els.v.textContent = idle ? '—' : verdictWord(v);
  els.why.textContent = v ? pick(v.reasonTh, v.reasonEn) : t('idleWhy');
  if (animate && changed && els.v.animate) {
    els.v.animate(reduceMotion.matches
      ? [{ opacity: 0.3 }, { opacity: 1 }]
      : [{ opacity: 0.3, transform: 'scale(.94)' }, { opacity: 1, transform: 'scale(1)' }],
    { duration: 300, easing: 'cubic-bezier(.23,1,.32,1)' });
  }
}

function renderHeader(sc) {
  els.av.innerHTML = iconSvg(sc?.icon);
  els.num.textContent = sc?.callerPhone || '';
  els.claim.textContent = sc ? pick(sc.callerTh, sc.callerEn) : '';
}

// One dot per turn: upcoming = light, current = ring, done = the verdict
// standing after that turn (grey while the AI is still listening).
function renderDots(sc, { now = -1, upto = -1 } = {}) {
  els.dots.innerHTML = sc.turns.map((tr, i) => {
    if (i === now) return '<i class="now"></i>';
    if (i > upto) return '<i></i>';
    const raw = verdictAt(sc, i)?.verdict;
    return VERDICTS.has(raw) ? `<i data-v="${raw}"></i>` : '<i data-done></i>';
  }).join('');
}

function speakerName(role) {
  return role === 'ai' ? t('ai') : t('caller');
}

function renderLine(sc, i, { animate = false } = {}) {
  const turn = sc.turns[i];
  const prev = sc.turns[i - 1];
  els.prev.innerHTML = prev ? `<b>${escapeHtml(speakerName(prev.role))}</b>${escapeHtml(pick(prev.textTh, prev.textEn))}` : '';
  els.sp.dataset.role = turn.role;
  els.spName.textContent = speakerName(turn.role);
  const en = i18n.lang === 'en';
  els.tx.textContent = en ? (turn.textEn || turn.textTh) : turn.textTh;
  els.tx.lang = en && turn.textEn ? 'en' : 'th';
  els.tx2.textContent = en && turn.textEn ? turn.textTh : '';
  if (animate) swapIn(els.now);
}

function renderRing() {
  els.prev.textContent = '';
  els.sp.dataset.role = '';
  els.spName.textContent = '';
  els.tx.textContent = t('ringing');
  els.tx.lang = i18n.lang;
  els.tx2.textContent = '';
}

function renderIdle() {
  const sc = scenarioById(selected);
  els.stage.dataset.phase = 'idle';
  delete els.stage.dataset.speaking;
  renderHeader(sc);
  els.time.textContent = '00:00';
  els.playSub.textContent = sc ? `${pick(sc.titleTh, sc.titleEn)} · ${t('about', approxSeconds(sc))}` : '';
  renderVerdict(null, { idle: true });
  if (sc) renderDots(sc); else els.dots.innerHTML = '';
  els.ctl.dataset.on = 'false';
  hideEnd();
}

function renderPause() {
  const p = player.paused;
  if (p) els.stage.dataset.paused = ''; else delete els.stage.dataset.paused;
  els.pp.setAttribute('aria-pressed', String(p));
  els.pp.setAttribute('aria-label', p ? t('resume') : t('pause'));
  els.pp.title = p ? t('resume') : t('pause');
}

function renderMute() {
  const failed = els.mute.dataset.failed === '1';
  els.mute.setAttribute('aria-pressed', String(audio.el.muted || failed));
  els.muteTx.textContent = failed ? t('noAudio') : audio.el.muted ? t('unmute') : t('mute');
}

function hideEnd() {
  clearTimeout(cardTimer);
  els.card.classList.remove('in');
  els.card.hidden = true;
  els.end.hidden = true;
}

// The card shows the message the family receives. A multi-line LINE message
// keeps its own first line as the title; a one-liner gets a verdict title.
function renderCard(f = {}) {
  const lines = String(pick(f.lineTh || f.reasonTh, f.lineEn || f.reasonEn) || '').split('\n').map((x) => x.trim()).filter(Boolean);
  const own = lines.length > 1;
  els.card.dataset.v = VERDICTS.has(f.verdict) ? f.verdict : '';
  els.lcTitle.textContent = own ? lines[0] : t(`lc${VERDICTS.has(f.verdict) ? f.verdict : 'UNSURE'}`);
  els.lcBody.textContent = (own ? lines.slice(1) : lines).join('\n');
}

function showEnd(final) {
  renderCard(final || {});
  els.card.hidden = false;
  void els.card.offsetWidth; // commit the off-screen start before sliding in
  els.card.classList.add('in');
  cardTimer = setTimeout(() => { els.end.hidden = false; }, reduceMotion.matches ? 150 : 600);
}

function startClock() {
  stopClock();
  timerIv = setInterval(() => {
    if (lineStartAt) els.time.textContent = fmtClock((pausedAt || performance.now()) - lineStartAt - pausedTotal);
  }, 250);
}
function stopClock() { clearInterval(timerIv); timerIv = 0; }

function onPlayerEvent(e) {
  const sc = player.scenario;
  switch (e.type) {
    case 'ring':
      hideEnd();
      lastVerdict = null;
      lineStartAt = 0;
      pausedAt = 0;
      pausedTotal = 0;
      renderPause();
      els.stage.dataset.phase = 'ring';
      delete els.stage.dataset.speaking;
      renderHeader(sc);
      els.time.textContent = '00:00';
      renderRing();
      swapIn(els.now);
      renderVerdict(null);
      renderDots(sc);
      els.ctl.dataset.on = 'true';
      break;
    case 'line':
      if (!lineStartAt) { lineStartAt = performance.now(); startClock(); }
      els.stage.dataset.phase = 'line';
      els.stage.dataset.speaking = '';
      renderLine(sc, e.index, { animate: true });
      renderDots(sc, { now: e.index, upto: e.index - 1 });
      break;
    case 'line-end':
      els.stage.dataset.phase = 'gap';
      delete els.stage.dataset.speaking;
      renderDots(sc, { upto: e.index });
      break;
    case 'verdict':
      lastVerdict = e.verdict;
      renderVerdict(e.verdict, { animate: true });
      renderDots(sc, { upto: e.index });
      break;
    case 'final':
      stopClock();
      renderPause();
      els.stage.dataset.phase = 'done';
      delete els.stage.dataset.speaking;
      lastVerdict = e.final || lastVerdict;
      renderVerdict(lastVerdict, { animate: true });
      renderDots(sc, { upto: sc.turns.length - 1 });
      els.ctl.dataset.on = 'false';
      showEnd(e.final || lastVerdict);
      break;
    case 'audio-error':
      els.mute.dataset.failed = '1';
      renderMute();
      break;
    case 'stopped':
      stopClock();
      pausedAt = 0;
      renderIdle();
      renderPause();
      break;
    case 'paused':
      pausedAt = performance.now();
      renderPause();
      break;
    case 'resumed':
      if (lineStartAt && pausedAt) pausedTotal += performance.now() - pausedAt;
      pausedAt = 0;
      renderPause();
      break;
    default:
  }
}

// Re-render whatever is on stage in the new language (static copy is
// handled by site.js applyLang via data-th / data-en).
function rerender() {
  const sc = player.scenario;
  const phase = els.stage.dataset.phase;
  renderMute();
  renderPause();
  if (phase === 'idle' || !sc) { renderIdle(); return; }
  renderHeader(sc);
  if (phase === 'ring') renderRing();
  else if (player.index >= 0) renderLine(sc, player.index);
  renderVerdict(lastVerdict);
  if (!els.card.hidden) renderCard(finalOf(sc) || {});
}

// ---- interaction ----
function play(id) {
  const sc = scenarioById(id);
  if (!sc) return;
  selected = id;
  for (const c of els.chips) c.setAttribute('aria-pressed', String(c.dataset.id === id));
  audio.unlock();
  audio.prefetch(sc.turns.map((tr) => tr.audio));
  delete els.mute.dataset.failed;
  renderMute();
  player.start(sc);
  const r = els.stage.getBoundingClientRect();
  if (r.top < 0 || r.bottom > innerHeight) els.stage.scrollIntoView({ block: 'nearest', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
}

for (const c of els.chips) c.addEventListener('click', () => play(c.dataset.id));
els.play.addEventListener('click', () => play(selected));
els.again.addEventListener('click', () => play(selected));
els.replay.addEventListener('click', () => play(selected));
els.skip.addEventListener('click', () => player.skip());
const togglePause = () => (player.paused ? player.resume() : player.pause());
els.pp.addEventListener('click', togglePause);
// Stop: end the call, back to "ฟังสายนี้" for the same scenario (no LINE card).
els.stop.addEventListener('click', () => {
  player.stop();
  els.play.focus({ preventScroll: true });
});
// A hidden tab pauses the call; only the visitor resumes it.
autoPauseOnHidden(player, document);
els.mute.addEventListener('click', () => {
  if (els.mute.dataset.failed === '1') return;
  audio.el.muted = !audio.el.muted;
  renderMute();
});
window.addEventListener('krai-a:lang', () => { rerender(); renderHonest(); renderCredit(); renderLiveCopy(); });

// The honest label names only engines the manifest says recorded these calls;
// a stub judge or canned persona means no "real run" claim.
function renderHonest() {
  const e = manifest?.engine || {};
  const judge = String(e.judge || '');
  const voiced = `${e.persona || ''} ${e.tts || ''}`;
  const real = judge && !/stub|canned/i.test(`${judge} ${e.persona || ''}`);
  const who = [/gemini/i.test(voiced) && 'Gemini', /jev/i.test(judge) && 'Jev'].filter(Boolean).join(' + ');
  $('honest').textContent = real && who
    ? pick(`สายตัวอย่างบันทึกจากการรันจริงของระบบ (${who})`, `Sample calls recorded from a real run of the system (${who})`)
    : pick('สายตัวอย่างบันทึกไว้ล่วงหน้า', 'Pre-recorded sample calls');
}

// Credit line names only engines the server reports healthy right now.
let engines = null;
function renderCredit() {
  const parts = [];
  if (engines?.jev) parts.push(pick('ตัดสินโดย Jev', 'Judged by Jev'));
  if (engines?.gemini) parts.push(pick('พูดโดย Gemini', 'Voiced by Gemini'));
  $('credit').textContent = parts.join(' · ');
  $('credit').hidden = !parts.length;
}

async function loadManifest() {
  try {
    const res = await fetch('/demo/scenarios.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data?.scenarios) || !data.scenarios.length) throw new Error('empty manifest');
    manifest = data;
    renderHonest();
    for (const c of els.chips) c.hidden = !scenarioById(c.dataset.id);
    if (!scenarioById(selected)) selected = data.scenarios[0].id;
    for (const c of els.chips) c.setAttribute('aria-pressed', String(c.dataset.id === selected));
    renderIdle();
  } catch {
    els.play.disabled = true;
    for (const c of els.chips) c.disabled = true;
    els.playSub.textContent = t('loadErr');
  }
}

// ---- live panel: layout + copy here; mic, audio and the socket live in /demo-live.js ----
const lv = {
  block: $('liveBlock'), dlg: $('liveDlg'), root: $('lvIn'), intro: $('lvIntro'), talk: $('lvTalk'), msg: $('lvMsg'),
  start: $('lvStart'), startTx: $('lvStartTx'), stop: $('lvStop'), close: $('lvClose'), host: $('lvHost'),
  ring: $('lvRing'), time: $('lvTime'), prog: $('lvProg'), callerTx: $('lvCallerTx'), aiTx: $('lvAiTx'), v: $('lvV'), why: $('lvWhy'),
};
const RING_C = 2 * Math.PI * 54;
const LIVE = {
  start: ['ตกลง เริ่มคุย', 'OK, start talking'],
  again: ['คุยอีกครั้ง', 'Talk again'],
  retry: ['ลองอีกครั้ง', 'Try again'],
  samples: ['ฟังสายตัวอย่างแทน', 'Listen to a sample call'],
  mic: ['อนุญาตไมค์ในหน้าต่างที่เด้งขึ้น', 'Allow the microphone in the browser prompt'],
  connecting: ['กำลังต่อสาย…', 'Connecting…'],
  closing: ['AI กำลังกล่าวลา…', 'The AI is saying goodbye…'],
  hanging: ['กำลังวางสาย…', 'Hanging up…'],
  endscam: ['AI จับได้ว่าเป็นมิจ และวางสายแล้ว', 'The AI caught the scam and hung up'],
  endcap: ['ครบ 2 นาทีแล้ว — ขอบคุณที่ลองคุย', 'Two minutes are up — thanks for trying'],
  endmessage: ['AI รับฝากข้อความไว้แล้ว — ขอบคุณที่โทรมา', 'The AI took a message — thanks for calling'],
  endidle: ['เงียบนานเกินไป สายจึงจบ', 'It went quiet for too long, so the call ended'],
  endclient: ['วางสายแล้ว', 'Call ended'],
  enderror: ['สายหลุดกลางทาง — ลองคุยใหม่ได้', 'The call dropped — you can try again'],
  unsupported: ['เบราว์เซอร์นี้คุยสดไม่ได้ — ลอง Chrome หรือ Safari รุ่นล่าสุด หรือฟังสายตัวอย่างแทน', "This browser can't do live calls — try the latest Chrome or Safari, or listen to a sample call."],
  'mic-missing': ['ไม่พบไมโครโฟนในเครื่องนี้ — ลองบนมือถือ หรือฟังสายตัวอย่างแทน', 'No microphone found — try on your phone, or listen to a sample call.'],
  network: ['สายหลุด — เช็กอินเทอร์เน็ตแล้วลองอีกครั้ง', 'The connection dropped — check your internet and try again.'],
  'mic-denied': ['ยังไม่ได้อนุญาตไมค์ — แตะไอคอนแม่กุญแจข้างช่องที่อยู่เว็บ เปิดไมโครโฟน แล้วลองอีกครั้ง', 'The microphone is blocked — tap the lock icon by the address bar, allow the microphone, then try again.'],
  captcha: ['ระบบกันบอทไม่ผ่าน — ถ้าเปิดตัวบล็อกโฆษณาอยู่ ปิดแล้วลองใหม่', "The bot check didn't pass — if an ad blocker is on, turn it off and try again."],
  'rate-ip': ['คุณคุยครบโควตาของชั่วโมงนี้แล้ว — ลองใหม่ใน %s หรือฟังสายตัวอย่างระหว่างรอ', "You've used this hour's live calls — try again in %s, or listen to a sample call meanwhile."],
  'rate-day': ['วันนี้มีคนคุยครบโควตาแล้ว — กลับมาพรุ่งนี้ หรือฟังสายตัวอย่างแทน', "Today's live calls are used up — come back tomorrow, or listen to a sample call."],
  'rate-busy': ['ตอนนี้สายคุยสดเต็ม — รอสักครู่แล้วลองใหม่', 'All live lines are busy — wait a moment and try again.'],
  'live-unavailable': ['ตอนนี้คุยสดเต็มแล้ว — ลองฟังสายตัวอย่างด้านบนก่อนนะ', 'Live calls are full right now — try a sample call above first.'],
  'full-wait': ['ตอนนี้คุยสดเต็มแล้ว — ลองใหม่ได้ในอีก %s หรือฟังสายตัวอย่างด้านบนก่อนนะ', 'Live calls are full right now — try again in %s, or play a sample call above first.'],
  soon: ['อีกสักครู่', 'a little while'],
  mins: ['%s นาที', '%s min'],
};
const lt = (k, n) => pick(...(LIVE[k] || LIVE['live-unavailable'])).replace('%s', n ?? '');
const RETRYABLE = new Set(['mic-denied', 'network']);
const TALKING = new Set(['mic', 'connecting', 'live', 'closing']);
// demo-live.js error codes → copy keys (older names kept for safety).
const ERR_KEY = { unavailable: 'live-unavailable', 'live-unavailable': 'live-unavailable', 'day-cap': 'rate-day', unsupported: 'unsupported', 'mic-missing': 'mic-missing', 'mic-denied': 'mic-denied', captcha: 'captcha', network: 'network' };
// gen: one per call; callbacks from a call the visitor already left are ignored.
const live = { mod: null, modP: null, ctl: null, gen: 0, state: 'intro', msgKey: '', msgArg: null, msgText: null, startKey: 'start', v: null, maxMs: 120000, levels: { ai: 0, caller: 0 }, raf: 0 };

function loadLiveModule() {
  live.modP = live.modP || import('/demo-live.js').then((m) => (live.mod = m)).catch(() => null);
  return live.modP;
}

function renderLiveCopy() {
  if (live.msgText) lv.msg.textContent = pick(live.msgText.th, live.msgText.en);
  else if (live.msgKey) lv.msg.textContent = lt(live.msgKey, live.msgArg);
  lv.startTx.textContent = lt(live.startKey);
  if (live.v) {
    lv.v.textContent = verdictWord(live.v);
    lv.why.textContent = pick(live.v.reasonTh, live.v.reasonEn);
  } else {
    lv.v.textContent = verdictWord(null);
  }
}

function setLive(state, { msg = '', arg = null, text = null, startKey } = {}) {
  live.state = state;
  live.msgKey = msg;
  live.msgArg = arg;
  live.msgText = text?.th ? text : null;
  if (startKey) live.startKey = startKey;
  lv.root.dataset.state = state;
  if (state !== 'live') delete lv.root.dataset.who;
  lv.intro.hidden = !(state === 'intro' || (state === 'error' && live.startKey === 'retry' && !live.v));
  lv.talk.hidden = state === 'intro' || (state === 'error' && !live.v);
  lv.msg.hidden = !msg;
  lv.start.hidden = TALKING.has(state);
  lv.start.dataset.kind = live.startKey;
  // Consent sits right above every tap that turns the mic on.
  $('lvConsent').hidden = lv.start.hidden || live.startKey === 'samples';
  lv.stop.hidden = state !== 'live';
  renderLiveCopy();
}

function resetLiveCall() {
  live.v = null;
  lv.callerTx.textContent = '';
  lv.aiTx.textContent = '';
  lv.v.dataset.v = 'listen';
  lv.why.textContent = '';
  lv.time.textContent = '2:00';
  lv.prog.style.strokeDashoffset = '0';
  lv.prog.style.opacity = '1';
  delete lv.root.dataset.low;
  lv.ring.style.setProperty('--lvl', '0');
}

// Leaving the panel ends the call: bump gen first so late callbacks are dropped.
function leaveLive() {
  live.gen += 1;
  const ctl = live.ctl;
  live.ctl = null;
  try { (ctl?.destroy || ctl?.stop)?.call(ctl); } catch { /* already over */ }
  cancelAnimationFrame(live.raf);
  live.raf = 0;
}

function openLive() {
  player.stop(); // one voice at a time: the sample call yields to the live one
  leaveLive();
  resetLiveCall();
  setLive('intro', { startKey: 'start' });
  loadLiveModule(); // ready before the Start tap, so mountLive runs inside the gesture
  lv.dlg.showModal();
}

const onLive = {
  state(arg) {
    const st = typeof arg === 'string' ? arg : arg?.state;
    if (st === 'mic') setLive('mic', { msg: 'mic' });
    else if (st === 'connecting') setLive('connecting', { msg: 'connecting' });
    else if (st === 'live') setLive('live');
    else if (st === 'closing' && live.state !== 'closing') setLive('closing', { msg: live.msgKey === 'hanging' ? 'hanging' : 'closing' });
  },
  transcript({ role, text } = {}) {
    (role === 'ai' ? lv.aiTx : lv.callerTx).textContent = text || '';
  },
  verdict(v) {
    if (!VERDICTS.has(v?.verdict)) return;
    const changed = live.v?.verdict !== v.verdict;
    live.v = v;
    lv.v.dataset.v = v.verdict;
    renderLiveCopy();
    if (changed && lv.v.animate && !reduceMotion.matches) {
      lv.v.animate([{ opacity: 0.3, transform: 'scale(.94)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 300, easing: 'cubic-bezier(.23,1,.32,1)' });
    }
  },
  timer({ remainingMs, maxMs } = {}) {
    if (maxMs) live.maxMs = maxMs;
    const rem = Math.max(0, Math.min(live.maxMs, remainingMs ?? live.maxMs));
    const s = Math.ceil(rem / 1000);
    lv.time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    lv.prog.style.strokeDashoffset = String(RING_C * (1 - rem / live.maxMs));
    lv.prog.style.opacity = rem > 0 ? '1' : '0'; // a round cap leaves a dot at zero
    if (s <= 10) lv.root.dataset.low = ''; else delete lv.root.dataset.low;
  },
  // Levels for both voices (~10/s): who is talking + the ring's pulse.
  level(arg) {
    if (typeof arg === 'number') live.levels.caller = arg;
    else if (arg?.role === 'ai' || arg?.role === 'caller') live.levels[arg.role] = Number(arg.level) || 0;
    if (live.raf) return;
    live.raf = requestAnimationFrame(() => {
      live.raf = 0;
      const { ai, caller } = live.levels;
      const on = live.state === 'live';
      const who = !on ? '' : ai > 0.05 ? 'ai' : caller > 0.08 ? 'caller' : '';
      if (who) lv.root.dataset.who = who; else delete lv.root.dataset.who;
      lv.ring.style.setProperty('--lvl', on && !reduceMotion.matches ? Math.max(ai, caller).toFixed(2) : '0');
    });
  },
  end({ reason = 'client', final } = {}) {
    if (final) onLive.verdict(final);
    live.ctl = null;
    lv.ring.style.setProperty('--lvl', '0');
    setLive('ended', { msg: LIVE[`end${reason}`] ? `end${reason}` : 'enderror', startKey: reason === 'error' ? 'retry' : 'again' });
  },
  // No typed fallback: anything that blocks a live call (caps, captcha,
  // unavailable) points the visitor back to the sample calls.
  error({ code, scope, retryAfterSec, friendly } = {}) {
    live.ctl = null;
    if (code === 'mic-denied' || code === 'mic-missing' || code === 'network' || code === 'unsupported') {
      setLive('error', { msg: code, startKey: RETRYABLE.has(code) ? 'retry' : 'samples' });
      return;
    }
    if (code === 'captcha' && friendly?.th) {
      setLive('error', { msg: 'live-unavailable', text: friendly, startKey: 'samples' });
      return;
    }
    const hourly = code === 'rate-limited' && scope !== 'day' && retryAfterSec;
    setLive('error', {
      msg: hourly ? 'full-wait' : 'live-unavailable',
      arg: hourly ? lt('mins', Math.max(1, Math.ceil(retryAfterSec / 60))) : null,
      startKey: 'samples',
    });
  },
};

// Must run inside the Start tap: start() creates the AudioContext and asks for
// the mic synchronously, which browsers only allow during a user gesture.
function beginLive(mod) {
  if (typeof mod?.mountLive !== 'function') { onLive.error({ code: 'unavailable' }); return; }
  const gen = ++live.gen;
  const guard = (fn) => (arg) => { if (gen === live.gen) fn(arg); };
  resetLiveCall();
  setLive('connecting', { msg: 'connecting' });
  const adopt = (ctl) => {
    if (gen !== live.gen) { try { (ctl?.destroy || ctl?.stop)?.call(ctl); } catch { /* gone */ } return null; }
    live.ctl = ctl;
    if (ctl?.maxSeconds) live.maxMs = ctl.maxSeconds * 1000;
    return ctl;
  };
  try {
    const ctl = mod.mountLive(lv.host, {
      lang: i18n.lang,
      getCaptchaToken: (action) => captchaToken(action),
      onState: guard(onLive.state),
      onTranscript: guard(onLive.transcript),
      onVerdict: guard(onLive.verdict),
      onTimer: guard(onLive.timer),
      onLevel: guard(onLive.level),
      onEnd: guard(onLive.end),
      onError: guard(onLive.error),
    });
    if (typeof ctl?.start === 'function') {
      adopt(ctl);
      Promise.resolve(ctl.start()).catch(guard(() => onLive.error({ code: 'unavailable' })));
    } else {
      Promise.resolve(ctl).then(adopt, guard(() => onLive.error({ code: 'unavailable' })));
    }
  } catch {
    onLive.error({ code: 'unavailable' });
  }
}

$('liveOpen').addEventListener('click', openLive);
$('liveOpen').addEventListener('pointerenter', loadLiveModule, { once: true });
lv.start.addEventListener('click', () => {
  if (live.startKey === 'samples') { lv.dlg.close(); backToChips(); return; }
  if (live.mod) { beginLive(live.mod); return; }
  setLive('connecting', { msg: 'connecting' });
  loadLiveModule().then((m) => (m ? beginLive(m) : onLive.error({ code: 'live-unavailable' })));
});
lv.stop.addEventListener('click', () => {
  if (!live.ctl) return;
  setLive('closing', { msg: 'hanging' });
  delete lv.root.dataset.who;
  try { live.ctl.stop(); } catch { onLive.end({ reason: 'client' }); }
});
lv.close.addEventListener('click', () => lv.dlg.close());
lv.dlg.addEventListener('close', leaveLive);
lv.dlg.addEventListener('click', (e) => {
  // A backdrop tap closes the panel only when no call is running.
  if (e.target === lv.dlg && !TALKING.has(live.state)) lv.dlg.close();
});

function backToChips() {
  const chip = els.chips.find((c) => c.dataset.id === selected && !c.hidden) || els.chips[0];
  $('chips').scrollIntoView({ block: 'center', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  chip?.focus({ preventScroll: true });
}
$('backToChips').addEventListener('click', backToChips);

// /api/status: the live entry only when the server can run it; otherwise the
// friendly "full" line. Credit names only engines that are up.
function setLiveEntry(on) {
  lv.block.dataset.live = on ? 'on' : 'off';
  $('liveOpen').hidden = !on;
  lv.block.querySelector('.dm-live-hint').hidden = !on;
  $('liveOff').hidden = on;
}
api('/api/status').then((st) => {
  engines = st?.engines || null;
  renderCredit();
  setLiveEntry(Boolean(st?.live));
}).catch(() => setLiveEntry(false));

// Space pauses / resumes while a sample call plays (Enter still presses buttons).
document.addEventListener('keydown', (e) => {
  if (e.key !== ' ' || e.repeat || e.altKey || e.ctrlKey || e.metaKey || lv.dlg.open) return;
  const el = e.target;
  if (el?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName || '')) return;
  if (!['ring', 'line', 'gap'].includes(player.phase)) return;
  e.preventDefault();
  togglePause();
});

if (window.__demo) window.__demo.live = live;
renderIdle();
loadManifest();
