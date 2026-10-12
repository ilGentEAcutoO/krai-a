// Signup flow (start.html): phone -> OTP -> who to protect -> forwarding or waitlist.
// External module so the page runs under a strict script-src CSP.
import { api, session, i18n, initNav } from '/site.js';
import { esc, fmtPhone, wireOtp, resendTimer, errText, mountAddPerson, mountForwarding, relationName, isThaiMobile, t as mt } from '/member-core.js';

initNav('start');
if (session.loggedIn) location.replace('/dashboard.html');

const L = {
  devCode: { th: 'โหมดทดสอบ — รหัสคือ', en: 'Test mode — your code is' },
  whichH: { th: 'ให้ AI เฝ้าเครื่องไหน?', en: 'Which phone should the AI guard?' },
  whichP: { th: 'AI จะรับสายแปลกแทนเครื่องนั้น แล้วสรุปให้คุณทาง LINE', en: 'The AI answers unknown calls for that phone and briefs you on LINE.' },
  loved: { th: 'เครื่องของคนที่ฉันรัก', en: "A loved one's phone" },
  lovedSub: { th: 'พ่อแม่ ปู่ย่าตายาย หรือลูก', en: 'Parents, grandparents or kids' },
  self: { th: 'เครื่องนี้ของฉัน', en: 'This phone (mine)' },
  fwdSelf: { th: 'ตั้งโอนสายบนเครื่องนี้', en: 'Set up forwarding on this phone' },
  fwdOther: { th: 'ตั้งโอนสายบนเครื่องของ%N%', en: 'Set up forwarding on %N%’s phone' },
  toApp: { th: 'ไปที่ห้องของฉัน', en: 'Open My dashboard' },
  later: { th: 'ตั้งทีหลังได้ในห้องของฉัน', en: 'You can finish this later in My dashboard' },
  waitH: { th: 'บัญชีพร้อมแล้ว ✓', en: 'Your account is ready ✓' },
  waitP: { th: 'เบอร์กลาง AI ของไทยกำลังเปิด เราจะแจ้งทันทีที่ตั้งโอนสายได้ — ระหว่างนี้เพิ่มคนที่อยากปกป้องไว้ในห้องของฉันได้เลย', en: "Thailand's AI number is opening soon. We'll tell you the moment forwarding opens — meanwhile, add the people you want to protect in My dashboard." },
  waitVia: { th: 'แจ้งฉันทาง', en: 'Notify me by' },
  waitStep: { th: 'รอเบอร์กลาง', en: 'Waitlist' },
  saved: { th: 'บันทึกแล้ว ✓', en: 'Saved ✓' },
  usedH: { th: 'เบอร์นี้เคยใช้ช่วงทดลองฟรีแล้ว', en: 'This number already used its free trial' },
  usedP: { th: 'เลือกแผนเพื่อเริ่มให้ AI รับสายแทน แล้วค่อยตั้งโอนสายหลังชำระเงิน', en: 'Pick a plan to start, then set up call forwarding after paying.' },
  pickPlan: { th: 'เลือกแผน', en: 'Pick a plan' },
  pickPlanStep: { th: 'เลือกแผน', en: 'Pick a plan' },
};
const tl = (k, vars = {}) => { let s = L[k][i18n.lang]; for (const [a, b] of Object.entries(vars)) s = s.split(`%${a}%`).join(b); return s; };

const $ = (id) => document.getElementById(id);
const steps = ['phone', 'otp', 'setup'];
// Each new step takes focus on its heading, so keyboard and screen-reader
// users land on (and hear) the step instead of a focused-but-hidden input.
function focusHeading(el) {
  const h = el?.querySelector('h1, h2');
  if (!h) return;
  h.setAttribute('tabindex', '-1');
  h.focus();
}
function show(panel, step) {
  ['pPhone', 'pOtp', 'pDone', 'pSetup'].forEach((p) => { $(p).hidden = p !== panel; });
  const i = steps.indexOf(step);
  document.querySelectorAll('#suSteps li').forEach((li, k) => {
    li.classList.toggle('done', k < i);
    if (k === i) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
}
show('pPhone', 'phone');

let phone = '';
let busy = false;
let stopTimer = () => {};
const plan = new URLSearchParams(location.search).get('plan') || undefined;
// The pricing page's monthly/yearly pick rides along to checkout in ห้องของฉัน
// (a per-browser preference, like the language).
try {
  const iv = new URLSearchParams(location.search).get('interval');
  if (iv === 'year' || iv === 'month') localStorage.setItem('krai-a_interval', iv);
} catch { /* storage blocked: checkout just defaults to monthly */ }

async function requestCode() {
  const r = await api('/api/auth/request-otp', { method: 'POST', body: { phone } });
  $('devCode').innerHTML = r.devCode ? `<div class="m-dev">${esc(tl('devCode'))} <code>${esc(r.devCode)}</code></div>` : '';
}

$('phoneForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) return;
  const input = $('phone');
  phone = input.value.trim();
  $('phoneErr').textContent = '';
  input.removeAttribute('aria-invalid');
  if (!isThaiMobile(phone)) { // no round-trip for an obviously wrong number
    $('phoneErr').textContent = mt('e_invalid_phone');
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    return;
  }
  busy = true;
  $('sendBtn').disabled = true;
  try {
    await requestCode();
    $('otpPhone').textContent = fmtPhone(phone.replace(/[\s-]/g, '').replace(/^0/, '+66'));
    show('pOtp', 'otp');
    otp.reset();
    $('otpErr').textContent = '';
    $('otp').focus();
    stopTimer();
    stopTimer = resendTimer($('resendBtn'));
  } catch (err) {
    $('phoneErr').textContent = errText(err);
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  } finally { busy = false; $('sendBtn').disabled = false; }
});

$('changeBtn').onclick = () => { stopTimer(); show('pPhone', 'phone'); $('phone').focus(); };
$('resendBtn').onclick = async () => {
  stopTimer();
  $('otpErr').textContent = '';
  try { await requestCode(); stopTimer = resendTimer($('resendBtn')); }
  catch (err) { $('otpErr').textContent = errText(err); stopTimer = resendTimer($('resendBtn'), 0); }
};

const otp = wireOtp($('otp'), async (code) => {
  if (busy) return;
  busy = true;
  $('otpErr').textContent = '';
  try {
    const r = await api('/api/auth/verify-otp', { method: 'POST', body: { phone, code, ...(plan ? { plan } : {}) } });
    session.token = r.token;
    stopTimer();
    initNav('start'); // nav now shows the logged-in state
    show('pDone', 'otp');
    setTimeout(() => (r.trialUsed ? trialUsed() : r.isNew ? setup() : location.replace('/dashboard.html')), 800);
  } catch (err) {
    $('otpErr').textContent = errText(err);
    $('otp').setAttribute('aria-invalid', 'true');
    otp.reset();
    $('otp').focus();
  } finally { busy = false; }
});

// Re-signup of a phone whose free trial was already used (server tombstone):
// no second trial — straight to picking a plan, no forwarding before paying.
function trialUsed() {
  show('pSetup', 'setup');
  document.querySelector('#suSteps li[data-step="setup"]').textContent = tl('pickPlanStep');
  $('pSetup').innerHTML = `<h1 class="m-h1">${esc(tl('usedH'))}</h1><p class="m-lead">${esc(tl('usedP'))}</p>
    <a class="btn primary big m-btn-block" style="margin-top:24px" href="/dashboard.html#settings">${esc(tl('pickPlan'))}</a>`;
  focusHeading($('pSetup'));
}

// ---- step 3: who to protect -> forwarding (or waitlist) ----
let ctl = null;
async function setup() {
  show('pSetup', 'setup');
  const el = $('pSetup');
  let hh;
  try { hh = (await api('/api/me/household', { auth: true })).household; }
  catch { location.replace('/dashboard.html'); return; }
  if (hh.central.state !== 'live') return waitlist(el, hh);
  el.innerHTML = `<h1 class="m-h1">${esc(tl('whichH'))}</h1><p class="m-lead">${esc(tl('whichP'))}</p>
    <div class="m-choices" style="margin-top:24px">
      <button type="button" class="m-choice" id="cLoved"><span class="m-ava">${esc(relationName('mother'))}</span><span class="m-choice-t"><b>${esc(tl('loved'))}</b><span>${esc(tl('lovedSub'))}</span></span></button>
      <button type="button" class="m-choice" id="cSelf"><span class="m-ava">${i18n.lang === 'th' ? 'ฉัน' : 'Me'}</span><span class="m-choice-t"><b>${esc(tl('self'))}</b><span class="tnum">${esc($('otpPhone').textContent)}</span></span></button>
    </div><p class="m-err" role="alert" id="cErr"></p>`;
  focusHeading(el);
  $('cSelf').onclick = async () => {
    try {
      const r = await api('/api/me/protected/self', { method: 'POST', auth: true });
      forwarding(el, r.household, r.household.protected.find((p) => p.self), true);
    } catch (err) { $('cErr').textContent = errText(err); }
  };
  $('cLoved').onclick = () => {
    el.innerHTML = '<div id="addBox"></div>';
    ctl = mountAddPerson($('addBox'), {
      onDone: (household, ph) => forwarding(el, household, household.protected.find((p) => p.phone === ph), false),
    });
    focusHeading($('addBox'));
  };
}

function forwarding(el, hh, person, onThisPhone) {
  ctl?.destroy?.();
  el.innerHTML = `<h1 class="m-h1">${esc(onThisPhone ? tl('fwdSelf') : tl('fwdOther', { N: relationName(person.label) }))}</h1>
    <p class="m-lead tnum">${esc(fmtPhone(person.phone))}</p>
    <div id="fwdBox" style="margin-top:24px"></div>
    <div class="m-stack" style="margin-top:24px"><a class="btn primary big m-btn-block" href="/dashboard.html">${esc(tl('toApp'))}</a>
    <p class="m-fine" style="text-align:center">${esc(tl('later'))}</p></div>`;
  ctl = mountForwarding($('fwdBox'), { central: hh.central, person, onThisPhone });
  focusHeading(el);
}

function waitlist(el, hh) {
  document.querySelector('#suSteps li[data-step="setup"]').textContent = tl('waitStep');
  const ch = hh.waitlist?.channel || 'sms';
  el.innerHTML = `<h1 class="m-h1">${esc(tl('waitH'))}</h1><p class="m-lead">${esc(tl('waitP'))}</p>
    <div class="m-row" style="margin-top:24px"><span class="m-fine">${esc(tl('waitVia'))}</span>
      <div class="ma-seg" role="group" aria-label="${esc(tl('waitVia'))}">
        <button type="button" data-ch="sms" aria-pressed="${ch === 'sms'}">SMS · ${esc($('otpPhone').textContent)}</button>
        <button type="button" data-ch="line" aria-pressed="${ch === 'line'}">LINE</button></div></div>
    <p class="m-fine" id="wMsg" role="status" style="margin-top:8px"></p>
    <a class="btn primary big m-btn-block" style="margin-top:24px" href="/dashboard.html">${esc(tl('toApp'))}</a>`;
  focusHeading(el);
  el.querySelectorAll('[data-ch]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api('/api/me/waitlist', { method: 'POST', auth: true, body: { channel: b.dataset.ch } });
        el.querySelectorAll('[data-ch]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        $('wMsg').textContent = tl('saved');
      } catch (err) { $('wMsg').textContent = errText(err); }
    };
  });
}

