// For the PROTECTED person (not the payer): prove this phone with a code
// sent to it, and it leaves the household that protects it. The payer is
// told. Then ##002# on this phone makes calls ring normally again.
import { api, i18n, initNav, captchaToken } from '/site.js';
import { mountPhoneOtp, esc } from '/member-core.js';

initNav('withdraw');
const L = {
  title: { th: 'ถอนความยินยอม ไม่ให้ AI รับสายแทนเบอร์นี้', en: 'Stop the AI answering for this number' },
  lead: { th: 'กรอกเบอร์ของคุณ เราจะส่งรหัสไปที่เบอร์นั้น เพื่อยืนยันว่าเป็นเจ้าของเบอร์ ไม่ต้องสมัครสมาชิก', en: "Enter your number and we'll text it a code to confirm it's yours. No account needed." },
  cta: { th: 'รับรหัส', en: 'Get code' },
  codeLead: { th: 'ถ้าเบอร์นี้มีคนตั้งให้ AI รับสายแทน รหัสจะส่งไปที่', en: 'If someone set the AI to answer for this number, the code goes to' },
  doneH: { th: 'ถอนความยินยอมแล้ว ✓', en: 'Consent withdrawn ✓' },
  doneP: { th: 'AI จะไม่รับสายแทนเบอร์นี้อีก และเราแจ้งคนที่ตั้งให้แล้ว ขั้นสุดท้าย: กด ##002# ที่เครื่องนี้ เพื่อให้สายดังตามปกติ', en: "The AI no longer answers for this number and we told the person who set it up. Last step: dial ##002# on this phone so calls ring normally." },
  noneH: { th: 'เบอร์นี้ไม่ได้อยู่ในการรับสายแทน', en: "This number isn't being answered by the AI" },
  noneP: { th: 'ถ้าเครื่องนี้เคยตั้งโอนสายไว้ กด ##002# เพื่อยกเลิกการโอนสายทั้งหมด', en: 'If this phone ever forwarded calls, dial ##002# to cancel all forwarding.' },
  dial: { th: 'แตะเพื่อยกเลิกการโอนสาย', en: 'Tap to cancel call forwarding' },
};
const tl = (k) => L[k][i18n.lang];
const box = document.getElementById('box');

mountPhoneOtp(box, {
  title: tl('title'), lead: tl('lead'), cta: tl('cta'), codeLead: tl('codeLead'),
  request: async (phone) => {
    const recaptchaToken = await captchaToken('withdraw'); // '' when the gate is off
    return api('/api/withdraw/request-otp', { method: 'POST', body: { phone, ...(recaptchaToken ? { recaptchaToken } : {}) } });
  },
  verify: async (phone, code) => {
    const recaptchaToken = await captchaToken('withdraw');
    return api('/api/withdraw', { method: 'POST', body: { phone, code, ...(recaptchaToken ? { recaptchaToken } : {}) } });
  },
  onDone: (r) => {
    const ok = r?.withdrawn;
    box.innerHTML = `<div class="m-stack"><h1 class="m-h1">${esc(tl(ok ? 'doneH' : 'noneH'))}</h1>
      <p class="m-lead">${esc(tl(ok ? 'doneP' : 'noneP'))}</p>
      <a class="m-dial" href="tel:%23%23002%23"><small>${esc(tl('dial'))}</small><b>##002#</b></a></div>`;
    const h = box.querySelector('h1'); // announce the result to keyboard / screen-reader users
    h.setAttribute('tabindex', '-1');
    h.focus();
  },
});
