// Twilio webhook authentication: X-Twilio-Signature = base64(HMAC-SHA1(
// authToken, fullUrl + each POST param name+value sorted by name)).
// Without this, anyone could POST fake calls/transcripts to /voice/*.
// The signed URL is whatever Twilio requested, so candidates come from
// PUBLIC_BASE_URL and from the request host (custom domain vs run.app) —
// accepting either is safe: forging a match still needs the auth token.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

export function twilioSignatureFor(authToken, url, params = {}) {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    const v = params[key];
    // Repeated keys: Twilio signs each distinct value, sorted.
    const values = Array.isArray(v) ? [...new Set(v)].sort() : [v];
    for (const one of values) data += key + (one ?? '');
  }
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

// https://host:443/x and https://host/x are the same URL to Twilio.
function portVariants(url) {
  const out = [url];
  try {
    const u = new URL(url);
    const dflt = u.protocol === 'https:' ? '443' : '80';
    if (u.port) {
      u.port = '';
      out.push(u.toString());
    } else {
      out.push(url.replace(`${u.protocol}//${u.host}`, `${u.protocol}//${u.host}:${dflt}`));
    }
  } catch { /* malformed base: exact string only */ }
  return out;
}

function candidateUrls(req) {
  const path = req.originalUrl || req.url;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const hosts = [req.headers['x-forwarded-host'], req.headers.host]
    .map((h) => String(h || '').split(',')[0].trim()).filter(Boolean);
  const bases = [config.publicBaseUrl, ...hosts.map((h) => `${proto}://${h}`)].filter(Boolean);
  return [...new Set(bases.flatMap((b) => portVariants(`${b.replace(/\/$/, '')}${path}`)))];
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function isValidTwilioRequest(req, authToken = config.twilioAuthToken) {
  const sig = req.headers['x-twilio-signature'];
  if (!authToken || !sig) return false;
  const params = req.body && typeof req.body === 'object' ? req.body : {};
  return candidateUrls(req).some((url) => safeEqual(twilioSignatureFor(authToken, url, params), sig));
}

// Mount before every /voice/* handler (after express.urlencoded). No token
// configured fails closed, except under NODE_ENV=test for local suites.
export function twilioSignature() {
  return (req, res, next) => {
    if (!config.twilioAuthToken && process.env.NODE_ENV === 'test') return next();
    if (isValidTwilioRequest(req)) return next();
    console.warn(`[voice] 403 bad twilio signature ${req.method} ${req.path}`);
    res.status(403).type('text/plain').send('invalid signature');
  };
}
