// Landing page runtime (was inline; external so CSP can be script-src 'self').
import { initNav, api, applyLang } from '/site.js';
initNav('home');

// Pause the phone loop while it is off-screen (CSS-only animation, no network).
const phone = document.getElementById('heroPhone');
new IntersectionObserver(([e]) => phone.classList.toggle('paused', !e.isIntersecting)).observe(phone);

// Price one-liner + trial length come from the plan catalogue (store.js is
// the source of truth) — no numbers are baked into this page.
let catalogue = null;
function paintPlans() {
  if (!catalogue) return;
  const days = Number(catalogue.trial?.days ?? catalogue.trialDays) || 0;
  document.querySelectorAll('[data-tpl]').forEach((el) => {
    if (!days) return;
    el.dataset.th = el.dataset.tplTh.replace('{d}', days);
    el.dataset.en = el.dataset.tplEn.replace('{d}', days);
  });
  const plans = Object.values(catalogue.plans || {});
  if (plans.length) {
    // Cheapest monthly plan covers one person: that is the "per person" price.
    const from = Math.min(...plans.map((p) => Number(p.price) || Infinity)).toLocaleString('en-US');
    const line = document.getElementById('priceLine');
    line.dataset.th = `<span class="ch">เริ่มต้น <b>฿${from}</b> ต่อคนที่คุณดูแล</span>${days ? ` · <span class="ch">ทดลองฟรี ${days} วัน</span>` : ''} <span class="ch">ไม่ต้องผูกบัตร</span>`;
    line.dataset.en = `<span class="ch">From <b>฿${from}</b> per person you look after</span>${days ? ` · <span class="ch">${days}-day free trial</span>` : ''}<span class="ch">, no card needed</span>`;
  }
  applyLang();
}
try { catalogue = await api('/api/plans'); paintPlans(); } catch { /* keep the number-free fallback copy */ }
window.addEventListener('krai-a:lang', paintPlans);
