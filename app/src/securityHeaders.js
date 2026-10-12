// Security headers for every response. Session tokens live in localStorage,
// so XSS = account takeover: the CSP allows scripts only from our origin +
// the two third parties we really load (reCAPTCHA, LINE LIFF SDK) — no
// inline script, no eval. Sockets only to this host. No framing, plugins or
// <base> hijack; HTTPS pinned; only our origin may use the microphone.
// Pages must keep scripts in files (test/sec-review.test.js guards it).
//   blob: in media-src  — pre-rendered demo audio is played from blob URLs
//   (the live demo's AudioWorklet is a same-origin file: no blob: scripts)
//   'unsafe-inline' in style-src only — style attributes / <style> blocks
const RECAPTCHA = ['https://www.google.com/recaptcha/', 'https://www.gstatic.com/recaptcha/'];
const LINE_SDK = 'https://static.line-scdn.net';

export function contentSecurityPolicy(host = '') {
  const h = String(host).replace(/[^A-Za-z0-9.:[\]-]/g, ''); // a hostile Host header can't inject directives
  const sockets = h ? [`wss://${h}`, `ws://${h}`] : [];
  const directives = {
    'default-src': ["'self'"],
    'script-src': ["'self'", ...RECAPTCHA, LINE_SDK],
    'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
    'img-src': ["'self'", 'data:', 'blob:', 'https://*.line-scdn.net', 'https://www.gstatic.com'],
    'media-src': ["'self'", 'blob:', 'data:'],
    'connect-src': ["'self'", ...sockets, 'https://www.google.com/recaptcha/', 'https://*.line.me', 'https://*.line-scdn.net'],
    'frame-src': [...RECAPTCHA.slice(0, 1), 'https://recaptcha.google.com/recaptcha/', 'https://*.line.me'],
    'worker-src': ["'self'"],
    'manifest-src': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'report-uri': ['/api/csp-report'],
  };
  return Object.entries(directives).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
}

// Browsers POST violations here: a short, rate-limited log line per report
// (directive + blocked origin), so a blocked script in production is seen.
export function cspReportRoute(take) {
  return (req, res) => {
    const r = req.body?.['csp-report'] || req.body?.[0]?.body || req.body || {};
    if (take('csp:report', 100, 3600000).ok) {
      const clip = (v) => String(v || '').replace(/[\r\n]/g, ' ').slice(0, 120);
      console.warn(`[csp] ${clip(r['violated-directive'] || r.effectiveDirective)} blocked=${clip(r['blocked-uri'] || r.blockedURL)} page=${clip(r['document-uri'] || r.documentURL)}`);
    }
    res.status(204).end();
  };
}

export function securityHeaders() {
  return (req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.set('Content-Security-Policy', contentSecurityPolicy(req.get('host')));
    res.set('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
    next();
  };
}
