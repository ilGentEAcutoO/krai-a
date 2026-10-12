// Pricing page runtime (was inline; external so CSP can be script-src 'self').
import { initNav, api, i18n, applyLang, escapeHtml, session } from '/site.js';
initNav('pricing');

// Everything with a number renders from GET /api/plans — store.js is the
// single source of truth, so prices, quotas and seats never live in this
// file. Only display names for known ids and the copy around them are local.
// All amounts show in THB (the service is Thailand-first; annual and gift
// prices have no USD equivalent yet), in both languages.
const NAMES = {
  solo: { th: 'ดูแล 1 คน', en: 'Solo' },
  family: { th: 'ครอบครัว', en: 'Family' },
};
const T = {
  th: {
    h1: (p) => `฿${p} ต่อคนที่คุณดูแล`,
    save: (n) => `ประหยัด ${n}%`,
    perMonth: '/เดือน', perYear: '/ปี',
    yearEq: (m) => `เฉลี่ย ฿${m}/เดือน`, monthEq: (y, n) => `หรือรายปี ฿${y} ประหยัด ${n}%`,
    rec: 'แนะนำ',
    forOne: 'สำหรับพ่อหรือแม่ 1 คน', forMany: (n) => `${n} เบอร์ในบัญชีเดียว เช่น พ่อ แม่ และอีก 1 คน`,
    phones: (n) => `ป้องกัน ${n} เบอร์`,
    usage: (c, m, shared) => `<span class="ch">AI รับสายเดือนละ ${c} สาย / ${m} นาที</span>${shared ? ' <span class="ch">(ใช้ร่วมกัน)</span>' : ''}`,
    watchers: (n) => (n == null ? 'แจ้งเตือนทาง LINE ได้ไม่จำกัดคน' : `แจ้งเตือนทาง LINE ได้ ${n} คน`),
    seat: (s) => `เพิ่มเบอร์ได้ถึง ${s.maxNumbers} เบอร์ +฿${s.price}/เบอร์/เดือน`,
    every: 'ทุกแผน: AI รับสายแทน แล้วสรุปทุกสายเป็น มิจฉาชีพ · คนจริง · ไม่แน่ใจ ส่งถึงคุณ',
    ctaTrial: (d) => `เริ่มทดลองฟรี ${d} วัน`, ctaTrialNoDays: 'เริ่มทดลองฟรี',
    ctaBuy: 'เลือกแผนนี้', ctaDash: 'ไปที่ห้องของฉัน',
    fine: (t) => `ไม่ต้องผูกบัตร · ทดลอง ${t.days} วัน (สูงสุด ${t.calls} สาย)`,
    trialHead: (t, name) => `ทดลองฟรี ${t.days} วัน แบบ${name}`,
    giftName: (g) => (g.numbers > 1 ? `ครอบครัว ${g.numbers} คน` : 'ดูแล 1 คน'),
    giftLine: (g) => `<span class="ch">ใช้ได้ ${g.months} เดือน</span> · <span class="ch">ป้องกัน ${g.numbers} เบอร์</span> · <span class="ch">ไม่ต่ออายุอัตโนมัติ</span>`,
    giftSoon: 'เปิดขายเร็ว ๆ นี้', giftBuy: 'ซื้อเป็นของขวัญ', once: 'จ่ายครั้งเดียว',
    topup: (packs) => `เราเตือนก่อนใกล้หมด และคุณเติมเองได้ในห้องของฉัน: ${packs.map((p) => `฿${p.price} ได้ ${p.calls} สาย / ${p.minutes} นาที`).join(' หรือ ')} โควตาหลักรีเซ็ตทุกต้นเดือน`,
    keep: (r) => `เก็บตามผลของสาย: คนจริง ${r.legitDays} วัน · ไม่แน่ใจ ${r.unsureDays} วัน · มิจฉาชีพ ${r.scamDays} วัน (เก็บไว้เป็นหลักฐาน) และลบเองได้ทีละสายในห้องของฉัน`,
    error: 'โหลดราคาไม่ได้ตอนนี้', retry: 'ลองใหม่', payFail: 'เปิดหน้าชำระเงินไม่ได้ ลองใหม่อีกครั้ง',
  },
  en: {
    h1: (p) => `฿${p} per person you look after`,
    save: (n) => `Save ${n}%`,
    perMonth: '/month', perYear: '/year',
    yearEq: (m) => `About ฿${m} a month`, monthEq: (y, n) => `or ฿${y} a year — save ${n}%`,
    rec: 'Recommended',
    forOne: 'For one parent', forMany: (n) => `${n} phones on one account — say, Mom, Dad and one more`,
    phones: (n) => `${n} protected phone${n > 1 ? 's' : ''}`,
    usage: (c, m, shared) => `AI answers ${c} calls / ${m} minutes a month${shared ? ', shared' : ''}`,
    watchers: (n) => (n == null ? 'LINE alerts to as many family members as you like' : `LINE alerts to ${n} family members`),
    seat: (s) => `Add phones up to ${s.maxNumbers}, +฿${s.price} per phone a month`,
    every: 'Every plan: the AI answers and sorts every call as scam · legit · unsure, then briefs you',
    ctaTrial: (d) => `Start ${d}-day free trial`, ctaTrialNoDays: 'Start free trial',
    ctaBuy: 'Choose this plan', ctaDash: 'Open My dashboard',
    fine: (t) => `No card needed · ${t.days}-day trial (up to ${t.calls} calls)`,
    trialHead: (t, name) => `Free ${t.days}-day trial of ${name}`,
    giftName: (g) => (g.numbers > 1 ? `Family of ${g.numbers}` : 'One person'),
    giftLine: (g) => `<span class="ch">${g.months} months</span> · <span class="ch">${g.numbers} protected phone${g.numbers > 1 ? 's' : ''}</span> · <span class="ch">never auto-renews</span>`,
    giftSoon: 'On sale soon', giftBuy: 'Buy as a gift', once: 'one-time',
    topup: (packs) => `We warn you before you run low, and you can top up yourself in My dashboard: ${packs.map((p) => `฿${p.price} for ${p.calls} calls / ${p.minutes} minutes`).join(' or ')}. The plan quota resets every month.`,
    keep: (r) => `By verdict: legit ${r.legitDays} days · unsure ${r.unsureDays} days · scam ${r.scamDays} days (kept as evidence) — and you can delete any call yourself in My dashboard.`,
    error: 'Couldn’t load prices right now', retry: 'Try again', payFail: 'Couldn’t open checkout — please try again.',
  },
};

const num = (v) => Number(v) || 0;
const baht = (v) => num(v).toLocaleString('en-US');
const nameOf = (id, fallback) => {
  const n = NAMES[String(id).split('-')[0]];
  return n ? n[i18n.lang] : escapeHtml(fallback || id);
};

let catalogue = null;
let failed = false;
let period = 'year'; // default: yearly (lead decision — the cheapest per month)

// Normalise the payload once: only numbers/booleans reach innerHTML.
function model(c) {
  const plans = Object.values(c.plans || {}).map((p) => ({
    id: String(p.id), name: p.name,
    month: num(p.price), year: p.annual == null ? null : num(p.annual),
    numbers: num(p.numbers), calls: num(p.calls), minutes: num(p.minutes ?? p.quota),
    watchers: p.watchers == null ? null : num(p.watchers),
    recommended: Boolean(p.recommended),
    buy: { month: Boolean(p.purchasable?.month), year: Boolean(p.purchasable?.year) },
  })).sort((a, b) => a.month - b.month);
  if (!plans.some((p) => p.recommended) && plans.length) {
    [...plans].sort((a, b) => (b.numbers - a.numbers) || (a.month - b.month))[0].recommended = true;
  }
  const seat = c.extraSeat ? {
    price: num(c.extraSeat.price), maxNumbers: num(c.extraSeat.maxNumbers || c.maxNumbers),
    allowedOn: Array.isArray(c.extraSeat.allowedOn) ? c.extraSeat.allowedOn.map(String) : [],
  } : null;
  const gifts = Object.values(c.gifts || {}).map((g) => ({
    id: String(g.id), price: num(g.price), months: num(g.months) || 12, numbers: num(g.numbers),
    buy: Boolean(g.purchasable),
  })).sort((a, b) => a.price - b.price);
  const topups = Object.values(c.topups || {}).map((t) => ({ price: num(t.price), calls: num(t.calls), minutes: num(t.minutes) }))
    .sort((a, b) => a.price - b.price);
  const trial = c.trial ? { days: num(c.trial.days), calls: num(c.trial.calls), plan: String(c.trial.plan || '') }
    : (c.trialDays ? { days: num(c.trialDays), calls: 0, plan: '' } : null);
  const r = c.retention;
  const retention = r ? { legitDays: num(r.legitDays), unsureDays: num(r.unsureDays), scamDays: num(r.scamDays) } : null;
  return { plans, seat, gifts, topups, trial, retention };
}

function savePct(p) {
  if (!p.year || !p.month) return 0;
  return Math.round((1 - p.year / (p.month * 12)) * 100);
}

function cta(p) {
  const t = T[i18n.lang];
  const m = catalogue;
  const cls = `btn ${p.recommended ? 'primary' : 'secondary'}`;
  if (session.loggedIn) {
    if (p.buy[period]) {
      return `<button type="button" class="${cls}" data-buy="${escapeHtml(p.id)}">${t.ctaBuy}</button>`;
    }
    return `<a class="${cls}" href="/dashboard.html">${t.ctaDash}</a>`;
  }
  const href = `/start.html?plan=${encodeURIComponent(p.id)}&interval=${period}`;
  const label = m.trial?.days ? t.ctaTrial(m.trial.days) : t.ctaTrialNoDays;
  return `<a class="${cls}" href="${href}">${label}</a>`;
}

function planCard(p) {
  const t = T[i18n.lang];
  const m = catalogue;
  const yearly = period === 'year' && p.year != null;
  const price = yearly ? p.year : p.month;
  const per = yearly ? t.perYear : t.perMonth;
  const eq = yearly ? t.yearEq(baht(Math.round(p.year / 12))) : (p.year != null ? t.monthEq(baht(p.year), savePct(p)) : '');
  const items = [
    `<li>${t.phones(p.numbers)}</li>`,
    `<li>${t.usage(p.calls, p.minutes, p.numbers > 1)}</li>`,
    `<li>${t.watchers(p.watchers)}</li>`,
    m.seat && m.seat.allowedOn.includes(p.id) ? `<li>${t.seat(m.seat)}</li>` : '',
  ].join('');
  return `<article class="plan${p.recommended ? ' rec' : ''}">
    ${p.recommended ? `<span class="tag">${t.rec}</span>` : ''}
    <h2>${nameOf(p.id, p.name)}</h2>
    <p class="for">${p.numbers > 1 ? t.forMany(p.numbers) : t.forOne}</p>
    <div class="amt"><b>฿${baht(price)}</b><span>${per}</span></div>
    <p class="per">${eq}</p>
    <ul>${items}</ul>
    ${cta(p)}
    ${m.trial && !session.loggedIn ? `<p class="fine">${t.fine(m.trial)}</p>` : ''}
  </article>`;
}

function giftCard(g) {
  const t = T[i18n.lang];
  const action = g.buy
    ? (session.loggedIn
      ? `<button type="button" class="btn secondary" data-gift="${escapeHtml(g.id)}">${t.giftBuy}</button>`
      : `<a class="btn secondary" href="/start.html?gift=${encodeURIComponent(g.id)}">${t.giftBuy}</a>`)
    : `<span class="soon">${t.giftSoon}</span>`;
  return `<article class="gift-card">
    <b>${t.giftName(g)}</b>
    <div class="gp">฿${baht(g.price)} <small>${t.once}</small></div>
    <span>${t.giftLine(g)}</span>
    ${action}
  </article>`;
}

function paint() {
  if (!catalogue) return;
  const t = T[i18n.lang];
  const m = catalogue;
  const box = document.getElementById('plans');

  // Headline: the cheapest monthly price is the "per person" figure.
  const solo = m.plans[0];
  const h1 = document.getElementById('prH1');
  if (solo) { h1.dataset.th = T.th.h1(baht(solo.month)); h1.dataset.en = T.en.h1(baht(solo.month)); }

  // Period toggle only when every plan has a yearly price.
  const hasYear = m.plans.length > 0 && m.plans.every((p) => p.year != null);
  if (!hasYear) period = 'month';
  const toggle = document.getElementById('period');
  toggle.hidden = !hasYear;
  const save = Math.max(0, ...m.plans.map(savePct));
  document.getElementById('saveTag').textContent = save > 0 ? t.save(save) : '';
  toggle.querySelectorAll('button[data-period]').forEach((b) => {
    const on = b.dataset.period === period;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });

  box.style.setProperty('--n', String(Math.min(m.plans.length, 3) || 1));
  box.innerHTML = m.plans.map(planCard).join('');
  document.getElementById('every').textContent = t.every;

  if (m.trial) {
    const trialPlan = m.plans.find((p) => p.id === m.trial.plan);
    const head = document.getElementById('ruleTrialHead');
    const thName = trialPlan ? NAMES[trialPlan.id.split('-')[0]]?.th || escapeHtml(trialPlan.name) : '';
    const enName = trialPlan ? NAMES[trialPlan.id.split('-')[0]]?.en || escapeHtml(trialPlan.name) : '';
    if (trialPlan) { head.dataset.th = T.th.trialHead(m.trial, thName); head.dataset.en = T.en.trialHead(m.trial, enName); }
  }

  const gift = document.getElementById('gift');
  gift.hidden = m.gifts.length === 0;
  document.getElementById('gifts').innerHTML = m.gifts.map(giftCard).join('');

  if (m.topups.length) {
    const el = document.getElementById('faqTopup');
    el.dataset.th = T.th.topup(m.topups); el.dataset.en = T.en.topup(m.topups);
  }
  if (m.retention) {
    const el = document.getElementById('faqKeep');
    el.dataset.th = T.th.keep(m.retention); el.dataset.en = T.en.keep(m.retention);
  }
  applyLang();
}

function paintError() {
  const t = T[i18n.lang];
  const box = document.getElementById('plans');
  box.innerHTML = `<div class="plans-state"><p>${t.error}</p><button type="button" class="btn secondary small" id="plansRetry" style="margin-top:12px">${t.retry}</button></div>`;
  document.getElementById('plansRetry').onclick = load;
}

async function checkout(body, btn) {
  btn.disabled = true;
  try {
    const r = await api('/api/billing/checkout', { method: 'POST', auth: true, body });
    if (r.url) { location.href = r.url; return; }
    throw new Error('no-url');
  } catch {
    btn.disabled = false;
    btn.insertAdjacentHTML('afterend', `<p class="fine" role="alert">${T[i18n.lang].payFail}</p>`);
  }
}

document.getElementById('period').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-period]');
  if (!b || b.dataset.period === period) return;
  period = b.dataset.period;
  paint();
});
document.addEventListener('click', (e) => {
  const buy = e.target.closest('[data-buy]');
  if (buy) checkout({ kind: 'plan', plan: buy.dataset.buy, interval: period }, buy);
  const gift = e.target.closest('[data-gift]');
  if (gift) checkout({ kind: 'gift', gift: gift.dataset.gift }, gift);
});

async function load() {
  try {
    catalogue = model(await api('/api/plans'));
    failed = false;
    paint();
  } catch {
    failed = true;
    paintError();
  }
}
load();
window.addEventListener('krai-a:lang', () => { if (catalogue) paint(); else if (failed) paintError(); });
