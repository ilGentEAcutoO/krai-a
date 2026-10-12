// Browser-locked sessions + phone OTP auth.
// No passwords: user proves phone ownership via OTP, receives a session token
// stored in browser localStorage. Backend keeps token -> member mapping
// (in-memory now, Firestore later — same interface).
import { randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';
import { sendOtpSms, checkOtpLive, smsMode } from './sms.js';
import { take } from './ratelimit.js';

const sessions = new Map(); // `h:${sha256(token)}` -> { memberId, createdAt, expiresAt } (raw tokens never stored)
const otpCodes = new Map(); // `${purpose}:${phone}` -> { code, expiresAt, attempts }
const otpRequests = new Map(); // phone -> [timestamps] for rate limiting (all purposes)
const verifyPending = new Map(); // phone -> { purpose, expiresAt } (Twilio Verify mode)

const OTP_TTL_MS = 5 * 60 * 1000;
const VERIFY_TTL_MS = 10 * 60 * 1000; // Twilio Verify keeps a code pending 10 min
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const OTP_SENDS_PER_PHONE_HOUR = 5;
const OTP_SENDS_PER_IP_HOUR = 10;
const OTP_SENDS_PER_HOUR = 300;
const OTP_SENDS_PER_DAY = 1000;

// Every OTP is minted for ONE purpose and only verifies for it: a code a
// parent reads out to consent to protection can never log anyone in.
//   login   — phone sign-in (/api/auth/*)
//   seat    — extra household number (/api/me/numbers)
//   protect — add a protected person (central-number households)
//   watcher — link a family watcher's LINE
//   withdraw — a protected person withdraws consent (/withdraw.html)
export const OTP_PURPOSES = Object.freeze(['login', 'seat', 'protect', 'watcher', 'withdraw']);
function otpKey(phone, purpose) {
  if (!OTP_PURPOSES.includes(purpose)) throw new Error(`unknown OTP purpose: ${purpose}`);
  return `${purpose}:${phone}`;
}

// Normalize Thai phones: 08x-xxx-xxxx -> +668x..., keep +66 as-is.
export function normalizePhone(input) {
  const raw = String(input || '').replace(/[\s-]/g, '');
  if (/^\+66\d{8,9}$/.test(raw)) return raw;
  if (/^0\d{8,9}$/.test(raw)) return `+66${raw.slice(1)}`;
  return null;
}

function pruneRequests(phone) {
  const now = Date.now();
  const list = (otpRequests.get(phone) || []).filter((t) => now - t < 3600 * 1000);
  otpRequests.set(phone, list);
  return list;
}

// Mint a code. The per-phone cap counts every purpose (each is one SMS).
export function requestOtp(phone, purpose = 'login') {
  const key = otpKey(phone, purpose);
  if (pruneRequests(phone).length >= OTP_SENDS_PER_PHONE_HOUR) {
    return { ok: false, error: 'too-many-requests', retryAfterMin: 60 };
  }
  pruneRequests(phone).push(Date.now());
  const code = String(randomInt(100000, 1000000)); // CSPRNG: codes must not be predictable
  otpCodes.set(key, { code, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 });
  return { ok: true };
}

// Returns the pending code — ONLY exposed in mock-SMS mode (no Twilio Verify).
export function peekOtpForMockSms(phone, purpose = 'login') {
  return otpCodes.get(otpKey(phone, purpose))?.code || null;
}

export function verifyOtp(phone, code, purpose = 'login') {
  const key = otpKey(phone, purpose);
  const rec = otpCodes.get(key);
  if (!rec || Date.now() > rec.expiresAt) {
    otpCodes.delete(key);
    return { ok: false, error: 'code-expired' };
  }
  rec.attempts += 1;
  if (rec.attempts > MAX_OTP_ATTEMPTS) {
    otpCodes.delete(key);
    return { ok: false, error: 'too-many-attempts' };
  }
  const given = Buffer.from(String(code ?? '').trim());
  const want = Buffer.from(rec.code);
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    return { ok: false, error: 'wrong-code', attemptsLeft: MAX_OTP_ATTEMPTS - rec.attempts };
  }
  otpCodes.delete(key);
  return { ok: true };
}

// The ONE way to text a code: per-IP + global caps (SMS pumping across many
// numbers), the per-phone cap, and no browser-visible mock code in
// production (that would let anyone pass any phone's OTP). Twilio Verify
// resends the SAME pending code for a phone, so while one purpose is pending
// another purpose may not start. `message` (optional) is a server-side
// function code -> SMS text, so each purpose can say what the code is for;
// anything else is ignored (never user text). Returns { ok, mode, devCode? }
// or { ok:false, status, error }.
export async function sendOtp(phone, purpose = 'login', { ip = 'unknown', message } = {}) {
  const key = otpKey(phone, purpose);
  const mode = smsMode();
  if (mode === 'mock' && process.env.NODE_ENV === 'production') {
    console.error('[sms] mock mode in production — refusing to expose OTP');
    return { ok: false, status: 503, error: 'sms-unavailable' };
  }
  if (mode === 'twilio-verify') {
    const pending = verifyPending.get(phone);
    if (pending && pending.expiresAt > Date.now() && pending.purpose !== purpose) {
      return { ok: false, status: 429, error: 'otp-pending' };
    }
  }
  const perIp = take(`otp:ip:${ip}`, OTP_SENDS_PER_IP_HOUR, 3600000);
  const hour = perIp.ok ? take('otp:all', OTP_SENDS_PER_HOUR, 3600000) : perIp;
  const g = hour.ok ? take('otp:day', OTP_SENDS_PER_DAY, 86400000) : hour;
  if (!g.ok) return { ok: false, status: 429, error: 'too-many-requests', retryAfterSec: g.retryAfterSec };
  const minted = requestOtp(phone, purpose);
  if (!minted.ok) return { ok: false, status: 429, error: minted.error };
  const code = otpCodes.get(key)?.code;
  const text = typeof message === 'function' ? String(message(code) || '') : '';
  const sent = await sendOtpSms(phone, code, { text });
  if (!sent.ok) return { ok: false, status: 502, error: 'sms-failed', detail: sent.detail };
  if (mode === 'twilio-verify') verifyPending.set(phone, { purpose, expiresAt: Date.now() + VERIFY_TTL_MS });
  return { ok: true, mode: sent.mode, ...(sent.devCode ? { devCode: sent.devCode } : {}) };
}

// Check a code for its purpose in whichever SMS mode is active.
export async function checkOtp(phone, code, purpose = 'login') {
  otpKey(phone, purpose);
  if (smsMode() !== 'twilio-verify') return verifyOtp(phone, code, purpose);
  const pending = verifyPending.get(phone);
  if (!pending || pending.expiresAt <= Date.now() || pending.purpose !== purpose) {
    return { ok: false, error: 'code-expired' };
  }
  const v = await checkOtpLive(phone, code);
  if (v.ok) verifyPending.delete(phone);
  return v;
}

// Sessions are keyed by a hash of the token: the snapshot (and memory)
// never holds a usable bearer token.
const sessionKey = (token) => `h:${createHash('sha256').update(String(token)).digest('hex')}`;

export function createSession(memberId) {
  const token = randomBytes(32).toString('hex');
  sessions.set(sessionKey(token), { memberId, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

export function getSession(token) {
  if (!token) return null;
  const key = sessionKey(token);
  const s = sessions.get(key);
  if (!s || Date.now() > s.expiresAt) {
    if (s) sessions.delete(key);
    return null;
  }
  return s;
}

export function destroySession(token) {
  sessions.delete(sessionKey(token));
}

// Erasure: log out every device of a member (alias: destroyMemberSessions).
export function destroySessionsFor(memberId) {
  let n = 0;
  for (const [k, s] of sessions) {
    if (s.memberId === memberId) {
      sessions.delete(k);
      n += 1;
    }
  }
  return n;
}
export const destroyMemberSessions = destroySessionsFor;

// Express middleware: attaches req.member or 401s.
// Cancelled members can still read their dashboard (and reactivate) — the
// voice member-gate is what enforces `active` on real calls.
export function requireAuth(getMemberById) {
  return (req, res, next) => {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const s = token && getSession(token);
    if (!s) return res.status(401).json({ error: 'unauthorized' });
    const member = getMemberById(s.memberId);
    if (!member) return res.status(401).json({ error: 'member-inactive' });
    req.member = member;
    next();
  };
}

// ---- persistence (Firestore write-behind; see persist/index.js) ----
// Live OTP codes are never persisted (a pending code just has to be
// re-requested after a deploy); sessions persist as hashes only.
export function serializeAuth() {
  return {
    sessions: [...sessions.entries()],
    otpRequests: [...otpRequests.entries()],
    verifyPending: [...verifyPending.entries()],
  };
}

export function restoreAuth(data = {}) {
  sessions.clear();
  otpCodes.clear();
  otpRequests.clear();
  verifyPending.clear();
  // Legacy snapshots stored raw tokens: hash them on the way in.
  for (const [k, v] of data.sessions || []) sessions.set(String(k).startsWith('h:') ? k : sessionKey(k), v);
  for (const [k, v] of data.otpRequests || []) otpRequests.set(k, v);
  for (const [k, v] of data.verifyPending || []) verifyPending.set(k, v);
}
