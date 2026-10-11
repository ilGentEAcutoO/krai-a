// In-memory stores with a Firestore-compatible shape.
// Demo runs fully in memory; production swaps this module for Firestore
// without touching callers (same method names, same record shape).
// Record shapes:
//   member: { id, ownerPhone, aiNumber, plan, minutesUsed, quotaPeriod, quotaWarnedPeriod, topupMinutes, topupCalls, autoTopup:{enabled,threshold,pack}, stripeCustomerId, payMethod, billingRegion, whitelisted:[{phone,label,safeWord}], familyWatchers:[phone], createdAt }
//   call:   { id, memberId, callerPhone, aiNumber, startedAt, endedAt, turns:[{role,text,at}], verdict, minutesBilled }

import { releaseNumber } from './numbers.js';
import { recordCallEnd, recordMemberJoin, snapshotStats, restoreStats, backfillFromCalls } from './stats.js';

const members = new Map(); // key: aiNumber (mode A) — mode B also indexes ForwardedFrom
const membersByOwner = new Map(); // key: ownerPhone
const calls = new Map(); // key: callId
const rejectCounts = new Map(); // key: `${yyyymmdd}:${caller}` -> n
let callSeq = 0;

// Plans: starter ฿20 → plus ฿100 → family ฿149. Trial 7 days.
// One AI number serves the whole system; `numbers` = protected phone numbers,
// `calls` = max screened calls/mo, `tapes` = recordings + transcripts included.
// Family matches Plus quota — the +฿49 buys household control (2nd number + 2 watchers).
// price = THB PPP price for Thailand; usd = global standard price displayed in EN.
export const PLANS = {
  'starter-20': { price: 20, usd: 2, pppOff: 71, quota: 10, calls: 5, numbers: 1, watchers: 0, tapes: false },
  'plus-100': { price: 100, usd: 6, pppOff: 52, quota: 50, calls: 25, numbers: 1, watchers: 0, tapes: true },
  'family-149': { price: 149, usd: 8, pppOff: 47, quota: 50, calls: 25, numbers: 2, watchers: 2, tapes: true },
};
// Extra household seat (Family add-on): +1 protected number with its own
// Plus-sized chunk, pooled into the household quota.
// Priced at full-use variable cost (~฿69): absolute worst case breaks even,
// typical use (~40%) is strongly profitable. Keeps bundle discount vs Plus.
export const ADDON_SEAT = { price: 69, usd: 3, quota: 50, calls: 25, numbers: 1 };
export const SEAT_TTL_MS = 10 * 60 * 1000; // pending seats die with their OTP window
// One-time topup packs: extra screening minutes + calls on top of the plan quota (coupled).
// Never expire, never reset — pooled into the household total until burned.
// TH prices clear PromptPay's ฿20 minimum, so packs offer card + PromptPay.
export const TOPUP_PACKS = {
  'topup-small': { minutes: 10, calls: 5, price: 29, usd: 2 },
  'topup-medium': { minutes: 30, calls: 15, price: 69, usd: 5 },
};
// Auto-topup guardrails: threshold = "charge when remaining drops to N min".
export const AUTO_TOPUP_MIN_THRESHOLD = 1;
export const AUTO_TOPUP_MAX_THRESHOLD = 30;
export const AUTO_TOPUP_DEFAULT_THRESHOLD = 5;
// Hard cap: 5 protected numbers per household (Family 2 + 3 seats).
// Beyond that, start a new household (new subscription).
export const MAX_HOUSEHOLD_SEATS = 5;
export const TRIAL_DAYS = 7;
export const planOf = (m) => PLANS[m?.plan] || PLANS['starter-20'];
export const trialDaysLeft = (m) => {
  if (!m?.trialEndsAt) return 0;
  return Math.max(0, Math.ceil((Date.parse(m.trialEndsAt) - Date.now()) / 86400000));
};

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// ---- quota model (minutes + calls per PLANS, pooled, monthly reset) ----
// Total = plan quota + paid seats' chunks + topup packs. minutesUsed counts
// within the current calendar month (quotaPeriod 'YYYY-MM'); topupMinutes
// never resets. Old records without quotaPeriod roll into the current
// period on first touch (used minutes restart — documented, one-time).
export function quotaPeriodKey(nowMs = Date.now()) {
  return new Date(nowMs).toISOString().slice(0, 7);
}

export function quotaResetAt(nowMs = Date.now()) {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

export function ensureQuotaPeriod(m, nowMs = Date.now()) {
  if (!m) return m;
  const key = quotaPeriodKey(nowMs);
  if (m.quotaPeriod !== key) {
    m.quotaPeriod = key;
    m.minutesUsed = 0;
  }
  if (typeof m.topupMinutes !== 'number' || m.topupMinutes < 0) m.topupMinutes = 0;
  if (typeof m.topupCalls !== 'number' || m.topupCalls < 0) m.topupCalls = 0;
  return m;
}

export function quotaTotal(m) {
  const base = planOf(m).quota || 0;
  const seats = (m?.seatsPaid || 0) * ADDON_SEAT.quota;
  return base + seats + (m?.topupMinutes || 0);
}

export function callsQuotaTotal(m) {
  const base = planOf(m).calls || 0;
  return base + (m?.seatsPaid || 0) * ADDON_SEAT.calls + (m?.topupCalls || 0);
}

export function callsUsedThisPeriod(memberId, nowMs = Date.now()) {
  const prefix = quotaPeriodKey(nowMs);
  let n = 0;
  for (const c of calls.values()) {
    if (c.memberId === memberId && String(c.startedAt || '').startsWith(prefix)) n += 1;
  }
  return n;
}

// Single consumption entry point: roll the period, then burn minutes.
export function consumeMinutes(m, minutes, nowMs = Date.now()) {
  ensureQuotaPeriod(m, nowMs);
  m.minutesUsed = Math.max(0, (m.minutesUsed || 0) + Math.max(0, Number(minutes) || 0));
  return quotaSummary(m, nowMs);
}

export function grantTopup(m, packId) {
  const pack = TOPUP_PACKS[packId];
  if (!m || !pack) return { granted: false, reason: !m ? 'unknown-member' : 'unknown-pack' };
  ensureQuotaPeriod(m);
  m.topupMinutes = (m.topupMinutes || 0) + pack.minutes;
  m.topupCalls = (m.topupCalls || 0) + (pack.calls || 0);
  return { granted: true, pack: packId, minutes: pack.minutes, calls: pack.calls || 0, topupMinutes: m.topupMinutes, topupCalls: m.topupCalls };
}

export function setAutoTopup(m, { enabled, threshold, pack } = {}) {
  if (!m) return null;
  const cur = m.autoTopup && typeof m.autoTopup === 'object' ? m.autoTopup : {};
  const next = {
    enabled: enabled === undefined ? !!cur.enabled : !!enabled,
    threshold: AUTO_TOPUP_DEFAULT_THRESHOLD,
    pack: TOPUP_PACKS[pack] ? pack : (TOPUP_PACKS[cur.pack] ? cur.pack : 'topup-small'),
  };
  const t = threshold === undefined ? cur.threshold : Number(threshold);
  next.threshold = Number.isFinite(t)
    ? Math.min(AUTO_TOPUP_MAX_THRESHOLD, Math.max(AUTO_TOPUP_MIN_THRESHOLD, Math.round(t)))
    : AUTO_TOPUP_DEFAULT_THRESHOLD;
  m.autoTopup = next;
  return next;
}

// Full quota picture for GET /me/quota + LIFF meter. due=true means "charge
// now" (card on file); manualPrompt=true means "show the top-up button"
// (PromptPay/unknown method can never be charged off-session).
export function quotaSummary(m, nowMs = Date.now()) {
  ensureQuotaPeriod(m, nowMs);
  const quota = quotaTotal(m);
  const used = m?.minutesUsed || 0;
  const remaining = Math.max(0, quota - used);
  const callsQuota = callsQuotaTotal(m);
  const callsUsed = m ? callsUsedThisPeriod(m.id, nowMs) : 0;
  const callsRemaining = Math.max(0, callsQuota - callsUsed);
  const auto = m?.autoTopup && typeof m.autoTopup === 'object'
    ? { enabled: !!m.autoTopup.enabled, threshold: m.autoTopup.threshold ?? AUTO_TOPUP_DEFAULT_THRESHOLD, pack: m.autoTopup.pack || 'topup-small' }
    : { enabled: false, threshold: AUTO_TOPUP_DEFAULT_THRESHOLD, pack: 'topup-small' };
  const callsLowAt = Math.max(1, Math.round(auto.threshold / 2));
  const low = auto.enabled && (remaining <= auto.threshold || callsRemaining <= callsLowAt);
  const cardOnFile = m?.payMethod === 'card' && !!m?.stripeCustomerId;
  return {
    plan: m?.plan || 'starter-20',
    period: quotaPeriodKey(nowMs),
    quota,
    used,
    topupMinutes: m?.topupMinutes || 0,
    topupCalls: m?.topupCalls || 0,
    remaining,
    callsQuota,
    callsUsed,
    callsRemaining,
    resetAt: quotaResetAt(nowMs),
    payMethod: m?.payMethod || '',
    autoTopup: { ...auto, due: !!(low && cardOnFile), manualPrompt: !!(low && !cardOnFile) },
  };
}

export function addMember({ ownerPhone, aiNumber, plan = 'starter-20', whitelisted = [], familyWatchers = [], lineUserId = '', counted = true }) {
  const member = {
    id: `m_${Date.now().toString(36)}_${membersByOwner.size + 1}`,
    ownerPhone,
    aiNumber,
    numbers: [aiNumber],
    plan: PLANS[plan] ? plan : 'starter-20',
    minutesUsed: 0,
    quotaPeriod: quotaPeriodKey(),
    quotaWarnedPeriod: '', // last YYYY-MM the quota-low alert fired (once per period)
    topupMinutes: 0,
    topupCalls: 0,
    autoTopup: { enabled: false, threshold: AUTO_TOPUP_DEFAULT_THRESHOLD, pack: 'topup-small' },
    stripeCustomerId: '',
    payMethod: '', // 'card' | 'promptpay' | '' (unknown) — from last Stripe session
    billingRegion: 'th',
    whitelisted,
    familyWatchers,
    lineUserId: String(lineUserId || '').slice(0, 64),
    createdAt: new Date().toISOString(),
    trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString(),
    active: true,
    cancelledAt: null,
    forwardingConfirmed: false,
    seatsPaid: 0,
    pendingSeats: [],
  };
  members.set(aiNumber, member);
  membersByOwner.set(ownerPhone, member);
  if (counted) recordMemberJoin();
  return member;
}

// Extra family numbers resolve to the same member (mode A lookup unchanged).
export function addMemberAlias(aiNumber, member) {
  members.set(aiNumber, member);
}

export function addNumber(memberId, aiNumber) {
  const m = getMemberById(memberId);
  if (!m || m.numbers.includes(aiNumber)) return m?.numbers || null;
  m.numbers.push(aiNumber);
  addMemberAlias(aiNumber, m);
  return m.numbers;
}

// Extra family seats: every added number must pass OTP on its own phone
// before it activates (pending -> verified -> numbers[]).
export function seatCap(m) {
  return Math.min(MAX_HOUSEHOLD_SEATS, planOf(m).numbers + (m?.seatsPaid || 0));
}

export function requestSeat(memberId, aiNumber, ownerPhone) {
  const m = getMemberById(memberId);
  if (!m) return null;
  m.pendingSeats = m.pendingSeats || [];
  const fresh = m.pendingSeats.find((s) => s.ownerPhone === ownerPhone);
  if (fresh) { // resend: reuse the number, restart the clock
    fresh.requestedAt = new Date().toISOString();
    return fresh;
  }
  if (m.numbers.length + m.pendingSeats.length >= seatCap(m)) return null;
  const seat = { aiNumber, ownerPhone, requestedAt: new Date().toISOString() };
  m.pendingSeats.push(seat);
  return seat;
}

export function confirmSeat(memberId, aiNumber) {
  const m = getMemberById(memberId);
  if (!m) return null;
  m.pendingSeats = (m.pendingSeats || []).filter((s) => s.aiNumber !== aiNumber);
  return addNumber(memberId, aiNumber);
}

export function pruneSeats(memberId, now = Date.now()) {
  const m = getMemberById(memberId);
  if (!m || !m.pendingSeats) return;
  const live = [];
  for (const s of m.pendingSeats) {
    if (now - Date.parse(s.requestedAt) > SEAT_TTL_MS) releaseNumber(s.aiNumber);
    else live.push(s);
  }
  m.pendingSeats = live;
}

export function setPlan(memberId, plan) {
  const m = getMemberById(memberId);
  if (!m || !PLANS[plan]) return null;
  m.plan = plan;
  return m;
}

export function setLineUserId(memberId, lineUserId) {
  const m = getMemberById(memberId);
  if (m) m.lineUserId = String(lineUserId || '').slice(0, 64);
  return m;
}

export function cancelMember(memberId) {
  const m = getMemberById(memberId);
  if (m) { m.active = false; m.cancelledAt = new Date().toISOString(); }
  return m;
}

export function reactivateMember(memberId) {
  const m = getMemberById(memberId);
  if (m) { m.active = true; m.cancelledAt = null; }
  return m;
}

// Member gate: resolve which household a call belongs to.
// Mode A: lookup by To (the AI number dialled). Mode B: lookup by ForwardedFrom.
export function findMember({ to, forwardedFrom, mode }) {
  if (mode === 'B') {
    if (!forwardedFrom) return { member: null, reason: 'missing-forwarded-from' };
    const m = membersByOwner.get(forwardedFrom);
    if (!m) return { member: null, reason: 'unknown-member' };
    return { member: m, reason: 'ok' };
  }
  const m = members.get(to);
  if (!m) return { member: null, reason: 'unknown-number' };
  return { member: m, reason: 'ok' };
}

export function isWhitelisted(member, callerPhone) {
  return member.whitelisted.some((w) => w.phone === callerPhone);
}

export function checkRejectLimit(callerPhone) {
  const key = `${todayKey()}:${callerPhone}`;
  return (rejectCounts.get(key) || 0);
}

export function countReject(callerPhone) {
  const key = `${todayKey()}:${callerPhone}`;
  rejectCounts.set(key, (rejectCounts.get(key) || 0) + 1);
}

const reputation = new Map(); // key: `${memberId}:${callerPhone}` -> { verdict, confidence, signals, at, expiresAt }

// Caller reputation, PER HOUSEHOLD: numbers this member already judged. SCAM
// entries auto-reject repeats ($0 via <Reject/>) until they expire — recycled
// numbers must not stay flagged forever. Flags never cross households (PDPA:
// no shared blacklist — a SCAM label is sensitive criminal-record data).
// Firestore shape: members/{id}/reputation, doc = phone.
const repKey = (memberId, callerPhone) => `${memberId}:${callerPhone}`;

export function getReputation(memberId, callerPhone) {
  const key = repKey(memberId, callerPhone);
  const r = reputation.get(key);
  if (!r) return null;
  if (Date.parse(r.expiresAt) <= Date.now()) {
    reputation.delete(key);
    return null;
  }
  return r;
}

export function setReputation(memberId, callerPhone, { verdict, confidence, signals = [] }, ttlDays) {
  const r = {
    verdict,
    confidence,
    signals: [...signals],
    at: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlDays * 86400000).toISOString(),
  };
  reputation.set(repKey(memberId, callerPhone), r);
  return r;
}

// Appeal path: owner clears a wrongly-flagged (innocent) number immediately.
export function clearReputation(memberId, callerPhone) {
  return reputation.delete(repKey(memberId, callerPhone));
}

export function createCall({ memberId, callerPhone, aiNumber, source }) {
  callSeq += 1;
  const call = {
    id: `call_${Date.now().toString(36)}_${callSeq}`,
    memberId,
    callerPhone,
    aiNumber,
    source, // 'twilio' | 'demo'
    startedAt: new Date().toISOString(),
    endedAt: null,
    turns: [],
    verdict: null,
    minutesBilled: 0,
  };
  calls.set(call.id, call);
  return call;
}

export function getCall(id) {
  return calls.get(id) || null;
}

export function listCalls(limit = 50) {
  return [...calls.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, limit);
}

export function addTurn(callId, role, text) {
  const call = calls.get(callId);
  if (!call) return null;
  call.turns.push({ role, text, at: new Date().toISOString() });
  return call;
}

export function setVerdict(callId, verdict) {
  const call = calls.get(callId);
  if (!call) return null;
  call.verdict = verdict;
  return call;
}

export function endCall(callId) {
  const call = calls.get(callId);
  if (!call || call.endedAt) return call;
  call.endedAt = new Date().toISOString();
  const ms = Date.parse(call.endedAt) - Date.parse(call.startedAt);
  call.minutesBilled = Math.max(1, Math.ceil(ms / 60000));
  recordCallEnd(call); // once per call: repeats early-return above
  return call;
}

// Erasure (PDPA ม.33 support): drop the whole call record.
export function deleteCall(id) {
  return calls.delete(id);
}

// Retention sweeper (PDPA data minimization): delete ENDED calls older than
// the per-verdict window. In-progress calls are never purged. Ended calls
// without a verdict use the LEGIT (shortest) window.
export function purgeCalls({ LEGIT = 7, UNSURE = 90, SCAM = 365 } = {}, nowMs = Date.now()) {
  let n = 0;
  for (const [id, call] of calls) {
    if (!call.endedAt) continue;
    const v = call.verdict?.verdict;
    const days = v === 'SCAM' ? SCAM : v === 'UNSURE' ? UNSURE : LEGIT;
    if (Date.parse(call.endedAt) + days * 86400000 <= nowMs) {
      calls.delete(id);
      n += 1;
    }
  }
  return n;
}

export function listMembers() {
  return [...members.values()];
}

export function getMemberById(id) {
  return [...members.values()].find((m) => m.id === id) || null;
}

export function getMemberByOwner(ownerPhone) {
  return membersByOwner.get(ownerPhone) || null;
}

export function setForwardingConfirmed(memberId, confirmed) {
  const m = getMemberById(memberId);
  if (m) m.forwardingConfirmed = confirmed;
  return m;
}

export function addWhitelist(memberId, entry) {
  const m = getMemberById(memberId);
  if (!m) return null;
  if (!m.whitelisted.some((w) => w.phone === entry.phone)) m.whitelisted.push(entry);
  return m.whitelisted;
}

export function removeWhitelist(memberId, phone) {
  const m = getMemberById(memberId);
  if (!m) return null;
  m.whitelisted = m.whitelisted.filter((w) => w.phone !== phone);
  return m.whitelisted;
}

export function addWatcher(memberId, phone) {
  const m = getMemberById(memberId);
  if (!m) return null;
  if (!m.familyWatchers.includes(phone)) m.familyWatchers.push(phone);
  return m.familyWatchers;
}

export function removeWatcher(memberId, phone) {
  const m = getMemberById(memberId);
  if (!m) return null;
  m.familyWatchers = m.familyWatchers.filter((p) => p !== phone);
  return m.familyWatchers;
}

export function callsByMember(memberId, limit = 50) {
  return [...calls.values()]
    .filter((c) => c.memberId === memberId)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    .slice(0, limit);
}

// ---- persistence (Firestore write-behind; see persist/index.js) ----
export function serializeStore() {
  return {
    members: [...members.values()],
    calls: [...calls.values()],
    reputation: [...reputation.entries()],
    rejectCounts: [...rejectCounts.entries()],
    stats: snapshotStats(),
  };
}

export function restoreStore(data = {}) {
  members.clear();
  calls.clear();
  reputation.clear();
  rejectCounts.clear();
  for (const m of data.members || []) members.set(m.id, m);
  for (const c of data.calls || []) calls.set(c.id, c);
  for (const [k, v] of data.reputation || []) reputation.set(k, v);
  for (const [k, v] of data.rejectCounts || []) rejectCounts.set(k, v);
  // Old snapshots predate stats: rebuild from the restored call records
  // so a deploy never zeroes the public totals (demo calls excluded).
  if (data.stats) restoreStats(data.stats);
  else {
    restoreStats(null);
    backfillFromCalls([...calls.values()]);
  }
}

export function getMemberByLineUserId(lineUserId) {
  if (!lineUserId) return null;
  return [...members.values()].find((m) => m.lineUserId === lineUserId) || null;
}
