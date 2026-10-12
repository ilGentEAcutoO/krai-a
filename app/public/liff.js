// LINE entry: LIFF login -> (known LINE) session -> the shared member app;
// unknown LINE -> verify phone once -> link; ?watch=1 -> family-watcher invite.
import { api, session, i18n, applyLang } from '/site.js';
import { mountMemberApp, mountPhoneOtp, esc, ICON } from '/member-core.js';

// One session key for web + LIFF (older LIFF builds used krai-a-session).
const OLD_KEY = 'krai-a-session';
try {
  const old = localStorage.getItem(OLD_KEY);
  if (old && !session.token) session.token = old;
  localStorage.removeItem(OLD_KEY);
} catch { /* storage blocked */ }

const L = {
  linkH: { th: 'เชื่อม LINE กับเบอร์ของคุณ', en: 'Link LINE to your number' },
  linkP: { th: 'ยืนยันเบอร์มือถือครั้งเดียว จากนั้นสรุปทุกสายที่ AI รับแทนจะส่งเข้า LINE นี้ · ยังไม่เป็นสมาชิก? เบอร์นี้จะเริ่มทดลองฟรี 7 วัน', en: 'Verify your mobile once — then every call summary lands in this LINE. New here? This starts a 7-day free trial.' },
  getCode: { th: 'รับรหัส', en: 'Get code' },
  taken: { th: 'LINE นี้เชื่อมกับเบอร์อื่นแล้ว', en: 'This LINE is already linked to another number.' },
  watchH: { th: 'เป็นผู้ดูแลครอบครัว', en: 'Become a family watcher' },
  watchP: { th: 'ยืนยันเบอร์ที่ครอบครัวเพิ่มไว้ แล้วคุณจะได้แจ้งเตือนทาง LINE ทุกครั้งที่ AI รับสายแทนเขา', en: 'Verify the number your family added — then you get a LINE alert every time the AI answers for them.' },
  watchOk: { th: 'เชื่อมแล้ว ✓', en: 'Linked ✓' },
  watchOkP: { th: 'คุณจะได้แจ้งเตือนใน LINE นี้ทุกครั้งที่ AI รับสายแทนครอบครัว ปิดหน้านี้ได้เลย', en: 'You will get an alert in this LINE whenever the AI answers for your family. You can close this page.' },
  watchCodeLead: { th: 'ถ้าเบอร์นี้อยู่ในรายชื่อผู้ดูแล รหัสจะส่งไปที่', en: 'If this number is on a watcher list, the code goes to' },
  notWatcher: { th: 'เบอร์นี้ยังไม่อยู่ในรายชื่อผู้ดูแล — ให้เจ้าของบัญชีเพิ่มเบอร์คุณก่อน', en: "This number isn't on the watcher list yet — ask the account owner to add it first." },
  openInLine: { th: 'เปิดลิงก์นี้ในแอป LINE', en: 'Open this link in the LINE app' },
  openInLineP: { th: 'หน้านี้ต้องเปิดผ่าน LINE เพื่อยืนยันตัวตน หรือเข้าสู่ระบบด้วยเบอร์มือถือบนเว็บแทน', en: 'This page needs LINE to confirm who you are — or log in with your mobile number on the web.' },
  webLogin: { th: 'เข้าสู่ระบบด้วยเบอร์มือถือ', en: 'Log in with my mobile number' },
  close: { th: 'ปิด', en: 'Close' },
};
const tl = (k) => L[k][i18n.lang];
const app = document.getElementById('app');
const card = (html) => {
  app.innerHTML = `<div class="ma liff"><header class="ma-top"><span class="brand"><span class="dot" aria-hidden="true">ค</span><span>${i18n.lang === 'th' ? 'ใครอะ' : 'Krai-A'}</span></span></header><main class="ma-main"><div class="ma-card" id="box">${html}</div></main></div>`;
  return document.getElementById('box');
};
const isWatch = () => {
  const p = new URLSearchParams(location.search);
  return p.get('watch') === '1' || /watch=1/.test(p.get('liff.state') || '');
};

function mount(inLiff) {
  mountMemberApp(app, {
    platform: 'liff',
    onAuthFail: () => { session.token = null; boot(); },
    linkLine: async () => (inLiff ? liff.getIDToken() : Promise.reject(new Error('line-unavailable'))),
  });
}

function needLine() {
  card(`<div class="ma-empty">${ICON.line}<b>${esc(tl('openInLine'))}</b><p>${esc(tl('openInLineP'))}</p><a class="btn primary" href="/start.html">${esc(tl('webLogin'))}</a></div>`);
}

function linkFlow(idToken) {
  mountPhoneOtp(card(''), {
    title: tl('linkH'), lead: tl('linkP'), cta: tl('getCode'),
    request: (phone) => api('/api/auth/request-otp', { method: 'POST', body: { phone } }),
    verify: async (phone, code) => {
      const v = await api('/api/auth/verify-otp', { method: 'POST', body: { phone, code } });
      session.token = v.token;
      await api('/api/me/link-line', { method: 'POST', auth: true, body: { idToken } });
      return v;
    },
    errorText: (e) => (e.message === 'line-already-linked' ? tl('taken') : ''),
    onDone: () => mount(true),
  });
}

function watcherFlow(idToken) {
  mountPhoneOtp(card(''), {
    title: tl('watchH'), lead: tl('watchP'), cta: tl('getCode'), codeLead: tl('watchCodeLead'),
    request: (phone) => api('/api/watchers/request-otp', { method: 'POST', body: { idToken, phone } }),
    verify: (phone, code) => api('/api/watchers/link', { method: 'POST', body: { idToken, phone, code } }),
    errorText: (e) => (e.message === 'not-a-watcher' ? tl('notWatcher') : ''),
    onDone: () => {
      const box = card(`<div class="ma-empty">${ICON.checkCircle}<b>${esc(tl('watchOk'))}</b><p>${esc(tl('watchOkP'))}</p><button type="button" class="btn secondary" id="closeBtn">${esc(tl('close'))}</button></div>`);
      box.querySelector('#closeBtn').onclick = () => { try { liff.closeWindow(); } catch { history.back(); } };
    },
  });
}

async function boot() {
  applyLang();
  const watch = isWatch();
  let inLiff = false;
  try {
    const st = await api('/api/status');
    if (st.liffId && window.liff) { await liff.init({ liffId: st.liffId }); inLiff = true; }
  } catch { inLiff = false; }
  if (inLiff && !liff.isLoggedIn()) { liff.login({ redirectUri: location.href }); return; }
  if (!inLiff) {
    // Outside LINE (or LIFF unavailable): a web session still opens the same app.
    if (!watch && session.loggedIn) return mount(false);
    return needLine();
  }
  const idToken = liff.getIDToken();
  if (watch || isWatch()) return watcherFlow(idToken);
  if (!session.loggedIn) {
    try {
      const r = await api('/api/auth/line-verify', { method: 'POST', body: { idToken } });
      if (r.needsLink) return linkFlow(idToken);
      session.token = r.token;
    } catch { return needLine(); }
  }
  mount(true);
}
window.addEventListener('krai-a:lang', () => { if (!app.querySelector('.ma-sec')) applyLang(); });
boot();
