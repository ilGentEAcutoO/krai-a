// demo.krai-a.com (hackathon): the shared phone-call demo (/js/call-demo.js) in the
// hero, five case cards that drive it, and the live panel that hosts
// /demo-live.js (the only public path that calls Gemini).
import { initNav, i18n, api, captchaToken } from '/site.js';
import { mount } from '/js/call-demo.js';

// initNav also applies ?lang=en|th (deep link, remembered). This page ships
// its own top bar + footer (not nav.nav / footer.foot): no product chrome.
initNav('demo');

const $ = (id) => document.getElementById(id);
const pick = (th, en) => (i18n.lang === 'en' ? (en || th) : th);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

const STR = {
  listening: ['กำลังฟัง', 'Listening'],
  SCAM: ['มิจฉาชีพ', 'Scam'],
  LEGIT: ['คนจริง', 'Real caller'],
  UNSURE: ['ไม่ชัวร์', 'Not sure'],
};
const t = (k, n) => pick(...STR[k]).replace('%s', n ?? '');
const VERDICTS = new Set(['SCAM', 'LEGIT', 'UNSURE']);

function verdictWord(v) {
  if (!v) return t('listening');
  // Never display certainty: the score tops out at 99%.
  return v.verdict === 'SCAM' ? `${t('SCAM')} ${Math.min(99, Math.round((v.confidence || 0) * 100))}%` : t(v.verdict);
}

// Line icons for the case cards (24px grid, stroked).
const ICON = {
  police: 'M12 3l7 3v5c0 4.4-3 8.3-7 9.5-4-1.2-7-5.1-7-9.5V6z M12 8.3l1.1 2.3 2.4.3-1.8 1.7.5 2.4-2.2-1.2-2.2 1.2.5-2.4-1.8-1.7 2.4-.3z',
  parcel: 'M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5z M3.5 7.5L12 12l8.5-4.5 M12 12v9 M7.8 5.3l8.4 4.5',
  bank: 'M3 9.5L12 4l9 5.5 M5.5 10.5v6.5 M10 10.5v6.5 M14 10.5v6.5 M18.5 10.5v6.5 M3.5 20h17',
  hospital: 'M7 4h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M12 8.5v7 M8.5 12h7',
  survey: 'M9 3.8h6v2.8H9z M7.5 5.2H6.2a1.2 1.2 0 0 0-1.2 1.2v13.4A1.2 1.2 0 0 0 6.2 21h11.6a1.2 1.2 0 0 0 1.2-1.2V6.4a1.2 1.2 0 0 0-1.2-1.2h-1.3 M8.5 11h7 M8.5 14.5h7 M8.5 18h4',
  family: 'M9 11a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 9 11z M3 20a6 6 0 0 1 12 0 M16.5 11.5a2.6 2.6 0 1 0 0-5.2 M17 14.2a5 5 0 0 1 4 5.3',
  official: 'M4 6.5h16v11H4z M7.5 10a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 0 0-3.2 0z M6.5 15c.6-1.4 3.6-1.4 4.2 0 M13.5 10h4 M13.5 13h3',
};
const iconSvg = (name) => `<svg viewBox="0 0 24 24"><path d="${ICON[name]}"/></svg>`;

// ---- the phone: one shared component, the case cards below drive it ----
const host = $('callHost');
const caseCards = [...document.querySelectorAll('.hk-case[data-case]')];
const markCases = (id) => { for (const card of caseCards) card.toggleAttribute('data-on', card.dataset.case === id); };
// Stable hooks for judges and the demo video:
//   ?case=<id>  open that case   ·   ?autoplay=1  start it (needs a browser
//   that allows sound without a tap, e.g. a recorder; otherwise it waits)
const params = new URLSearchParams(location.search);
const ids = caseCards.map((c) => c.dataset.case);
const startCase = ids.includes(params.get('case')) ? params.get('case') : 'scam-police';
const demo = mount(host, {
  lang: 'auto',
  cases: ids,
  initial: startCase,
  notify: 'result', // demo.krai-a.com is not wired to LINE: a neutral call-result card
  onEvent(e) { if (e.id && (e.type === 'select' || e.type === 'incoming')) markCases(e.id); },
});
markCases(demo.selected);
if (params.get('autoplay') === '1') {
  // The component has no "ready" event: play() is a no-op until its manifest
  // is in, so retry briefly (~5 s) until the call leaves idle.
  let tries = 0;
  const kick = () => {
    if (demo.phase !== 'idle' || tries++ > 50) return;
    demo.play(startCase);
    setTimeout(kick, 100);
  };
  kick();
}
if (params.has('case') && !params.has('autoplay')) host.scrollIntoView({ block: 'center' });
// A card may show another case in English (data-icon-en; its EN text is in data-en).
const cardIcons = () => {
  const en = document.documentElement.lang === 'en';
  for (const ic of document.querySelectorAll('.hk-case [data-icon]')) {
    const name = en && ic.dataset.iconEn ? ic.dataset.iconEn : ic.dataset.icon;
    if (ic.dataset.shown !== name) { ic.innerHTML = iconSvg(name); ic.dataset.shown = name; }
  }
};
cardIcons();
window.addEventListener('krai-a:lang', cardIcons);
for (const card of caseCards) {
  card.addEventListener('click', () => {
    demo.play(card.dataset.case);
    markCases(card.dataset.case);
    host.scrollIntoView({ block: 'center', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  });
}
for (const b of document.querySelectorAll('[data-live-open]')) {
  b.addEventListener('click', () => {
    if ($('liveBlock').dataset.live === 'on') openLive();
    else $('liveBlock').scrollIntoView({ block: 'center', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  });
}
window.addEventListener('krai-a:lang', () => renderLiveCopy());
if (new URLSearchParams(location.search).has('debug')) window.__demo = { demo };

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
  demo.stop(); // one voice at a time: the sample call yields to the live one
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
for (const b of document.querySelectorAll('[data-live-open]')) {
  b.addEventListener('click', () => {
    if (lv.block.dataset.live === 'on') openLive();
    else $('liveBlock').scrollIntoView({ block: 'center', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  });
}
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
  host.scrollIntoView({ block: 'center', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  host.querySelector('.kcd-chip[aria-pressed="true"], .kcd-chip')?.focus({ preventScroll: true });
}
$('backToChips').addEventListener('click', backToChips);

// /api/status: the live entry only when the server can run it; otherwise the
// friendly "full" line. Credit names only engines that are up.
function setLiveEntry(on) {
  lv.block.dataset.live = on ? 'on' : 'off';
  $('liveOpen').hidden = !on;
  lv.block.querySelector('.dm-live-hint').hidden = !on;
  $('liveOff').hidden = on;
  for (const b of document.querySelectorAll('[data-live-open]')) b.hidden = !on;
}
api('/api/status').then((st) => {
  setLiveEntry(Boolean(st?.live));
}).catch(() => setLiveEntry(false));

if (window.__demo) window.__demo.live = live;
