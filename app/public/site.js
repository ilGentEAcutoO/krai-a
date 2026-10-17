// Shared site runtime: browser session, TH/EN i18n, nav, reveal, widget.
const TOKEN_KEY = 'krai-a_token';
const LANG_KEY = 'krai-a_lang';

export const session = {
  get token() { return localStorage.getItem(TOKEN_KEY); },
  set token(v) { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); },
  get loggedIn() { return !!this.token; },
};

// `?lang=en|th` in the URL wins once and is remembered (shareable EN links).
function langFromUrl() {
  try {
    const q = new URLSearchParams(globalThis.location?.search || '').get('lang');
    if (q === 'en' || q === 'th') localStorage.setItem(LANG_KEY, q);
  } catch { /* no location / storage: keep the stored choice */ }
}

export const i18n = {
  // A stored choice wins; otherwise the page's <html data-default-lang> (the
  // hackathon page defaults to English for judges), else Thai.
  get lang() {
    try {
      const v = localStorage.getItem(LANG_KEY);
      if (v === 'en' || v === 'th') return v;
    } catch { /* storage blocked: fall through to the page default */ }
    return globalThis.document?.documentElement?.dataset?.defaultLang === 'en' ? 'en' : 'th';
  },
  set lang(v) {
    try { localStorage.setItem(LANG_KEY, v === 'en' ? 'en' : 'th'); } catch { /* private mode: this page only */ }
    applyLang();
    window.dispatchEvent(new CustomEvent('krai-a:lang'));
  },
};

export function applyLang() {
  const lang = i18n.lang;
  const other = lang === 'th' ? 'en' : 'th';
  document.querySelectorAll('[data-th]').forEach((el) => {
    // data-en="" is valid (hide in EN) — only fall back when the attribute is absent.
    const v = lang === 'th' ? el.dataset.th : ('en' in el.dataset ? el.dataset.en : el.dataset.th);
    if (v !== undefined && el.innerHTML !== v) el.innerHTML = v;
  });
  document.querySelectorAll('[data-aria-th]').forEach((el) => {
    el.setAttribute('aria-label', lang === 'th' ? el.dataset.ariaTh : (el.dataset.ariaEn || el.dataset.ariaTh));
  });
  document.querySelectorAll('[data-th-ph]').forEach((el) => {
    el.placeholder = lang === 'th' ? el.dataset.thPh : ('enPh' in el.dataset ? el.dataset.enPh : el.dataset.thPh);
  });
  document.documentElement.lang = lang === 'th' ? 'th' : 'en';
  if (document.body.dataset.titleTh) {
    document.title = lang === 'th' ? document.body.dataset.titleTh : (document.body.dataset.titleEn || document.body.dataset.titleTh);
  }
  document.querySelectorAll('#langToggle button[data-lang], [data-lang-toggle] button[data-lang]').forEach((b) => {
    b.classList.toggle('on', b.dataset.lang === lang);
    b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
  });
  document.querySelectorAll('#langToggle select').forEach((s) => {
    if (s.value !== lang) s.value = lang;
  });
  document.querySelectorAll('#langToggle').forEach((root) => {
    const cur = root.querySelector('[data-lang-cur]');
    if (cur) {
      const label = lang === 'th' ? 'ไทย' : 'English';
      if (cur.textContent !== label) cur.textContent = label;
    }
    root.querySelectorAll('[role="option"][data-lang]').forEach((o) => {
      o.setAttribute('aria-selected', String(o.dataset.lang === lang));
    });
  });
  // keep the unused-lang attribute tree intact for crawlers: nothing to hide
  void other;
}

function wireLangMenu(root) {
  const btn = root.querySelector('.lang-btn');
  const menu = root.querySelector('.lang-menu');
  if (!btn || !menu || root.dataset.wired) return;
  root.dataset.wired = '1';
  const opts = [...menu.querySelectorAll('[role="option"][data-lang]')];
  const isOpen = () => !menu.hidden;
  const close = (focusBtn) => {
    if (!isOpen()) return;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (focusBtn) btn.focus();
  };
  const open = (focusSel) => {
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    if (focusSel) {
      const sel = opts.find((o) => o.dataset.lang === i18n.lang) || opts[0];
      sel?.focus();
    }
  };
  const pick = (o) => {
    i18n.lang = o.dataset.lang;
    close(true);
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    isOpen() ? close() : open(false);
  });
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        isOpen() ? close() : open(true);
      } else {
        e.preventDefault();
        if (!isOpen()) open(true);
      }
    }
  });
  opts.forEach((o, i) => {
    o.addEventListener('click', (e) => { e.stopPropagation(); pick(o); });
    o.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); opts[(i + 1) % opts.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); opts[(i - 1 + opts.length) % opts.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); opts[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); opts[opts.length - 1].focus(); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(o); }
      else if (e.key === 'Escape') { e.preventDefault(); close(true); }
      else if (e.key === 'Tab') { close(); }
    });
  });
  document.addEventListener('click', (e) => { if (isOpen() && !root.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close(true); });
  root.addEventListener('focusout', (e) => { if (isOpen() && !root.contains(e.relatedTarget)) close(); });
}

export async function api(path, { method = 'GET', body, auth = false } = {}) {
  const headers = {};
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (auth && session.token) headers.Authorization = `Bearer ${session.token}`;
  const res = await fetch(path, { method, headers, body: payload });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data, status: res.status });
  return data;
}

export function logout() {
  // keepalive: the request must outlive the navigation below.
  if (session.token) {
    fetch('/api/auth/logout', { method: 'POST', keepalive: true, headers: { Authorization: `Bearer ${session.token}` } }).catch(() => {});
  }
  session.token = null;
  location.href = '/';
}

// Site chrome: every public page shares one nav + one footer, rendered here.
// Pages ship empty `<nav class="nav"></nav>` / `<footer class="foot"></footer>`
// shells; any nav/footer that already carries data-v is left untouched.
// Nav = brand · ฟังสายจริง · วิธีตั้งค่า · ราคา · ลองคุยกับ AI (demo.krai-a.com) · TH|EN · [เริ่มใช้ฟรี]; login
// is a small text link; the footer repeats the language switch.
const CHROME_V = '3';

const NAV_HTML = `<div class="nav-in">
  <a class="brand" href="/"><img class="brand-logo" src="/brand/sornkan-logo.png" alt="" width="32" height="31"><span data-th="ใครอะ" data-en="KRAI-A">ใครอะ</span></a>
  <div class="nav-links" id="navLinks">
    <a href="/#listen" data-th="ฟังสายจริง" data-en="Hear a call">ฟังสายจริง</a>
    <a href="/#setup" data-th="วิธีตั้งค่า" data-en="How it works">วิธีตั้งค่า</a>
    <a data-page="pricing" href="/pricing.html" data-th="ราคา" data-en="Pricing">ราคา</a>
    <a href="https://demo.krai-a.com" data-th="ลองคุยกับ AI" data-en="Try the demo">ลองคุยกับ AI</a>
    <span id="navSheetAuth" class="nav-sheet-slot"></span>
  </div>
  <div class="nav-lang" data-lang-toggle role="group" aria-label="ภาษา / Language"><button type="button" data-lang="th" lang="th" aria-pressed="true">TH</button><button type="button" data-lang="en" lang="en" aria-pressed="false">EN</button></div>
  <div class="nav-right" id="navAuth"></div>
  <button type="button" class="hamb" aria-controls="navLinks" aria-expanded="false" aria-label="เมนู / Menu"><span></span><span></span></button>
</div>`;

const FOOT_HTML = `<div class="foot-in">
  <div class="foot-brand">
    <a class="brand" href="/"><img class="brand-logo" src="/brand/sornkan-logo.png" alt="" width="32" height="31"><span data-th="ใครอะ" data-en="KRAI-A">ใครอะ</span></a>
    <p data-th="AI รับสายแปลกแทนคนที่คุณรัก คุยสุภาพ จับมุกมิจ แล้วสรุปให้คุณ" data-en="AI answers unknown calls for the people you love — politely, catching scam scripts, then briefing you.">AI รับสายแปลกแทนคนที่คุณรัก คุยสุภาพ จับมุกมิจ แล้วสรุปให้คุณ</p>
  </div>
  <nav class="foot-links" aria-label="Footer">
    <a href="/#listen" data-th="ฟังสายจริง" data-en="Hear a call">ฟังสายจริง</a>
    <a href="/#setup" data-th="วิธีตั้งค่า" data-en="How it works">วิธีตั้งค่า</a>
    <a href="/pricing.html" data-th="ราคา" data-en="Pricing">ราคา</a>
    <a href="/#faq" data-th="คำถามที่พบบ่อย" data-en="FAQ">คำถามที่พบบ่อย</a>
    <a href="/start.html" data-th="สมัคร / เข้าสู่ระบบ" data-en="Sign up / Log in">สมัคร / เข้าสู่ระบบ</a>
  </nav>
  <div class="lang-seg" id="langToggle" role="group" aria-label="ภาษา / Language">
    <button type="button" data-lang="th" lang="th" aria-pressed="true">ไทย</button><button type="button" data-lang="en" lang="en" aria-pressed="false">English</button>
  </div>
</div>
<div class="foot-base"><span data-th="© 2026 ใครอะ" data-en="© 2026 KRAI-A">© 2026 ใครอะ</span><span data-th="รับเฉพาะสายที่คุณโอนมา ไม่ยุ่งกับสายอื่นในมือถือคุณ" data-en="Only calls you forward reach us — nothing else on your phone.">รับเฉพาะสายที่คุณโอนมา ไม่ยุ่งกับสายอื่นในมือถือคุณ</span></div>`;

function renderChrome() {
  // Only empty shells are filled: a page that ships its own chrome (any
  // data-v, e.g. the hackathon demo page) keeps it — no product links there.
  const nav = document.querySelector('nav.nav');
  if (nav && nav.dataset.v === undefined) {
    nav.innerHTML = NAV_HTML;
    nav.dataset.v = CHROME_V;
  }
  const foot = document.querySelector('footer.foot');
  if (foot && foot.dataset.v === undefined) {
    foot.innerHTML = FOOT_HTML;
    foot.dataset.v = CHROME_V;
  }
}

function renderNavAuth(page) {
  const slot = document.getElementById('navAuth');
  const sheet = document.getElementById('navSheetAuth');
  if (!slot) return;
  if (session.loggedIn) {
    slot.innerHTML = `<button type="button" class="nav-text" data-logout data-th="ออกจากระบบ" data-en="Log out">ออกจากระบบ</button>
      <a class="btn small secondary" href="/dashboard.html" data-th="ห้องของฉัน" data-en="Dashboard">ห้องของฉัน</a>`;
    if (sheet) sheet.innerHTML = `<a class="nav-sheet-only" href="/dashboard.html" data-th="ห้องของฉัน" data-en="Dashboard">ห้องของฉัน</a>
      <button type="button" class="nav-sheet-only nav-text" data-logout data-th="ออกจากระบบ" data-en="Log out">ออกจากระบบ</button>`;
  } else {
    // The signup page is its own CTA: no second primary button above it.
    // Secondary style: each page's own CTA is the one ink primary on screen.
    const cta = page === 'start' ? '' : `<a class="btn small secondary" href="/start.html" data-th="เริ่มใช้ฟรี" data-en="Start free">เริ่มใช้ฟรี</a>`;
    slot.innerHTML = `<a class="nav-text" href="/start.html" data-th="เข้าสู่ระบบ" data-en="Log in">เข้าสู่ระบบ</a>${cta}`;
    if (sheet) sheet.innerHTML = `<a class="nav-sheet-only" href="/start.html" data-th="เข้าสู่ระบบ" data-en="Log in">เข้าสู่ระบบ</a>`;
  }
  document.querySelectorAll('[data-logout]').forEach((b) => { b.onclick = logout; });
}

function wireMenu() {
  const hamb = document.querySelector('.nav .hamb');
  const links = document.getElementById('navLinks');
  if (!hamb || !links || hamb.dataset.wired) return;
  hamb.dataset.wired = '1';
  const set = (open) => {
    document.body.classList.toggle('menu-open', open);
    hamb.setAttribute('aria-expanded', String(open));
  };
  hamb.onclick = (e) => { e.stopPropagation(); set(!document.body.classList.contains('menu-open')); };
  links.addEventListener('click', (e) => { if (e.target.closest('a,button')) set(false); });
  document.addEventListener('click', (e) => {
    if (document.body.classList.contains('menu-open') && !e.target.closest('.nav')) set(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('menu-open')) { set(false); hamb.focus(); }
  });
}

export function initNav(page) {
  langFromUrl();
  renderChrome();
  document.querySelectorAll('.nav-links a').forEach((a) => {
    const on = a.dataset.page === page;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page');
  });
  document.querySelectorAll('#langToggle button[data-lang], [data-lang-toggle] button[data-lang]').forEach((b) => {
    b.onclick = () => { i18n.lang = b.dataset.lang; };
  });
  document.querySelectorAll('#langToggle select').forEach((s) => {
    s.onchange = () => { i18n.lang = s.value; };
  });
  document.querySelectorAll('#langToggle').forEach(wireLangMenu);
  renderNavAuth(page);
  wireMenu();
  applyLang();
}

export function initReveal() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.querySelectorAll('.rv').forEach((el) => el.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { threshold: 0.12 });
  document.querySelectorAll('.rv').forEach((el) => io.observe(el));
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Trust stats: thousands-grouped figure + "more than" affix per language.
// The API already floors to round tiers and gates weak numbers via `shown`.
export function formatCount(n) {
  return Math.max(0, Math.floor(Number(n) || 0)).toLocaleString('en-US');
}

export function bragFigure(display) {
  const f = formatCount(display);
  return i18n.lang === 'th' ? `กว่า ${f}` : `${f}+`;
}

// reCAPTCHA v3 (invisible): one token per demo start, verified server-side.
// Used by the demo stage (demo.js) and live session start: '' means
// "no token" (gate disabled, script blocked, or execute failed) and the
// caller omits the field — the server then fails closed with a friendly
// client-side message, never silently.
const captcha = { siteKey: null, scriptLoading: null }; // null key = not fetched yet

async function captchaKey() {
  if (captcha.siteKey !== null) return captcha.siteKey;
  try {
    const st = await api('/api/status');
    captcha.siteKey = st.recaptchaSiteKey || '';
  } catch {
    captcha.siteKey = '';
  }
  return captcha.siteKey;
}

function loadRecaptcha(key) {
  if (window.grecaptcha) return Promise.resolve(true);
  if (!captcha.scriptLoading) {
    captcha.scriptLoading = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(key)}`;
      s.async = true;
      s.defer = true;
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
  }
  return captcha.scriptLoading;
}

export async function captchaToken(action) {
  const key = await captchaKey();
  if (!key) return '';
  const loaded = await loadRecaptcha(key);
  if (!loaded || !window.grecaptcha) return '';
  try {
    await new Promise((resolve) => window.grecaptcha.ready(resolve));
    return await window.grecaptcha.execute(key, { action });
  } catch {
    return '';
  }
}

// Demo-start errors mapped to honest user copy (shared by demo.js).
export function demoStartMessage(e) {
  const m = String(e?.data?.error || e?.message || e || '');
  if (m.includes('demo-rate-limited')) {
    return i18n.lang === 'th'
      ? 'คนกำลังลองเยอะมาก — demo เต็มโควตาชั่วโมงนี้ รอสักพักแล้วกดเล่นใหม่นะ'
      : 'Busy hour — the demo quota is full. Wait a bit, then replay.';
  }
  if (m.includes('captcha-required')) {
    return i18n.lang === 'th'
      ? 'โหลดตัวกันบอทไม่ได้ — ถ้าเปิด adblock อยู่ ปิดแล้วลองใหม่'
      : "Couldn't load the bot check — disable adblock and retry.";
  }
  if (m.includes('captcha-')) {
    return i18n.lang === 'th'
      ? 'โดนมองว่าเป็นบอท — ลองใหม่ในอีกสักพัก'
      : 'Flagged as a bot — try again later.';
  }
  return null; // caller falls back to its generic connection message
}
