// SITE_MODE picks the role of this deploy (read per request, default product):
//   product — the business app (krai-a-app): landing, pricing, signup, member
//             app, LINE / Twilio / Stripe webhooks. Nothing here changes it.
//   demo    — the hackathon site: the call demo at /, live talk to the AI,
//             public stats + status. Every member, pay, LINE, Twilio, OTP and
//             Stripe route answers 404 before any router runs, and product
//             pages bounce to the business host (PRODUCT_BASE_URL).
// Matching ignores case, repeated and trailing slashes — the spellings
// Express routing accepts — so /API//me/ can't slip past the allow-list.
import path from 'node:path';

export const siteMode = () => (String(process.env.SITE_MODE || '').trim().toLowerCase() === 'demo' ? 'demo' : 'product');

export const productBaseUrl = () => (process.env.PRODUCT_BASE_URL || 'https://krai-a.com').replace(/\/+$/, '');

// Firestore snapshot doc per role, so two services never share one: the
// product role keeps the existing member data doc. PERSIST_DOC overrides
// ("off" = in-memory only); anything but collection/doc ids is refused.
export function persistDoc() {
  const v = String(process.env.PERSIST_DOC || '').trim();
  if (v.toLowerCase() === 'off') return null;
  if (v) return /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(v) ? v : null;
  return siteMode() === 'demo' ? 'krai/hackathon' : 'krai/snapshot';
}

const norm = (p) => (String(p).toLowerCase().replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1'));

// Demo-mode API allow-list (prefix match on whole path segments). The text
// demo entries stay behind textDemoGate (404 unless DEMO_TEXT_API=1).
const DEMO_API = ['/api/live', '/api/status', '/api/stats', '/api/csp-report', '/api/demo', '/api/analyze', '/api/calls', '/api/tts'];
const BACKEND = /^\/(api|voice|line)(\/|$)/;

export function demoAllows(p) {
  const n = norm(p);
  return DEMO_API.some((a) => n === a || n.startsWith(`${a}/`));
}

// Hackathon pages served in demo mode; any other .html is a product page.
const DEMO_PAGES = new Set(['/demo.html']);

export function siteModeGate({ publicDir }) {
  const demoPage = path.join(publicDir, 'demo.html');
  return (req, res, next) => {
    if (siteMode() !== 'demo') return next();
    const n = norm(req.path);
    if (BACKEND.test(n)) {
      if (demoAllows(n)) return next();
      return res.status(404).json({ error: 'not found' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (n === '/') return res.sendFile(demoPage);
    if (n.endsWith('.html') && !DEMO_PAGES.has(n)) {
      return res.redirect(302, `${productBaseUrl()}/${req.originalUrl.replace(/^\/+/, '')}`);
    }
    return next();
  };
}
