// Browser-locked sessions + phone OTP auth.
// No passwords: user proves phone ownership via OTP, receives a session token
// stored in browser localStorage. Backend keeps token -> member mapping
// (in-memory now, Firestore later — same interface).
import { randomBytes } from 'node:crypto';

const sessions = new Map(); // token -> { memberId, createdAt, expiresAt }
const otpCodes = new Map(); // phone -> { code, expiresAt, attempts }
const otpRequests = new Map(); // phone -> [timestamps] for rate limiting

const OTP_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_OTP_ATTEMPTS = 5;

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

export function requestOtp(phone) {
  if (pruneRequests(phone).length >= 5) {
    return { ok: false, error: 'too-many-requests', retryAfterMin: 60 };
  }
  pruneRequests(phone).push(Date.now());
  const code = String(Math.floor(100000 + Math.random() * 900000));
  otpCodes.set(phone, { code, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 });
  return { ok: true };
}

// Returns the pending code — ONLY exposed in mock-SMS mode (no Twilio Verify).
export function peekOtpForMockSms(phone) {
  return otpCodes.get(phone)?.code || null;
}

export function verifyOtp(phone, code) {
  const rec = otpCodes.get(phone);
  if (!rec || Date.now() > rec.expiresAt) {
    otpCodes.delete(phone);
    return { ok: false, error: 'code-expired' };
  }
  rec.attempts += 1;
  if (rec.attempts > MAX_OTP_ATTEMPTS) {
    otpCodes.delete(phone);
    return { ok: false, error: 'too-many-attempts' };
  }
  if (rec.code !== String(code).trim()) {
    return { ok: false, error: 'wrong-code', attemptsLeft: MAX_OTP_ATTEMPTS - rec.attempts };
  }
  otpCodes.delete(phone);
  return { ok: true };
}

export function createSession(memberId) {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { memberId, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

export function getSession(token) {
  const s = sessions.get(token);
  if (!s || Date.now() > s.expiresAt) {
    if (s) sessions.delete(token);
    return null;
  }
  return s;
}

export function destroySession(token) {
  sessions.delete(token);
}

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
export function serializeAuth() {
  return {
    sessions: [...sessions.entries()],
    otpCodes: [...otpCodes.entries()],
    otpRequests: [...otpRequests.entries()],
  };
}

export function restoreAuth(data = {}) {
  sessions.clear();
  otpCodes.clear();
  otpRequests.clear();
  for (const [k, v] of data.sessions || []) sessions.set(k, v);
  for (const [k, v] of data.otpCodes || []) otpCodes.set(k, v);
  for (const [k, v] of data.otpRequests || []) otpRequests.set(k, v);
}
