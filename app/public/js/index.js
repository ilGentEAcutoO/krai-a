// Business landing runtime (external so CSP can stay script-src 'self').
import { initNav, api, i18n, applyLang } from '/site.js';
import { mount } from '/js/call-demo.js';
initNav('home');

// ---------- plans: every number comes from GET /api/plans (store.js) ----------
// The static markup carries today's catalogue as a no-JS fallback; once the
// API answers, prices, quotas and trial length are repainted from it.
const NAMES = { solo: { th: 'ดูแล 1 คน', en: 'Solo' }, family: { th: 'ครอบครัว', en: 'Family' } };
const T = {
  th: {
    perMonth: '/เดือน', perYear: '/ปี', rec: 'แนะนำ', save: (n) => `ประหยัด ${n}%`,
    yearEq: (m) => `เฉลี่ย ฿${m}/เดือน`, monthEq: (y) => `หรือรายปี ฿${y}`,
    forOne: 'สำหรับ 1 คน — พ่อแม่ ญาติผู้ใหญ่ ลูก หรือตัวคุณเอง', forMany: (n) => `${n} เบอร์ในบัญชีเดียว ดูแลได้ทั้งครอบครัว`,
    phones: (n) => `ป้องกัน ${n} เบอร์`,
    usage: (c, m, shared) => `AI รับสายเดือนละ ${c} สาย / ${m} นาที${shared ? ' (ใช้ร่วมกัน)' : ''}`,
    watchers: (n) => (n == null ? 'แจ้งเตือนทาง LINE ได้ไม่จำกัดคน' : `แจ้งเตือนทาง LINE ได้ ${n} คน`),
    cta: (d) => (d ? `เริ่มทดลองฟรี ${d} วัน` : 'เริ่มทดลองฟรี'),
    gift: (g) => `ของขวัญ 1 ปีให้คนที่คุณรัก เริ่ม ฿${g} จ่ายครั้งเดียว`,
    note: (p) => `<span class="ch">ไม่ต้องผูกบัตร</span> · <span class="ch">เริ่มต้น <b>฿${p}</b>/เดือน</span> · <span class="ch">ไม่ต้องลงแอปเพิ่ม</span>`,
    close: (p, d) => `<span class="ch">ทดลองฟรี${d ? ` ${d} วัน` : 'ก่อน'} ไม่ต้องผูกบัตร</span> · <span class="ch">จากนั้นเริ่มต้น ฿${p}/เดือน</span>`,
  },
  en: {
    perMonth: '/month', perYear: '/year', rec: 'Recommended', save: (n) => `Save ${n}%`,
    yearEq: (m) => `About ฿${m} a month`, monthEq: (y) => `or ฿${y} a year`,
    forOne: 'For 1 person — a parent, grandparent, kid, or you', forMany: (n) => `${n} phones on one account, for the whole family`,
    phones: (n) => `${n} protected phone${n > 1 ? 's' : ''}`,
    usage: (c, m, shared) => `AI answers ${c} calls / ${m} minutes a month${shared ? ', shared' : ''}`,
    watchers: (n) => (n == null ? 'LINE alerts to as many family members as you like' : `LINE alerts to ${n} family members`),
    cta: (d) => (d ? `Start ${d}-day free trial` : 'Start free trial'),
    gift: (g) => `A 1-year gift for someone you love from ฿${g}, paid once`,
    note: (p) => `No card needed · from <b>฿${p}</b>/month · no app to install`,
    close: (p, d) => `${d ? `${d}-day free trial` : 'Free trial'}, no card · then from ฿${p}/month`,
  },
};
const num = (v) => Number(v) || 0;
const baht = (v) => num(v).toLocaleString('en-US');
const ARROW = '<span class="isl" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span>';

let cat = null;
let period = 'month';

function model(c) {
  const plans = Object.values(c.plans || {}).map((p) => ({
    id: String(p.id), name: String(p.name || p.id),
    month: num(p.price), year: p.annual == null ? null : num(p.annual),
    numbers: num(p.numbers), calls: num(p.calls), minutes: num(p.minutes ?? p.quota),
    watchers: p.watchers == null ? null : num(p.watchers), recommended: Boolean(p.recommended),
  })).sort((a, b) => a.month - b.month);
  if (plans.length && !plans.some((p) => p.recommended)) {
    [...plans].sort((a, b) => (b.numbers - a.numbers) || (a.month - b.month))[0].recommended = true;
  }
  const gifts = Object.values(c.gifts || {}).map((g) => num(g.price)).filter(Boolean).sort((a, b) => a - b);
  const days = num(c.trial?.days ?? c.trialDays);
  return { plans, gifts, days };
}

const savePct = (p) => (p.year && p.month ? Math.round((1 - p.year / (p.month * 12)) * 100) : 0);
const nameOf = (p, lang) => NAMES[p.id.split('-')[0]]?.[lang] || p.name.replace(/[<>&"]/g, '');

function planCard(p) {
  const t = T[i18n.lang];
  const yearly = period === 'year' && p.year != null;
  const price = yearly ? p.year : p.month;
  const per = yearly ? t.yearEq(baht(Math.round(p.year / 12))) : (p.year != null ? t.monthEq(baht(p.year)) : '');
  const href = `/start.html?plan=${encodeURIComponent(p.id)}&amp;interval=${yearly ? 'year' : 'month'}`;
  const btn = p.recommended
    ? `<a class="btn big leaf" href="${href}"><span>${t.cta(cat.days)}</span>${ARROW}</a>`
    : `<a class="btn big outline" href="${href}">${t.cta(cat.days)}</a>`;
  return `<article class="lp-plan lp-bezel${p.recommended ? ' rec' : ''}"><div class="lp-core">
    ${p.recommended ? `<span class="tag">${t.rec}</span>` : ''}
    <h3>${nameOf(p, i18n.lang)}</h3>
    <p class="for">${p.numbers > 1 ? t.forMany(p.numbers) : t.forOne}</p>
    <div class="lp-amt"><b>฿${baht(price)}</b><span>${yearly ? t.perYear : t.perMonth}</span></div>
    <p class="lp-per">${per}</p>
    <ul><li>${t.phones(p.numbers)}</li><li>${t.usage(p.calls, p.minutes, p.numbers > 1)}</li><li>${t.watchers(p.watchers)}</li></ul>
    ${btn}
  </div></article>`;
}

function paintPlans() {
  if (!cat || !cat.plans.length) return;
  const t = T[i18n.lang];
  const hasYear = cat.plans.every((p) => p.year != null);
  const toggle = document.getElementById('lpPeriod');
  toggle.hidden = !hasYear;
  if (!hasYear) period = 'month';
  const save = Math.max(0, ...cat.plans.map(savePct));
  document.getElementById('lpSave').textContent = save > 0 ? t.save(save) : '';
  toggle.querySelectorAll('button[data-period]').forEach((b) => {
    const on = b.dataset.period === period;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  document.getElementById('lpPlans').innerHTML = cat.plans.map(planCard).join('');

  const from = baht(cat.plans[0].month);
  const note = document.getElementById('heroNote');
  note.dataset.th = T.th.note(from); note.dataset.en = T.en.note(from);
  const close = document.getElementById('closeLine');
  close.dataset.th = T.th.close(from, cat.days); close.dataset.en = T.en.close(from, cat.days);
  if (cat.gifts.length) {
    const g = document.querySelector('#lpExtra > span');
    g.dataset.th = T.th.gift(baht(cat.gifts[0])); g.dataset.en = T.en.gift(baht(cat.gifts[0]));
  }
  if (cat.days) {
    document.querySelectorAll('[data-tpl]').forEach((el) => {
      el.dataset.th = el.dataset.tplTh.replace('{d}', cat.days);
      el.dataset.en = el.dataset.tplEn.replace('{d}', cat.days);
    });
  }
  applyLang();
}

document.getElementById('lpPeriod').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-period]');
  if (!b || b.dataset.period === period) return;
  period = b.dataset.period;
  paintPlans();
});
window.addEventListener('krai-a:lang', paintPlans);
api('/api/plans').then((c) => { cat = model(c); paintPlans(); }).catch(() => { /* keep the static fallback */ });

// ---------- the call recording the family gets (one real demo case) ----------
// Plays the frozen scam-police case line by line with a caption; audio only
// starts on a tap (autoplay policy) and pauses when the tab is hidden.
const clip = document.getElementById('clip');
const clipBtn = document.getElementById('clipPlay');
const clipCap = document.getElementById('clipCap');
let turns = null;
let turnsLang = '';
let idx = 0;
const audio = new Audio();
audio.preload = 'none';

// English pages play the English recording (scenariosEn); Thai audio only
// when no English take exists.
async function loadTurns() {
  if (turns && turnsLang === i18n.lang) return turns;
  const data = await fetch('/demo/scenarios.json').then((r) => r.json());
  const list = i18n.lang === 'en' && data.scenariosEn?.length ? data.scenariosEn : data.scenarios;
  const sc = (list || []).find((s) => s.id === 'scam-police');
  turnsLang = i18n.lang;
  turns = (sc?.turns || []).filter((t) => typeof t.audio === 'string' && t.audio.startsWith('/demo/audio/'));
  return turns;
}
function caption() {
  const t = turns?.[idx];
  if (!t) return;
  const who = t.role === 'ai'
    ? (i18n.lang === 'th' ? 'ใครอะ' : 'KRAI-A assistant')
    : (i18n.lang === 'th' ? 'ผู้โทร' : 'Caller');
  const line = i18n.lang === 'th' ? t.textTh : (t.textEn || t.textTh);
  clipCap.replaceChildren(Object.assign(document.createElement('em'), { textContent: `${who}: ` }), document.createTextNode(line || ''));
}
function setPlaying(on) {
  clip.classList.toggle('on', on);
  clipBtn.setAttribute('aria-pressed', String(on));
}
function playFrom(i) {
  idx = i;
  if (!turns[idx]) { idx = 0; setPlaying(false); return; }
  caption();
  audio.src = turns[idx].audio;
  audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
}
audio.addEventListener('ended', () => playFrom(idx + 1));
clipBtn.addEventListener('click', async () => {
  if (!audio.paused) { audio.pause(); setPlaying(false); return; }
  try {
    await loadTurns();
    if (!turns.length) return;
    if (audio.src && audio.currentTime > 0 && !audio.ended) { audio.play().then(() => setPlaying(true)).catch(() => {}); return; }
    playFrom(idx);
  } catch { setPlaying(false); }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && !audio.paused) { audio.pause(); setPlaying(false); }
});
// A new language is a different recording: stop, and the next tap loads it.
window.addEventListener('krai-a:lang', () => {
  if (!turns || turnsLang === i18n.lang) return;
  audio.pause();
  audio.removeAttribute('src');
  setPlaying(false);
  turns = null;
  idx = 0;
  clipCap.textContent = i18n.lang === 'en' ? clipCap.dataset.en : clipCap.dataset.th; // back to the static label
});

// ---------- hero call demo (shared component, public/js/call-demo.js) ----------
// Mounted at load: the incoming-call screen animates silently and the
// component's own "tap to listen" starts sound. Only one voice at a time:
// the hero call and the recording player stop each other.
const stage = document.getElementById('callDemo');
let demo = null;
try {
  demo = mount(stage, {
    lang: 'auto',
    cases: ['scam-police', 'scam-parcel', 'scam-bank', 'legit-hospital', 'unsure-survey'],
    initial: 'scam-police',
    compact: true,
    chips: false, // our own light-on-dark case row below the phone
    onEvent: (e) => {
      if (e.type === 'incoming') {
        stage.parentElement.classList.add('live'); // floating cards step aside for the live call
        if (!audio.paused) { audio.pause(); setPlaying(false); }
      }
    },
  });
} catch { /* keep the still screen; the recording player below still works */ }
clipBtn.addEventListener('click', () => demo?.pause?.(), true);
const cases = document.getElementById('lpCases');
if (!demo) cases.hidden = true;
cases.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-case]');
  if (!b || !demo) return;
  cases.querySelectorAll('button[data-case]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  if (!audio.paused) { audio.pause(); setPlaying(false); }
  demo.play(b.dataset.case);
});
document.getElementById('heroListen').addEventListener('click', (e) => {
  e.preventDefault();
  stage.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (demo) {
    if (!audio.paused) { audio.pause(); setPlaying(false); }
    cases.querySelector('[data-case="scam-police"]').click();
  } else {
    clipBtn.click();
  }
});
