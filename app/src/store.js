// In-memory stores with a Firestore-compatible shape.
// Demo runs fully in memory; production swaps this module for Firestore
// without touching callers (same method names, same record shape).
// Record shapes:
//   member: { id, ownerPhone, aiNumber, plan, minutesUsed, quotaPeriod, quotaWarnedPeriod, topupMinutes, topupCalls, autoTopup:{enabled,threshold,pack}, stripeCustomerId, payMethod, billingRegion, whitelisted:[{phone,label,safeWord}], familyWatchers:[phone], createdAt }
//   call:   { id, memberId, callerPhone, aiNumber, startedAt, endedAt, turns:[{role,text,at}], verdict, minutesBilled }

import { randomBytes, createHmac } from 'node:crypto';
import { releaseNumber } from './numbers.js';
import { recordCallEnd, recordMemberJoin, snapshotStats, restoreStats, backfillFromCalls } from './stats.js';

const members = new Map(); // key: member id (mode B households share one central number)
const membersByNumber = new Map(); // mode A: key aiNumber (To), incl. family aliases
const membersByOwner = new Map(); // key: ownerPhone (mode B ForwardedFrom)
const calls = new Map(); // key: callId
const rejectCounts = new Map(); // key: `${yyyymmdd}:${caller}` -> n
// Stripe ids already fulfilled (checkout sessions + auto-topup intents).
// Persisted with the snapshot so a redelivery after a restart never grants
// twice; bounded to the newest FULFILLED_MAX ids (Stripe retries ~3 days).
const fulfilled = new Set();
const FULFILLED_MAX = 5000;
// Trial tombstones: HMAC(secret, ownerPhone) -> { trialUsedAt, at }. They
// outlive erasure (a household erased by request or after 90 days) so the
// same phone cannot re-sign up for another free trial. Legal basis: fraud
// prevention (legitimate interest); kept TOMBSTONE_DAYS, then pruned. No
// phone number is stored — only the keyed hash. Secret: env
// TRIAL_TOMBSTONE_SECRET (Secret Manager); without it a random secret is
// generated once and kept with the snapshot.
const trialTombstones = new Map();
const TOMBSTONE_DAYS = 365;
let tombstoneSecret = process.env.TRIAL_TOMBSTONE_SECRET || randomBytes(32).toString('hex');
const tombstoneKey = (phone) => createHmac('sha256', tombstoneSecret).update(`trial:${phone}`).digest('hex');

// Plans (pricing v2, decided 2026-10-12 — "same price as Whoscall, but a real
// receptionist"): Solo ฿99 protects 1 number, Family ฿199 protects 3. Annual
// = −25% (฿890 / ฿1,790). One AI number serves the whole system; `numbers` =
// protected phones, `calls`/`quota` = screened calls / minutes per month
// (pooled, soft — screening never stops), `watchers` = family LINE alert
// recipients (null = unlimited; use watcherCap()),
// price = THB; usd = the global price shown in EN.
export const PLANS = {
  'solo-99': { name: 'Solo', price: 99, usd: 3, annual: 890, quota: 60, calls: 30, numbers: 1, watchers: 3 },
  'family-199': { name: 'Family', price: 199, usd: 6, annual: 1790, quota: 180, calls: 90, numbers: 3, watchers: null },
};
export const watcherCap = (plan) => (plan?.watchers === null ? Infinity : Number(plan?.watchers) || 0);
// Off-sale plans → their successor (old snapshots, old links, old tests).
export const LEGACY_PLANS = { 'starter-20': 'solo-99', 'plus-100': 'solo-99', 'family-149': 'family-199' };
export const currentPlanId = (id) => (PLANS[id] ? id : LEGACY_PLANS[id] || null);
// 1-year gifts (one-time, never auto-renew): bought by the family member who
// sets it up; grants the plan for `days` on top of any paid time.
export const GIFTS = {
  'gift-solo-990': { plan: 'solo-99', price: 990, days: 365 },
  'gift-family-1990': { plan: 'family-199', price: 1990, days: 365 },
};
// Free trial: 7 days / 5 screened calls on Family, no card.
export const TRIAL = { plan: 'family-199', days: 7, calls: 5 };
// Protected number 4-5 on Family: +฿59/month each, its own 30 calls / 60 min.
export const ADDON_SEAT = { price: 59, usd: 2, quota: 60, calls: 30, numbers: 1 };
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
// Hard cap: 5 protected numbers per household (Family 3 + 2 seats).
// Beyond that, start a new household (new subscription).
export const MAX_HOUSEHOLD_SEATS = 5;
export const TRIAL_DAYS = TRIAL.days;
export const planOf = (m) => PLANS[currentPlanId(m?.plan)] || PLANS['solo-99'];
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

// Extra seats are one-time ฿69 payments = one 30-day period each (like
// plans): only unexpired periods count toward quota, calls and seat cap.
// A numeric `seatsPaid` is the pre-period shape (restore migrates it).
export const SEAT_PERIOD_DAYS = 30;
export function activeSeats(m, nowMs = Date.now()) {
  const periods = Array.isArray(m?.seats) ? m.seats.filter((x) => Date.parse(x.paidUntil) > nowMs).length : 0;
  return periods + (Number(m?.seatsPaid) || 0);
}
export function addSeatPeriod(m, nowMs = Date.now()) {
  m.seats = Array.isArray(m.seats) ? m.seats.filter((x) => Date.parse(x.paidUntil) > nowMs) : [];
  m.seats.push({ paidAt: new Date(nowMs).toISOString(), paidUntil: new Date(nowMs + SEAT_PERIOD_DAYS * 86400000).toISOString() });
  return activeSeats(m, nowMs);
}

export function quotaTotal(m) {
  const base = planOf(m).quota || 0;
  const seats = activeSeats(m) * ADDON_SEAT.quota;
  return base + seats + (m?.topupMinutes || 0);
}

export function callsQuotaTotal(m) {
  const base = planOf(m).calls || 0;
  return base + activeSeats(m) * ADDON_SEAT.calls + (m?.topupCalls || 0);
}

// Calls used = a per-period counter bumped when a call is answered
// (createCall), like minutesUsed — deleting a transcript or the retention
// purge never refunds quota. Members without the counter (pre-counter
// snapshots) are backfilled once on restore from surviving records.
function countCallRecords(memberId, prefix) {
  let n = 0;
  for (const c of calls.values()) {
    if (c.memberId === memberId && String(c.startedAt || '').startsWith(prefix)) n += 1;
  }
  return n;
}

export function callsUsedThisPeriod(memberId, nowMs = Date.now()) {
  const prefix = quotaPeriodKey(nowMs);
  const m = members.get(memberId);
  if (!m?.callsUsed) return countCallRecords(memberId, prefix);
  return m.callsUsed[prefix] || 0;
}

function countCallAnswered(memberId, startedAt) {
  const m = members.get(memberId);
  if (!m) return;
  const period = String(startedAt).slice(0, 7);
  m.callsUsed = m.callsUsed && typeof m.callsUsed === 'object' ? m.callsUsed : {};
  m.callsUsed[period] = (m.callsUsed[period] || 0) + 1;
  for (const old of Object.keys(m.callsUsed).sort().slice(0, -12)) delete m.callsUsed[old];
}

// Single consumption entry point: roll the period, then burn minutes.
// Quota is SOFT: screening never stops; usage beyond the quota is recorded
// per period in m.overage (kept for the last OVERAGE_PERIODS months) for
// later billing.
const OVERAGE_PERIODS = 12;
export function consumeMinutes(m, minutes, nowMs = Date.now()) {
  ensureQuotaPeriod(m, nowMs);
  m.minutesUsed = Math.max(0, (m.minutesUsed || 0) + Math.max(0, Number(minutes) || 0));
  const q = quotaSummary(m, nowMs);
  m.overage = m.overage && typeof m.overage === 'object' ? m.overage : {};
  m.overage[q.period] = { minutes: q.overageMinutes, calls: q.overageCalls };
  for (const old of Object.keys(m.overage).sort().slice(0, -OVERAGE_PERIODS)) delete m.overage[old];
  return q;
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
    plan: currentPlanId(m?.plan) || 'solo-99',
    period: quotaPeriodKey(nowMs),
    quota,
    used,
    topupMinutes: m?.topupMinutes || 0,
    topupCalls: m?.topupCalls || 0,
    remaining,
    callsQuota,
    callsUsed,
    callsRemaining,
    // Soft quota: share used (minutes or calls, whichever is higher) and
    // what went past it — nothing is ever blocked on these.
    usedPct: Math.max(quota ? used / quota : 0, callsQuota ? callsUsed / callsQuota : 0),
    // Free trial (TRIAL): no paid plan yet and trialEndsAt ahead. The 5-call
    // trial limit is reported here; the lifecycle / gate decide what happens.
    trial: (() => {
      const active = Boolean(m) && !m.trialDenied && !(Date.parse(m.planPaidUntil || '') > nowMs) && Date.parse(m.trialEndsAt || '') > nowMs;
      return { active, calls: TRIAL.calls, callsRemaining: Math.max(0, TRIAL.calls - callsUsed), endsAt: m?.trialEndsAt || null };
    })(),
    overageMinutes: Math.max(0, used - quota),
    overageCalls: Math.max(0, callsUsed - callsQuota),
    resetAt: quotaResetAt(nowMs),
    payMethod: m?.payMethod || '',
    autoTopup: { ...auto, due: !!(low && cardOnFile), manualPrompt: !!(low && !cardOnFile) },
  };
}

export function addMember({ ownerPhone, aiNumber, plan = 'solo-99', whitelisted = [], familyWatchers = [], lineUserId = '', counted = true }) {
  const member = {
    id: `m_${randomBytes(8).toString('hex')}`, // random: a counter collides after restarts
    ownerPhone,
    aiNumber,
    numbers: [aiNumber],
    plan: currentPlanId(plan) || 'solo-99',
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
    seats: [], // [{ paidAt, paidUntil }] — see activeSeats()
    callsUsed: {}, // { 'YYYY-MM': answered calls } — see callsUsedThisPeriod()
    pendingSeats: [],
  };
  members.set(member.id, member);
  if (aiNumber) membersByNumber.set(aiNumber, member);
  membersByOwner.set(ownerPhone, member);
  if (counted) recordMemberJoin();
  return member;
}

// Extra family numbers resolve to the same member (mode A lookup unchanged).
export function addMemberAlias(aiNumber, member) {
  if (aiNumber) membersByNumber.set(aiNumber, member);
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
  return Math.min(MAX_HOUSEHOLD_SEATS, planOf(m).numbers + activeSeats(m));
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
  const id = currentPlanId(plan);
  if (!m || !id) return null;
  m.plan = id;
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
  const m = membersByNumber.get(to);
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

export function createCall({ memberId, callerPhone, aiNumber, source, visitorKey, callSid }) {
  const call = {
    // 128-bit random: a call id is the only key to a demo transcript.
    id: `call_${randomBytes(16).toString('hex')}`,
    memberId,
    callerPhone,
    aiNumber,
    source, // 'twilio' | 'demo'
    startedAt: new Date().toISOString(),
    endedAt: null,
    turns: [],
    verdict: null,
    minutesBilled: 0,
    ...(visitorKey ? { visitorKey } : {}), // demo only: hashed visitor scope, never public
    ...(callSid ? { callSid: String(callSid).slice(0, 64) } : {}), // Twilio: status callbacks find the call
  };
  calls.set(call.id, call);
  countCallAnswered(memberId, call.startedAt);
  return call;
}

export function getCallBySid(callSid) {
  if (!callSid) return null;
  for (const c of calls.values()) if (c.callSid === callSid) return c;
  return null;
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

export function recordTrialUsed(phone, trialUsedAt = new Date().toISOString(), nowMs = Date.now()) {
  if (!phone) return;
  trialTombstones.set(tombstoneKey(phone), { trialUsedAt, at: new Date(nowMs).toISOString() });
}
export function trialUsedBefore(phone, nowMs = Date.now()) {
  const t = phone ? trialTombstones.get(tombstoneKey(phone)) : null;
  return Boolean(t) && Date.parse(t.at) + TOMBSTONE_DAYS * 86400000 > nowMs;
}
export function pruneTombstones(nowMs = Date.now()) {
  let n = 0;
  for (const [k, t] of trialTombstones) {
    if (!(Date.parse(t.at) + TOMBSTONE_DAYS * 86400000 > nowMs)) { trialTombstones.delete(k); n += 1; }
  }
  return n;
}

export const isFulfilled = (id) => fulfilled.has(id);
export function markFulfilled(id) {
  fulfilled.add(id);
  while (fulfilled.size > FULFILLED_MAX) fulfilled.delete(fulfilled.values().next().value);
}
export const resetFulfilled = () => fulfilled.clear();

// Erasure of a whole household (PDPA ม.33): the member record, every index
// entry, its calls and its per-household reputation flags. AI numbers no
// other household uses go back to the pool. Sessions live in auth.js
// (destroySessionsFor). Returns null for unknown ids.
export function deleteMember(id) {
  const m = members.get(id);
  if (!m) return { calls: 0 }; // idempotent
  recordTrialUsed(m.ownerPhone, m.createdAt); // the trial was used: no reset by re-signup
  members.delete(id);
  for (const [k, v] of membersByNumber) if (v === m) membersByNumber.delete(k);
  for (const [k, v] of membersByOwner) if (v === m) membersByOwner.delete(k);
  let callCount = 0;
  for (const [cid, c] of calls) {
    if (c.memberId === id) {
      calls.delete(cid);
      callCount += 1;
    }
  }
  for (const k of reputation.keys()) if (k.startsWith(`${id}:`)) reputation.delete(k);
  for (const num of new Set([m.aiNumber, ...(m.numbers || [])].filter(Boolean))) {
    if (!membersByNumber.has(num)) releaseNumber(num);
  }
  return { calls: callCount };
}
export const eraseMember = deleteMember; // member-app's name

// Retention sweeper (PDPA data minimization): delete ENDED calls older than
// the per-verdict window. In-progress calls are never purged. Ended calls
// without a verdict use the LEGIT (shortest) window.
// Calls that never ended (caller hung up mid-call, status lost) are dropped
// after ABANDONED_HOURS — an unfinished transcript must not live forever.
export const ABANDONED_HOURS = 24;
export function purgeCalls({ LEGIT = 7, UNSURE = 90, SCAM = 365 } = {}, nowMs = Date.now()) {
  let n = 0;
  for (const [id, call] of calls) {
    if (!call.endedAt) {
      if (Date.parse(call.startedAt) + ABANDONED_HOURS * 3600000 <= nowMs) {
        calls.delete(id);
        n += 1;
      }
      continue;
    }
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
  return members.get(id) || null;
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
// Snapshots hold each household once; restore rebuilds every index from
// the record (legacy snapshots repeated a household once per alias).
function uniqueMembers(list) {
  const byId = new Map();
  for (const m of list) if (m?.id && !byId.has(m.id)) byId.set(m.id, m);
  return [...byId.values()];
}

export function serializeStore() {
  return {
    members: [...members.values()],
    calls: [...calls.values()],
    reputation: [...reputation.entries()],
    rejectCounts: [...rejectCounts.entries()],
    fulfilled: [...fulfilled],
    trialTombstones: [...trialTombstones.entries()],
    ...(process.env.TRIAL_TOMBSTONE_SECRET ? {} : { tombstoneSecret }),
    stats: snapshotStats(),
  };
}

export function restoreStore(data = {}) {
  members.clear();
  membersByNumber.clear();
  membersByOwner.clear();
  calls.clear();
  reputation.clear();
  rejectCounts.clear();
  fulfilled.clear();
  trialTombstones.clear();
  if (!process.env.TRIAL_TOMBSTONE_SECRET && data.tombstoneSecret) tombstoneSecret = data.tombstoneSecret;
  for (const [k, v] of data.trialTombstones || []) trialTombstones.set(k, v);
  const now = Date.now();
  for (const m of uniqueMembers(data.members || [])) {
    // Off-sale plans move to their successor (paid-until is kept).
    m.plan = currentPlanId(m.plan) || 'solo-99';
    // Pre-period snapshots counted seats forever: each becomes one period.
    if (!Array.isArray(m.seats)) m.seats = [];
    for (let i = 0; i < (Number(m.seatsPaid) || 0); i += 1) {
      m.seats.push({ paidAt: new Date(now).toISOString(), paidUntil: new Date(now + SEAT_PERIOD_DAYS * 86400000).toISOString() });
    }
    delete m.seatsPaid;
    members.set(m.id, m);
    for (const n of new Set([m.aiNumber, ...(m.numbers || [])].filter(Boolean))) membersByNumber.set(n, m);
    if (m.ownerPhone) membersByOwner.set(m.ownerPhone, m);
  }
  for (const c of data.calls || []) calls.set(c.id, c);
  const period = quotaPeriodKey();
  for (const m of members.values()) {
    if (!m.callsUsed || typeof m.callsUsed !== 'object') m.callsUsed = { [period]: countCallRecords(m.id, period) };
  }
  for (const [k, v] of data.reputation || []) reputation.set(k, v);
  for (const [k, v] of data.rejectCounts || []) rejectCounts.set(k, v);
  for (const id of (data.fulfilled || []).slice(-FULFILLED_MAX)) fulfilled.add(id);
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
