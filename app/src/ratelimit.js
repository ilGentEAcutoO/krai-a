// In-memory sliding-window rate limiter (per-key).
// Single-instance only: behind N instances the effective cap multiplies by N
// (global keys still bound total spend; per-IP keys are fairness only).
// Flood hardening:
// - per-client keys (`…:ip:<addr>` / `…:phone:<n>`) are normalised: IPv6 by
//   /64, IPv4-mapped unwrapped — rotating addresses inside one /64 buys
//   nothing;
// - expired buckets are swept every minute (unref'd timer) and on demand
//   when the table is full;
// - global keys (no client part) are always counted, even when full;
// - a still-full table puts NEW clients into one shared overflow bucket per
//   scope — degraded, never unlimited.
export const MAX_KEYS = 10000;
const SWEEP_EVERY_MS = 60000;
const CLIENT_PART = /:(ip|phone):/;

const buckets = new Map(); // key -> { hits: [timestamps], windowMs }

// IPv6 -> its /64 ("2001:db8:1:2::/64"); "::ffff:1.2.3.4" -> "1.2.3.4".
export function clientBucket(addr) {
  let a = String(addr || '').trim().toLowerCase();
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return mapped[1];
  if (!a.includes(':') || !/^[0-9a-f:]+$/.test(a)) return a;
  const [head, tail = null] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  if (tail === null && h.length !== 8) return a;
  const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  if (groups.length !== 8 || groups.some((g) => g.length > 4)) return a;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

function normaliseKey(key) {
  const m = CLIENT_PART.exec(key);
  if (!m || m[1] !== 'ip') return key;
  const cut = m.index + m[0].length;
  return key.slice(0, cut) + clientBucket(key.slice(cut));
}

const expired = (b, now) => !b.hits.length || b.hits[b.hits.length - 1] <= now - b.windowMs;

export function sweepBuckets(now = Date.now()) {
  let n = 0;
  for (const [key, b] of buckets) {
    if (expired(b, now)) {
      buckets.delete(key);
      n += 1;
    }
  }
  return n;
}

export function take(rawKey, max, windowMs, now = Date.now()) {
  let key = normaliseKey(rawKey);
  let b = buckets.get(key);
  if (!b && buckets.size >= MAX_KEYS && CLIENT_PART.test(key)) {
    sweepBuckets(now);
    if (buckets.size >= MAX_KEYS) {
      key = `${key.slice(0, CLIENT_PART.exec(key).index)}:~overflow`;
      b = buckets.get(key);
    }
  }
  if (!b) {
    b = { hits: [], windowMs };
    buckets.set(key, b);
  }
  b.windowMs = Math.max(b.windowMs, windowMs);
  while (b.hits.length && b.hits[0] <= now - windowMs) b.hits.shift();
  if (b.hits.length >= max) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((b.hits[0] + windowMs - now) / 1000)) };
  }
  b.hits.push(now);
  return { ok: true };
}

export const bucketCount = () => buckets.size;

export function resetLimits() {
  buckets.clear();
}

setInterval(() => sweepBuckets(), SWEEP_EVERY_MS).unref?.();
