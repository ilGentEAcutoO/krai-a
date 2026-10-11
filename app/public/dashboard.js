// Member dashboard: plan, usage, family numbers, LINE (optional), call recordings,
// whitelist, watchers, cancel/reactivate. Bilingual via STR; re-renders on switch.
import { api, session, i18n, initNav, applyLang, logout } from '/site.js';
initNav('dash');

if (!session.loggedIn) location.href = '/start.html';

const PLAN_NAMES = {
  'starter-20': { th: 'Starter · ฿20', en: 'Starter · $2' },
  'plus-100': { th: 'Plus · ฿100', en: 'Plus · $6' },
  'family-149': { th: 'Family · ฿149', en: 'Family · $8' },
};
const planName = (p) => (PLAN_NAMES[p] && PLAN_NAMES[p][i18n.lang]) || p;
const priceStr = (pm) => (i18n.lang === 'th' ? `฿${pm.price}` : `$${pm.usd ?? pm.price}`);

const STR = {
  hello: { th: 'สวัสดี', en: 'Hello' },
  memberSince: { th: 'สมาชิกตั้งแต่', en: 'Member since' },
  trialLeft: { th: 'ทดลองฟรีเหลือ', en: 'Free trial left' },
  days: { th: 'วัน', en: 'days' },
  trialOver: { th: 'หมดช่วงทดลองแล้ว — เลือกแผนเพื่อใช้งานต่อ', en: 'Trial ended — pick a plan to continue' },
  cancelled: { th: 'สมาชิกถูกยกเลิก — ข้อมูลยังอยู่ กลับมาต่อได้ทุกเมื่อ', en: 'Membership cancelled — your data is kept; reactivate anytime' },
  quota: { th: 'โควต้า', en: 'Quota' },
  min: { th: 'นาที/เดือน', en: 'min/month' },
  numbersLbl: { th: 'เบอร์ที่ป้องกัน', en: 'Protected numbers' },
  watchersLbl: { th: 'ผู้ดูแล', en: 'Watchers' },
  changePlan: { th: 'เปลี่ยนแผน', en: 'Change plan' },
  perMonth: { th: '/เดือน', en: '/month' },
  used: { th: 'ใช้ไป', en: 'Used' },
  minShort: { th: 'นาที', en: 'min' },
  callsMonth: { th: 'สายเดือนนี้', en: 'Calls' },
  callsShort: { th: 'สาย', en: 'calls' },
  contacts: { th: 'คนรู้จัก', en: 'Contacts' },
  fwdStatus: { th: 'สถานะโอนสาย', en: 'Forwarding status' },
  fwdOn: { th: 'เปิดใช้งานแล้ว', en: 'Active' },
  fwdOff: { th: 'ยังไม่ตั้งค่า', en: 'Not set up' },
  fwdCode: { th: 'รหัสโอนสาย', en: 'Forward code' },
  demoNumNote: { th: 'เบอร์จำลองช่วงเดโม — เปิดบริการจริงจะออกเบอร์ไทยให้', en: 'Demo numbers — real Thai numbers are issued at launch' },
  numMaxed: { th: 'ครบโควต้าเบอร์ของแผนแล้ว — อัปเกรดเพื่อเพิ่มเบอร์', en: 'Number quota reached — upgrade for more numbers' },
  poolOut: { th: 'เบอร์ AI หมดชั่วคราว กรุณาลองใหม่ภายหลัง', en: 'AI numbers run out — try again later' },
  seatSent: { th: 'ส่งรหัสไปที่ ', en: 'Code sent to ' },
  seatCodeBad: { th: 'รหัสไม่ถูกต้อง ลองใหม่', en: 'Wrong code — try again' },
  seatLocked: { th: 'ลองผิดเกินกำหนด ขอรหัสใหม่', en: 'Too many attempts — request a new code' },
  seatExpired: { th: 'หมดเวลาแล้ว ขอรหัสใหม่', en: 'Expired — request a new code' },
  seatPay: { th: 'ครบโควต้าแผนแล้ว — กดเพิ่มเบอร์ %P%/เบอร์ด้านล่างได้เลย', en: 'Plan quota reached — add a number %P% below' },
  seatCap: { th: 'ครบ 5 เบอร์สูงสุดของบ้านแล้ว', en: 'Household max of 5 numbers reached' },
  seatHint: { th: 'เพิ่มเบอร์ +%P%/เบอร์/เดือน · ทุกเบอร์ต้องยืนยัน OTP', en: 'Add a number +%P%/mo each · every number needs OTP verification' },
  seatRate: { th: 'ขอรหัสบ่อยไป รอสักพักแล้วลองใหม่', en: 'Too many requests — wait and retry' },
  seatPending: { th: 'รอ OTP', en: 'Awaiting OTP' },
  lineSaved: { th: 'บันทึก LINE แล้ว', en: 'LINE saved' },
  lineCleared: { th: 'เลิกผูก LINE แล้ว — กล่องจดหมายหน้านี้ยังใช้ได้', en: 'LINE unlinked — this inbox still works' },
  noCalls: { th: 'ยังไม่มีสายเข้า — ตั้งโอนสายแล้วลองโทรหาเบอร์ตัวเองจากอีกเครื่องได้เลย', en: 'No calls yet — set up forwarding, then call yourself from another phone.' },
  turns: { th: 'เทิร์น', en: 'turns' },
  tape: { th: 'คลิปเสียง', en: 'Recording' },
  hide: { th: 'ซ่อน', en: 'Hide' },
  caller: { th: 'ปลายสาย', en: 'Caller' },
  ai: { th: 'AI', en: 'AI' },
  noWl: { th: 'ยังไม่มี — เพิ่มเบอร์ครอบครัวไว้ AI จะให้ผ่านด่วน', en: 'None yet — add family numbers for fast-track.' },
  noWatchers: { th: 'ยังไม่มีผู้ดูแล — เพิ่มเบอร์ลูกหลานไว้รับสำเนาแจ้งเตือน', en: 'No watchers — add family to receive alert copies.' },
  watcherMaxed: { th: 'ครบโควต้าผู้ดูแลของแผนแล้ว — อัปเกรดเพื่อเพิ่ม', en: 'Watcher quota reached — upgrade for more' },
  del: { th: 'ลบ', en: 'Remove' },
  badPhone: { th: 'เบอร์ไม่ถูกต้อง (ใช้ 08x-xxx-xxxx)', en: 'Invalid number (use 08x-xxx-xxxx).' },
  confirmCancel: { th: 'ยกเลิกสมาชิก? AI จะหยุดคัดกรองทันที (กลับมาต่อได้ทุกเมื่อ)', en: 'Cancel membership? AI stops screening immediately (reactivate anytime).' },
  cancelledOk: { th: 'ยกเลิกแล้ว — อย่าลืมกด ##21# เพื่อหยุดโอนสายด้วย', en: 'Cancelled — remember to dial ##21# to stop forwarding too.' },
  reactivated: { th: 'ต่อสมาชิกแล้ว ยินดีต้อนรับกลับ', en: 'Reactivated — welcome back' },
  fwdStopped: { th: 'อัปเดตสถานะแล้ว — อย่าลืมกด ##21# จากมือถือจริงด้วย', en: 'Status updated — remember to dial ##21# on your real phone too.' },
  payPlan: { th: 'ชำระค่าแผนนี้', en: 'Pay for this plan' },
  payGo: { th: 'กำลังเปิดหน้าชำระเงิน…', en: 'Opening checkout…' },
  payUnavailable: { th: 'ระบบชำระเงินยังไม่เปิด (โหมดทดลอง)', en: 'Payments unavailable (demo mode)' },
  payFailed: { th: 'เปิดหน้าชำระเงินไม่สำเร็จ ลองใหม่', en: 'Could not open checkout — retry' },
  payOk: { th: 'ชำระเงินสำเร็จ ✓ สิทธิ์กำลังเข้า', en: 'Payment received ✓ — benefits on the way' },
  payCancel: { th: 'ยกเลิกการชำระเงินแล้ว', en: 'Checkout cancelled' },
  buySeat: { th: 'เพิ่มเบอร์ %P%', en: 'Add a number %P%' },
  seatBought: { th: 'ชำระแล้ว — กดขอเบอร์เพิ่มอีกครั้งเพื่อเปิดเบอร์', en: 'Paid — request the number again to activate it' },
  topupTitle: { th: 'เติมนาทีและสาย', en: 'Top up minutes + calls' },
  topupDesc: { th: 'แพ็กเสริมไม่หมดอายุ ไม่รีเซ็ต — ใช้ได้จนกว่าจะหมด', en: 'Top-up packs never expire or reset — yours until spent.' },
  topupBtn: { th: 'เติมเลย', en: 'Top up' },
  quotaLow: { th: 'โควต้าใกล้หมดแล้ว — เติมเลยก่อนสายหลุดมือ', en: 'Running low — top up before calls stop screening.' },
  autoTitle: { th: 'เติมอัตโนมัติ', en: 'Auto top-up' },
  autoDesc: { th: 'นาทีหรือสายเหลือถึงจุดที่ตั้งไว้ ระบบจะชาร์จบัตรที่บันทึกไว้ให้เอง', en: 'When minutes or calls drop to your threshold, your saved card is charged.' },
  autoOn: { th: 'เปิดเติมอัตโนมัติ', en: 'Enable auto top-up' },
  autoThreshold: { th: 'ชาร์จเมื่อเหลือ', en: 'Charge when down to' },
  autoPack: { th: 'แพ็กที่จะชาร์จ', en: 'Pack to charge' },
  autoCardOk: { th: 'พร้อมตัดบัตรที่บันทึกไว้อัตโนมัติ', en: 'Your saved card will be charged automatically.' },
  autoManualNote: { th: 'จ่ายด้วย PromptPay ตัดอัตโนมัติไม่ได้ — ต้องกดเติมเองทุกครั้ง', en: 'PromptPay cannot auto-charge — please top up manually each time.' },
  autoSaved: { th: 'บันทึกแล้ว ✓', en: 'Saved ✓' },
  chargeNow: { th: 'ชาร์จเลยตอนนี้', en: 'Charge now' },
  welcome: { th: 'ยินดีต้อนรับ! คุณกำลังทดลองใช้ฟรี %D% วัน (ถึง %E%)', en: 'Welcome! Your free %D%-day trial is on (until %E%)' },
  welcomeCta: { th: 'ดูแผนของฉัน', en: 'View my plan' },
};
const t = (k) => STR[k][i18n.lang];
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let me = null;
let plans = null;
let addon = null;

async function load() {
  try {
    me = (await api('/api/me', { auth: true })).member;
    if (!plans) { const p = await api('/api/plans'); plans = p.plans; addon = p.addon; }
  } catch {
    session.token = null;
    location.href = '/start.html';
    return;
  }
  document.getElementById('hello').textContent = `${t('hello')} ${me.ownerPhone}`;
  document.getElementById('memberLine').textContent =
    `${planName(me.plan)} · ${t('memberSince')} ${new Date(me.createdAt).toLocaleDateString(i18n.lang === 'th' ? 'th-TH' : 'en-US')}`;
  document.getElementById('statusPills').innerHTML =
    `<span class="kd-pill ${me.forwardingConfirmed ? 'on' : 'warn'}"><span class="dt"></span>${t('fwdStatus')}: ${me.forwardingConfirmed ? t('fwdOn') : t('fwdOff')}</span>` +
    `<span class="kd-pill"><span class="dt" style="background:var(--brand)"></span>${esc(planName(me.plan))}</span>` +
    `<span class="kd-pill"><span class="dt" style="background:var(--warn)"></span>${t('numbersLbl')} ${me.numbers.length}</span>`;

  const tb = document.getElementById('trialBanner');
  if (me.trialDaysLeft > 0) {
    tb.innerHTML = `<div class="trial-banner"><span>${t('trialLeft')} ${me.trialDaysLeft} ${t('days')}</span><a class="btn small dark" href="/pricing.html">${t('changePlan')}</a></div>`;
  } else {
    tb.innerHTML = `<div class="trial-banner over"><span>${t('trialOver')}</span></div>`;
  }
  const wb = document.getElementById('welcomeBanner');
  if (isWelcome && me.trialDaysLeft > 0) {
    const end = new Date(me.trialEndsAt).toLocaleDateString(i18n.lang === 'th' ? 'th-TH' : 'en-US', { day: 'numeric', month: 'short' });
    wb.innerHTML = `<div class="trial-banner"><span>${t('welcome').replace('%D%', me.trialDaysLeft).replace('%E%', end)}</span><a class="btn small dark" href="#sec-plan">${t('welcomeCta')}</a></div>`;
  } else {
    wb.innerHTML = '';
  }
  document.getElementById('cancelledBanner').innerHTML = me.active ? '' : `<div class="alert err">${t('cancelled')}</div>`;

  const setupCard = document.getElementById('setupCard');
  if (!me.forwardingConfirmed) {
    setupCard.style.display = 'block';
    document.getElementById('setupCode').textContent = `**21*${me.aiNumber}#`;
  } else {
    setupCard.style.display = 'none';
  }

  const pm = me.planMeta || plans[me.plan] || { price: 0, quota: 0, numbers: 1, watchers: 0 };
  document.getElementById('plan').innerHTML = `
    <div class="rowline"><span><b>${esc(planName(me.plan))}</b> ${priceStr(pm)}${t('perMonth')}${i18n.lang === 'th' && pm.pppOff ? ` <span class="ppp-mini">PPP for Thai −${pm.pppOff}%</span>` : ''}</span></div>
    <div class="rowline"><span>${t('quota')}</span><b>${pm.quota} ${t('min')} · ${pm.calls || 0} ${t('callsShort')}</b></div>
    <div class="rowline"><span>${t('numbersLbl')}</span><b>${me.numbers.length}/${Math.min(5, pm.numbers + (me.seatsPaid || 0))}</b></div>
    <div class="rowline"><span>${t('watchersLbl')}</span><b>${me.familyWatchers.length}/${pm.watchers}</b></div>
    <div class="plan-pick">
      ${Object.keys(plans).map((p) => `<button data-p="${p}" class="${p === me.plan ? 'on' : ''}">${esc(planName(p))}</button>`).join('')}
    </div>
    <button class="btn primary small" id="payPlanBtn" style="margin-top:10px">${t('payPlan')}</button>
    <div id="payMsg" style="margin-top:8px"></div>`;
  document.querySelectorAll('#plan button[data-p]').forEach((b) => {
    b.onclick = async () => {
      if (b.dataset.p === me.plan) return;
      await api('/api/me/plan', { method: 'POST', auth: true, body: { plan: b.dataset.p } });
      load();
    };
  });
  document.getElementById('payPlanBtn').onclick = async () => {
    const box = document.getElementById('payMsg');
    box.innerHTML = `<div class="alert info">${t('payGo')}</div>`;
    try {
      const s = await api('/api/billing/checkout', {
        method: 'POST', auth: true,
        body: { kind: 'plan', plan: me.plan, region: i18n.lang === 'th' ? 'th' : 'intl' },
      });
      location.href = s.url;
    } catch (e) {
      const unavailable = e.message === 'billing-unconfigured' || e.message === 'price-unconfigured';
      box.innerHTML = `<div class="alert err">${unavailable ? t('payUnavailable') : t('payFailed')}</div>`;
    }
  };

  const usage = await api('/api/me/usage', { auth: true });
  const pct = Math.min(100, Math.round((usage.minutesUsed / Math.max(1, usage.quota)) * 100));
  document.getElementById('usage').innerHTML = `
    <div class="stat-row">
      <div class="stat"><div class="l">${t('used')}</div><div class="n">${usage.minutesUsed}<small style="font-size:13px">/${usage.quota} ${t('minShort')}</small></div><div class="meter"><i style="width:${pct}%"></i></div></div>
      <div class="stat"><div class="l">${t('callsMonth')}</div><div class="n">${usage.callsThisMonth}<small style="font-size:13px">/${usage.callsQuota} ${t('callsShort')}</small></div></div>
      <div class="stat"><div class="l">${t('contacts')}</div><div class="n">${me.whitelisted.length}</div></div>
    </div>`;
  await renderBilling();

  const nums = await api('/api/me/numbers', { auth: true });
  document.getElementById('numbers').innerHTML = nums.numbers.map((n) => `
    <div class="rowline"><div><b style="font-family:var(--mono)">${esc(n)}</b>
      <div class="meta">${t('fwdCode')}: <code>**21*${esc(n)}#</code></div></div>
      <span>${me.forwardingConfirmed ? t('fwdOn') : t('fwdOff')}</span></div>`).join('')
    + `<div class="rowline"><span>${t('numbersLbl')}</span><b>${nums.numbers.length}/${nums.max}</b></div>`
    + (nums.pending || []).map((s) => `<div class="rowline"><div><b style="font-family:var(--mono)">${esc(s.aiNumber)}</b><div class="meta">${esc(s.ownerPhone)}</div></div><span>${t('seatPending')}</span></div>`).join('')
    + `<p style="color:var(--ink3);font-size:13px;margin-top:6px">${t('demoNumNote')}</p>`;
  document.getElementById('numAdd').style.display = nums.numbers.length >= nums.max ? 'none' : '';
  document.getElementById('seatHint').textContent = t('seatHint').replace('%P%', seatPriceNow());

  document.getElementById('lineId').value = me.lineUserId || '';
  document.getElementById('cancelBtn').style.display = me.active ? '' : 'none';
  document.getElementById('reactBtn').style.display = me.active ? 'none' : '';

  renderWhitelist(me.whitelisted);
  renderWatchers(me.familyWatchers);

  const { calls } = await api('/api/me/calls', { auth: true });
  const box = document.getElementById('calls');
  if (!calls.length) {
    box.innerHTML = `<div class="kd-empty">${t('noCalls')}</div>`;
  } else {
    box.innerHTML = '';
    for (const c of calls.slice(0, 20)) {
      const v = c.verdict || {};
      const reason = i18n.lang === 'th' ? (v.reason || '') : (v.reasonEn || v.reason || '');
      const d = document.createElement('div');
      d.className = 'calltape';
      d.innerHTML = `<div class="ch"><div><span class="cn">${esc(c.callerPhone)}</span> <span class="badge ${v.verdict || ''}">${v.verdict || '…'}</span>
        <div class="cm">${new Date(c.startedAt).toLocaleString(i18n.lang === 'th' ? 'th-TH' : 'en-US')} · ${c.turns.length} ${t('turns')}</div>
        <div class="cm">${esc(reason)}</div></div>
        <button class="mini">${t('tape')}</button></div>
        <div class="turns" style="display:none">${c.turns.map((x) => `<div class="turn"><b>${x.role === 'caller' ? t('caller') : t('ai')}</b>${esc(x.text)}</div>`).join('')}</div>`;
      d.querySelector('button').onclick = (e) => {
        const x = d.querySelector('.turns');
        x.style.display = x.style.display === 'none' ? 'block' : 'none';
        e.target.textContent = x.style.display === 'none' ? t('tape') : t('hide');
      };
      box.appendChild(d);
    }
  }
}

let quotaCache = null;

// Topup packs + auto-billing in the usage card (mirrors LIFF billCard).
async function renderBilling() {
  const box = document.getElementById('billing');
  try {
    quotaCache = await api('/api/me/quota', { auth: true });
  } catch {
    box.innerHTML = '';
    return;
  }
  const q = quotaCache;
  const region = i18n.lang === 'th' ? 'th' : 'intl';
  const price = (p) => (i18n.lang === 'th' ? `฿${p.price}` : `$${p.usd}`);
  const a = q.autoTopup || {};
  const b = q.autoTopupBounds || { min: 1, max: 30 };
  const low = q.remaining <= Math.max(5, a.threshold || 5) || a.manualPrompt || a.due;
  const packs = Object.entries(q.packs || {}).map(([id, p]) =>
    `<div class="rowline"><span><b>+${p.minutes} ${t('minShort')} +${p.calls} ${t('callsShort')}</b> · ${price(p)}</span>${q.canTopup ? `<button class="mini" data-pack="${id}">${t('topupBtn')}</button>` : ''}</div>`).join('');
  const cardOnFile = q.payMethod === 'card';
  const note = !a.enabled ? '' : cardOnFile
    ? `<div class="alert ok">${t('autoCardOk')}</div>`
    : `<div class="alert info">${t('autoManualNote')}</div>`;
  box.innerHTML = `
    <div class="rowline"><span><b>${t('topupTitle')}</b><div class="meta">${t('topupDesc')}</div></span></div>
    ${packs}
    ${q.canTopup ? '' : `<div class="alert info">${t('payUnavailable')}</div>`}
    ${low ? `<div class="trial-banner"><span>${t('quotaLow')}</span></div>` : ''}
    <div class="rowline"><span><b>${t('autoTitle')}</b><div class="meta">${t('autoDesc')}</div></span><label><input type="checkbox" id="autoOn"${a.enabled ? ' checked' : ''}> ${t('autoOn')}</label></div>
    <div class="rowline"><span>${t('autoThreshold')}</span><span><button class="mini" id="thDown">−</button> <b id="thVal" data-v="${a.threshold || 5}">${a.threshold || 5} ${t('minShort')}</b> <button class="mini" id="thUp">+</button></span></div>
    <div class="rowline"><span>${t('autoPack')}</span></div>
    <div class="plan-pick">${Object.entries(q.packs || {}).map(([id, p]) => `<button data-apack="${id}" class="${a.pack === id ? 'on' : ''}">+${p.minutes} ${t('minShort')}</button>`).join('')}</div>
    ${note}
    ${a.due ? `<button class="btn primary small" id="chargeNow" style="margin-top:10px">${t('chargeNow')}</button>` : ''}
    <div id="billMsg" style="margin-top:8px"></div>`;
  box.querySelectorAll('[data-pack]').forEach((btn) => { btn.onclick = () => buyPack(btn.dataset.pack, region); });
  document.getElementById('autoOn').onchange = saveAuto;
  box.querySelectorAll('[data-apack]').forEach((btn) => {
    btn.onclick = () => {
      box.querySelectorAll('[data-apack]').forEach((x) => x.classList.toggle('on', x === btn));
      saveAuto();
    };
  });
  document.getElementById('thDown').onclick = () => stepTh(-1, b.min, b.max);
  document.getElementById('thUp').onclick = () => stepTh(1, b.min, b.max);
  const cn = document.getElementById('chargeNow');
  if (cn) cn.onclick = chargeNow;
}

async function buyPack(pack, region) {
  const box = document.getElementById('billMsg');
  box.innerHTML = `<div class="alert info">${t('payGo')}</div>`;
  try {
    const s = await api('/api/billing/checkout', { method: 'POST', auth: true, body: { kind: 'topup', pack, region } });
    location.href = s.url;
  } catch {
    box.innerHTML = `<div class="alert err">${t('payFailed')}</div>`;
  }
}

function stepTh(d, min, max) {
  const el = document.getElementById('thVal');
  const v = Math.min(max, Math.max(min, (Number(el.dataset.v) || 5) + d));
  el.dataset.v = v;
  el.textContent = `${v} ${t('minShort')}`;
  saveAuto();
}

async function saveAuto() {
  const box = document.getElementById('billMsg');
  try {
    await api('/api/me/auto-topup', {
      method: 'POST', auth: true,
      body: {
        enabled: document.getElementById('autoOn').checked,
        threshold: Number(document.getElementById('thVal').dataset.v || 5),
        pack: document.querySelector('[data-apack].on')?.dataset.apack,
      },
    });
    await renderBilling();
    document.getElementById('billMsg').innerHTML = `<div class="alert ok">${t('autoSaved')}</div>`;
  } catch {
    box.innerHTML = `<div class="alert err">${t('payFailed')}</div>`;
  }
}

async function chargeNow() {
  const box = document.getElementById('billMsg');
  try {
    const r = await api('/api/billing/auto-topup/charge', { method: 'POST', auth: true, body: {} });
    await renderBilling();
    document.getElementById('billMsg').innerHTML = r.charged
      ? `<div class="alert ok">${t('payOk')}</div>`
      : `<div class="alert info">${t('autoManualNote')}</div>`;
  } catch {
    box.innerHTML = `<div class="alert err">${t('payFailed')}</div>`;
  }
}

function renderWhitelist(list) {
  const box = document.getElementById('wlList');
  box.innerHTML = list.length ? '' : `<div class="kd-empty">${t('noWl')}</div>`;
  for (const w of list) {
    const d = document.createElement('div');
    d.className = 'rowline';
    d.innerHTML = `<span><b>${esc(w.phone)}</b> <span class="meta">· ${esc(w.label)}${w.safeWord ? ` · safe word: ${esc(w.safeWord)}` : ''}</span></span><button class="mini del">${t('del')}</button>`;
    d.querySelector('button').onclick = async () => {
      await api('/api/me/whitelist', { method: 'DELETE', auth: true, body: { phone: w.phone } });
      load();
    };
    box.appendChild(d);
  }
}

function renderWatchers(list) {
  const box = document.getElementById('wList');
  box.innerHTML = list.length ? '' : `<div class="kd-empty">${t('noWatchers')}</div>`;
  for (const p of list) {
    const d = document.createElement('div');
    d.className = 'rowline';
    d.innerHTML = `<span><b>${esc(p)}</b></span><button class="mini del">${t('del')}</button>`;
    d.querySelector('button').onclick = async () => {
      await api('/api/me/watchers', { method: 'DELETE', auth: true, body: { phone: p } });
      load();
    };
    box.appendChild(d);
  }
}

document.getElementById('wlAdd').onclick = async () => {
  const errBox = document.getElementById('wlErr');
  errBox.innerHTML = '';
  try {
    await api('/api/me/whitelist', {
      method: 'POST', auth: true,
      body: { phone: document.getElementById('wlPhone').value, label: document.getElementById('wlLabel').value, safeWord: document.getElementById('wlSafe').value },
    });
    document.getElementById('wlPhone').value = ''; document.getElementById('wlLabel').value = '';
    load();
  } catch { errBox.innerHTML = `<div class="alert err">${t('badPhone')}</div>`; }
};

document.getElementById('wAdd').onclick = async () => {
  const errBox = document.getElementById('wErr');
  errBox.innerHTML = '';
  try {
    await api('/api/me/watchers', { method: 'POST', auth: true, body: { phone: document.getElementById('wPhone').value } });
    document.getElementById('wPhone').value = '';
    load();
  } catch (e) {
    errBox.innerHTML = `<div class="alert err">${e.message === 'plan-limit' ? t('watcherMaxed') : t('badPhone')}</div>`;
  }
};

let pendingAiNumber = null;

function seatPriceNow() {
  return i18n.lang === 'th' ? `฿${addon.price}` : `$${addon.usd}`;
}

document.getElementById('numAdd').onclick = () => {
  document.getElementById('numErr').innerHTML = '';
  document.getElementById('seatForm').style.display = 'block';
  document.getElementById('seatCodeRow').style.display = 'none';
  document.getElementById('numAdd').style.display = 'none';
};

document.getElementById('seatSend').onclick = async () => {
  const errBox = document.getElementById('seatErr');
  errBox.innerHTML = '';
  try {
    const r = await api('/api/me/numbers', {
      method: 'POST', auth: true,
      body: { ownerPhone: document.getElementById('seatPhone').value },
    });
    pendingAiNumber = r.aiNumber;
    document.getElementById('seatCodeRow').style.display = '';
    errBox.innerHTML = `<div class="alert info">${t('seatSent')}${esc(document.getElementById('seatPhone').value)}${r.devCode ? ` · code: ${esc(r.devCode)}` : ''}</div>`;
  } catch (e) {
    if (e.message === 'seat-payment-required') {
      errBox.innerHTML = `<div class="alert err">${t('seatPay').replace('%P%', seatPriceNow())}</div>
        <button class="btn primary small" id="seatBuyBtn">${t('buySeat').replace('%P%', seatPriceNow())}</button>
        <div id="seatPayMsg" style="margin-top:8px"></div>`;
      document.getElementById('seatBuyBtn').onclick = async () => {
        const box = document.getElementById('seatPayMsg');
        box.innerHTML = `<div class="alert info">${t('payGo')}</div>`;
        try {
          const s = await api('/api/billing/checkout', {
            method: 'POST', auth: true,
            body: { kind: 'seat', region: i18n.lang === 'th' ? 'th' : 'intl' },
          });
          location.href = s.url;
        } catch {
          box.innerHTML = `<div class="alert err">${t('payFailed')}</div>`;
        }
      };
      return;
    }
    const m = { 'plan-limit': t('numMaxed'), 'seat-cap': t('seatCap'), 'invalid-phone': t('badPhone'), 'too-many-requests': t('seatRate'), 'pool-exhausted': t('poolOut') };
    errBox.innerHTML = `<div class="alert err">${m[e.message] || t('poolOut')}</div>`;
  }
};

document.getElementById('seatVerify').onclick = async () => {
  const errBox = document.getElementById('seatErr');
  errBox.innerHTML = '';
  try {
    await api('/api/me/numbers/verify', {
      method: 'POST', auth: true,
      body: { aiNumber: pendingAiNumber, code: document.getElementById('seatCode').value.trim() },
    });
    document.getElementById('seatPhone').value = ''; document.getElementById('seatCode').value = '';
    document.getElementById('seatForm').style.display = 'none';
    load();
  } catch (e) {
    const m = { 'wrong-code': t('seatCodeBad'), 'too-many-attempts': t('seatLocked'), 'seat-not-found': t('seatExpired') };
    errBox.innerHTML = `<div class="alert err">${m[e.message] || t('seatCodeBad')}</div>`;
  }
};

document.getElementById('lineSave').onclick = async () => {
  const box = document.getElementById('lineMsg');
  await api('/api/me/notify', { method: 'POST', auth: true, body: { lineUserId: document.getElementById('lineId').value.trim() } });
  box.innerHTML = `<div class="alert ok">${t('lineSaved')}</div>`;
};

document.getElementById('lineClear').onclick = async () => {
  const box = document.getElementById('lineMsg');
  await api('/api/me/notify', { method: 'POST', auth: true, body: { lineUserId: '' } });
  document.getElementById('lineId').value = '';
  box.innerHTML = `<div class="alert info">${t('lineCleared')}</div>`;
};

document.getElementById('confirmFwd').onclick = async () => {
  await api('/api/me/forwarding', { method: 'POST', auth: true, body: { confirmed: true } });
  load();
};

document.getElementById('stopFwdBtn').onclick = async () => {
  await api('/api/me/forwarding', { method: 'POST', auth: true, body: { confirmed: false } });
  document.getElementById('cancelMsg').innerHTML = `<div class="alert info">${t('fwdStopped')}</div>`;
  load();
};

document.getElementById('cancelBtn').onclick = async () => {
  if (!window.confirm(t('confirmCancel'))) return;
  await api('/api/me/cancel', { method: 'POST', auth: true });
  document.getElementById('cancelMsg').innerHTML = `<div class="alert err">${t('cancelledOk')}</div>`;
  load();
};

document.getElementById('reactBtn').onclick = async () => {
  await api('/api/me/reactivate', { method: 'POST', auth: true });
  document.getElementById('cancelMsg').innerHTML = `<div class="alert ok">${t('reactivated')}</div>`;
  load();
};

// First login (?welcome=1) + Stripe return (?paid=1 / ?cancelled=1):
// one-shot banners, then clean the URL.
const isWelcome = new URLSearchParams(location.search).get('welcome') === '1';
(function payBanner() {
  const p = new URLSearchParams(location.search);
  const paid = p.get('paid'), cancelled = p.get('cancelled');
  if (!paid && !cancelled && !isWelcome) return;
  try { history.replaceState(null, '', location.pathname); } catch { /* keep */ }
  if (!paid && !cancelled) return;
  const extra = paid && p.get('kind') === 'seat' ? `<span>${t('seatBought')}</span>` : '';
  document.getElementById('payBanner').innerHTML = paid
    ? `<div class="trial-banner"><span>${t('payOk')}</span>${extra}</div>`
    : `<div class="trial-banner over"><span>${t('payCancel')}</span></div>`;
})();

// Sidebar drawer (mobile) + active link + logout.
document.getElementById('logoutBtn').onclick = logout;
const sideToggle = document.getElementById('sideToggle');
const setDrawer = (open) => {
  document.body.classList.toggle('side-open', open);
  sideToggle.setAttribute('aria-expanded', String(open));
};
sideToggle.onclick = () => setDrawer(!document.body.classList.contains('side-open'));
document.getElementById('sideOv').onclick = () => setDrawer(false);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setDrawer(false); });
const sideLinks = [...document.querySelectorAll('.side-nav a')];
sideLinks.forEach((a) => a.addEventListener('click', () => {
  sideLinks.forEach((x) => x.classList.toggle('on', x === a));
  setDrawer(false);
}));

window.addEventListener('krai-a:lang', () => { applyLang(); load(); });
load();
