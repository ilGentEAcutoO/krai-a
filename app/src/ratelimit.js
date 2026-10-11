// In-memory sliding-window rate limiter (per-key).
// Single-instance only: behind N instances the effective cap multiplies by N
// (global keys still bound total spend; per-IP keys are fairness only).
// Memory guard: stale buckets are pruned on access; beyond MAX_KEYS distinct
// keys, new keys pass untracked — a 10k-IP botnet is outside this demo's
// threat model; global caps hold anyway.
const buckets = new Map(); // key -> [timestamps]
const MAX_KEYS = 10000;

export function take(key, max, windowMs, now = Date.now()) {
  let b = buckets.get(key);
  if (b) {
    while (b.length && b[0] <= now - windowMs) b.shift();
    if (!b.length) {
      buckets.delete(key);
      b = null;
    }
  }
  if (!b) {
    if (buckets.size >= MAX_KEYS) return { ok: true, untracked: true };
    b = [];
    buckets.set(key, b);
  }
  if (b.length >= max) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((b[0] + windowMs - now) / 1000)) };
  }
  b.push(now);
  return { ok: true };
}

export function resetLimits() {
  buckets.clear();
}
