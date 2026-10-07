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
  document.querySelectorAll('#langToggle button').forEach((b) => {
    b.classList.toggle('on', b.dataset.lang === lang);
  });
  // keep the unused-lang attribute tree intact for crawlers: nothing to hide
  void other;
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
  document.querySelectorAll('#langToggle button').forEach((b) => {
    b.onclick = () => { i18n.lang = b.dataset.lang; };
  });
  const slot = document.getElementById('navAuth');
  if (slot) {
    if (session.loggedIn) {
      slot.innerHTML = `<a class="btn small dark" href="/dashboard.html" data-th="ห้องของฉัน" data-en="My account">ห้องของฉัน</a>
        <button class="btn small light" id="logoutBtn" data-th="ออกจากระบบ" data-en="Log out">ออกจากระบบ</button>`;
      document.getElementById('logoutBtn').onclick = logout;
    } else {
      slot.innerHTML = `<a class="btn small primary" href="/demo.html" data-th="ลองเดโมสด" data-en="Live demo">ลองเดโมสด</a>`;
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
