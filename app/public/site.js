// Shared site runtime: browser session, TH/EN i18n, nav, reveal, widget.
const TOKEN_KEY = 'krai-a_token';
const LANG_KEY = 'krai-a_lang';

export const session = {
  get token() { return localStorage.getItem(TOKEN_KEY); },
  set token(v) { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); },
  get loggedIn() { return !!this.token; },
};

export const i18n = {
  get lang() { return localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'th'; },
  set lang(v) {
    localStorage.setItem(LANG_KEY, v === 'en' ? 'en' : 'th');
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
  document.querySelectorAll('[data-th-ph]').forEach((el) => {
    el.placeholder = lang === 'th' ? el.dataset.thPh : ('enPh' in el.dataset ? el.dataset.enPh : el.dataset.thPh);
  });
  document.documentElement.lang = lang === 'th' ? 'th' : 'en';
  if (document.body.dataset.titleTh) {
    document.title = lang === 'th' ? document.body.dataset.titleTh : (document.body.dataset.titleEn || document.body.dataset.titleTh);
  }
  document.querySelectorAll('#langToggle button[data-lang]').forEach((b) => {
    b.classList.toggle('on', b.dataset.lang === lang);
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
  if (session.token) api('/api/auth/logout', { method: 'POST', auth: true }).catch(() => {});
  session.token = null;
  location.href = '/';
}

export function initNav(page) {
  document.querySelectorAll('.nav-links a').forEach((a) => {
    if (a.dataset.page === page) a.classList.add('on');
  });
  document.querySelectorAll('#langToggle button[data-lang]').forEach((b) => {
    b.onclick = () => { i18n.lang = b.dataset.lang; };
  });
  document.querySelectorAll('#langToggle select').forEach((s) => {
    s.onchange = () => { i18n.lang = s.value; };
  });
  document.querySelectorAll('#langToggle').forEach(wireLangMenu);
  const slot = document.getElementById('navAuth');
  if (slot) {
    if (session.loggedIn) {
      slot.innerHTML = `<a class="btn small dark" href="/dashboard.html" data-th="ห้องของฉัน" data-en="My account">ห้องของฉัน</a>
        <button class="btn small light" id="logoutBtn" data-th="ออกจากระบบ" data-en="Log out">ออกจากระบบ</button>`;
      document.getElementById('logoutBtn').onclick = logout;
    } else {
      slot.innerHTML = `<a class="btn small light" href="/start.html" data-th="เข้าสู่ระบบ" data-en="Log in">เข้าสู่ระบบ</a>
        <a class="btn small primary" href="/start.html" data-th="เริ่มใช้งาน" data-en="Get started">เริ่มใช้งาน</a>`;
    }
  }
  const navIn = document.querySelector('.nav-in');
  const links = document.querySelector('.nav-links');
  if (navIn && links && !document.querySelector('.hamb')) {
    const hamb = document.createElement('button');
    hamb.className = 'hamb';
    hamb.setAttribute('aria-label', 'Menu');
    hamb.setAttribute('aria-expanded', 'false');
    hamb.innerHTML = '<span></span><span></span><span></span>';
    hamb.onclick = () => {
      const open = document.body.classList.toggle('menu-open');
      hamb.setAttribute('aria-expanded', String(open));
    };
    navIn.insertBefore(hamb, navIn.querySelector('.nav-right'));
    links.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => {
      document.body.classList.remove('menu-open');
      hamb.setAttribute('aria-expanded', 'false');
    }));
  }
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
// Same shape as the classic-script twin in app.js (demo.html): '' means
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

// Demo-start errors mapped to honest user copy (mirrors app.js wording).
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
