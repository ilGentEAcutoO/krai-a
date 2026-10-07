// In-memory stores with a Firestore-compatible shape.
// Demo runs fully in memory; production swaps this module for Firestore
// without touching callers (same method names, same record shape).
// Record shapes:
//   member: { id, ownerPhone, aiNumber, plan, minutesUsed, whitelisted:[{phone,label,safeWord}], familyWatchers:[phone], createdAt }
//   call:   { id, memberId, callerPhone, aiNumber, startedAt, endedAt, turns:[{role,text,at}], verdict, minutesBilled }

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
export const ADDON_SEAT = { price: 49, quota: 50, calls: 25, numbers: 1 };
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

export function addMember({ ownerPhone, aiNumber, plan = 'starter-20', whitelisted = [], familyWatchers = [] }) {
  const member = {
    id: `m_${Date.now().toString(36)}_${membersByOwner.size + 1}`,
    ownerPhone,
    aiNumber,
    numbers: [aiNumber],
    plan: PLANS[plan] ? plan : 'starter-20',
    minutesUsed: 0,
    whitelisted,
    familyWatchers,
    lineUserId: '',
    createdAt: new Date().toISOString(),
    trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString(),
    active: true,
    cancelledAt: null,
    forwardingConfirmed: false,
  };
  members.set(aiNumber, member);
  membersByOwner.set(ownerPhone, member);
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
