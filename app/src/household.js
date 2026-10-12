// Households under the central-number model (IDENTIFY_MODE=B).
// The payer protects other people's phones (parents, kids) and optionally
// their own. Every protected phone is verified by an OTP sent to THAT phone
// (= consent). The pre-answer gate answers a call only when it was forwarded
// from a protected phone, or when a protected person calls the central
// number directly; everything else is rejected unanswered ($0).
// Record fields (on the member): protected:[{phone,label,verifiedAt,
// forwardingVerifiedAt}], pendingProtected:[{phone,label,requestedAt}],
// forwardingVerifiedAt, waitlist:{country,channel,at}|null,
// watcherLine:{[phone]: lineUserId}.
import { config } from './config.js';
import { normalizePhone } from './auth.js';
import { addMember, listMembers, findMember, seatCap, planOf, PLANS, activeSeats, MAX_HOUSEHOLD_SEATS, watcherCap, quotaSummary } from './store.js';
import { assignNumber, centralStatus, forwardingCodes } from './numbers.js';

export const PROTECT_TTL_MS = 10 * 60 * 1000; // pending dies with its OTP window
export const GRACE_DAYS = 3; // after the free trial: still screening, daily reminders
const WITHDRAWN_KEEP_MS = 30 * 86400000;
const DAY_MS = 86400000;
const LABEL_MAX = 24;

// Any carrier/Twilio/SIP spelling of a Thai number -> +66… (null if none).
export function toE164(raw) {
  let s = String(raw || '').trim();
  const sip = /(?:sips?|tel):([^@;>]+)/i.exec(s);
  if (sip) s = sip[1];
  s = s.replace(/[\s()-]/g, '');
  if (/^66\d{8,9}$/.test(s)) s = `+${s}`;
  return normalizePhone(s);
}

// SIP Diversion: `<sip:+668…@host>;reason=unconditional` (first entry wins).
export function parseDiversion(header) {
  const first = String(header || '').split(',')[0];
  return first ? toE164(first) : null;
}

// Members created before protected[] existed protect their own phone.
export function protectedOf(m) {
  if (!m) return [];
  if (!Array.isArray(m.protected)) {
    m.protected = m.ownerPhone
      ? [{ phone: m.ownerPhone, label: 'self', verifiedAt: m.createdAt || null, forwardingVerifiedAt: null }]
      : [];
  }
  return m.protected;
}

export function findProtected(phone) {
  const p = toE164(phone);
  if (!p) return null;
  for (const member of listMembers()) {
    const entry = protectedOf(member).find((e) => e.phone === p);
    if (entry) return { member, entry };
  }
  return null;
}

export function pruneProtected(m, now = Date.now()) {
  m.pendingProtected = (m.pendingProtected || []).filter((s) => now - Date.parse(s.requestedAt) <= PROTECT_TTL_MS);
  return m.pendingProtected;
}

const cleanLabel = (label) => String(label || '').trim().slice(0, LABEL_MAX) || 'other';

// Step 1 of adding a person: validate + reserve a pending seat. The caller
// (memberRoutes) then texts the OTP to that phone. A resend reuses the seat.
export function requestProtected(m, { phone, label } = {}, now = Date.now()) {
  const p = toE164(phone);
  if (!p) return { ok: false, error: 'invalid-phone' };
  if (protectedOf(m).some((e) => e.phone === p)) return { ok: false, error: 'already-protected' };
  const other = findProtected(p);
  if (other && other.member.id !== m.id) return { ok: false, error: 'protected-elsewhere' };
  // One payer at a time may hold a consent code for a phone: the OTP store
  // is per phone+purpose, so a second payer's request would otherwise share
  // (and be able to use) the first payer's code.
  if (listMembers().some((x) => x.id !== m.id && pruneProtected(x, now).some((s) => s.phone === p))) {
    return { ok: false, error: 'pending-elsewhere' };
  }
  const pending = pruneProtected(m, now);
  const fresh = pending.find((s) => s.phone === p);
  if (fresh) {
    fresh.requestedAt = new Date(now).toISOString();
    fresh.label = cleanLabel(label || fresh.label);
    return { ok: true, pending: fresh };
  }
  const max = seatCap(m);
  if (protectedOf(m).length + pending.length >= max) return { ok: false, error: 'plan-limit', max };
  const seat = { phone: p, label: cleanLabel(label), requestedAt: new Date(now).toISOString() };
  pending.push(seat);
  return { ok: true, pending: seat };
}

// Step 2: the OTP on that phone checked out -> the person is protected.
export function confirmProtected(m, phone, now = Date.now()) {
  const p = toE164(phone);
  const seat = (m.pendingProtected || []).find((s) => s.phone === p);
  if (!seat) return null;
  m.pendingProtected = m.pendingProtected.filter((s) => s !== seat);
  protectedOf(m).push({ phone: p, label: seat.label, verifiedAt: new Date(now).toISOString(), forwardingVerifiedAt: null });
  return m.protected;
}

// The account phone was already OTP-verified at signup.
export function addSelfProtected(m, now = Date.now()) {
  const list = protectedOf(m);
  if (list.some((e) => e.phone === m.ownerPhone)) return list;
  const other = findProtected(m.ownerPhone);
  if (other && other.member.id !== m.id) return { error: 'protected-elsewhere' };
  if (list.length + (m.pendingProtected || []).length >= seatCap(m)) return { error: 'plan-limit', max: seatCap(m) };
  list.unshift({ phone: m.ownerPhone, label: 'self', verifiedAt: new Date(now).toISOString(), forwardingVerifiedAt: null });
  return list;
}

export function removeProtected(m, phone) {
  const p = toE164(phone);
  m.protected = protectedOf(m).filter((e) => e.phone !== p);
  m.pendingProtected = (m.pendingProtected || []).filter((s) => s.phone !== p);
  return m.protected;
}

// ---- trial / plan lifecycle ----
// A household is 'paid' only while planPaidUntil (stamped by billing for
// each plan payment: +30 days, renewals extend) is in the future. Top-ups
// and seats never change this. When the current period ends — the free
// trial or a paid plan — the same path runs: reminder 2 days before ->
// "ended" notice -> 3-day grace (still screening) -> lapsed (gate rejects).
// Grace counts from the end OR the "ended" notice, whichever is later, so no
// household lapses without three days' warning. The demo seed household is
// exempt. member.lifecycleSent = { cycle: <period end ISO>, 't-2', 't-0',
// 'grace-N', 'lapsed' } — keys reset when a renewal starts a new cycle.
export function lifecycleOf(m, now = Date.now()) {
  const paidUntil = Date.parse(m?.planPaidUntil || '');
  const trialEnd = Date.parse(m?.trialEndsAt || '');
  if (m?.ownerPhone === config.seedMemberPhone) return { state: 'paid', kind: 'demo', exempt: true, endsAt: null, graceEndsAt: null, daysLeft: null };
  // Re-signup of a phone whose trial was already used (store tombstone):
  // no second trial, no grace, no texts — lapsed until a plan is paid.
  if (m?.trialDenied && !Number.isFinite(paidUntil)) {
    return { state: 'lapsed', kind: 'trial', denied: true, endsAt: null, graceEndsAt: null, daysLeft: 0 };
  }
  const kind = Number.isFinite(paidUntil) && !(trialEnd > paidUntil) ? 'plan' : 'trial';
  const end = kind === 'plan' ? paidUntil : trialEnd;
  if (!Number.isFinite(end)) return { state: 'trial', kind: 'trial', endsAt: null, graceEndsAt: null, daysLeft: null };
  const endsAt = new Date(end).toISOString();
  const sent = m?.lifecycleSent?.cycle === endsAt ? m.lifecycleSent : {};
  const noticed = Date.parse(sent['t-0'] || '');
  const graceEnd = (Number.isFinite(noticed) ? Math.max(end, noticed) : Math.max(end, now)) + GRACE_DAYS * DAY_MS;
  const out = (state, until) => ({
    state, kind, endsAt, graceEndsAt: new Date(graceEnd).toISOString(),
    daysLeft: Math.max(0, Math.ceil((until - now) / DAY_MS)),
  });
  if (now < end) return out(kind === 'plan' ? 'paid' : 'trial', end);
  if (now < graceEnd) return out('grace', graceEnd);
  return out('lapsed', graceEnd);
}

// ---- extra seats (phones above the plan limit) ----
// A paid seat is a 30-day period (store.activeSeats). When one ends, the
// phones above the new cap (the most recently added) follow the same path
// as a lapse: payer reminded 2 days before, "seat ended" notice, 3-day grace
// (still answered), then those phones are suspended (gate rejects them) and
// each gets one ##002# SMS. Renewing, or removing a phone, lifts it.
const capAt = (m, now) => Math.min(MAX_HOUSEHOLD_SEATS, (planOf(m).numbers || 1) + activeSeats(m, now));

export function seatOverflow(m, now = Date.now()) {
  const list = protectedOf(m);
  const over = Math.max(0, list.length - capAt(m, now));
  return over ? list.slice(list.length - over) : [];
}

// When the next seat expiry would push phones over the cap, and which phones.
export function nextSeatShortfall(m, now = Date.now()) {
  const ends = (Array.isArray(m?.seats) ? m.seats : []).map((x) => Date.parse(x.paidUntil)).filter((t) => t > now).sort((a, b) => a - b);
  const list = protectedOf(m);
  for (let i = 0; i < ends.length; i += 1) {
    const capAfter = Math.min(MAX_HOUSEHOLD_SEATS, (planOf(m).numbers || 1) + activeSeats(m, now) - (i + 1));
    if (list.length > capAfter) return { at: ends[i], phones: list.slice(capAfter) };
  }
  return null;
}

// null | { state: 'soon'|'grace'|'stop-due'|'stopped', phones, endsAt?, daysLeft? }
export function seatStatus(m, now = Date.now()) {
  const over = seatOverflow(m, now);
  if (!over.length) {
    const next = nextSeatShortfall(m, now);
    if (!next || next.at - now > 2 * DAY_MS) return null;
    return { state: 'soon', phones: next.phones, endsAt: new Date(next.at).toISOString(), daysLeft: Math.max(0, Math.ceil((next.at - now) / DAY_MS)) };
  }
  if (over.every((p) => p.suspendedAt)) return { state: 'stopped', phones: over };
  const t0 = Date.parse(m.seatLife?.['t-0'] || '');
  const graceEnd = (Number.isFinite(t0) ? t0 : now) + GRACE_DAYS * DAY_MS;
  if (now < graceEnd) return { state: 'grace', phones: over, daysLeft: Math.max(1, Math.ceil((graceEnd - now) / DAY_MS)) };
  return { state: 'stop-due', phones: over };
}

// ---- pre-answer gate ----
// Returns { member, protectedPhone, via:'forwarded'|'member-call'|'number', reason }.
// member === null means: reject unanswered ($0).
export function resolveIncoming({ to, from, forwardedFrom, diversion, mode } = {}) {
  if (mode !== 'B') {
    const r = findMember({ to, forwardedFrom, mode });
    if (r.member && lifecycleOf(r.member).state === 'lapsed') return { member: null, reason: 'lapsed', via: 'number' };
    return { ...r, via: r.member ? 'number' : null };
  }
  const fwd = toE164(forwardedFrom) || parseDiversion(diversion);
  if (fwd) {
    const hit = findProtected(fwd);
    return hit ? admit(hit, 'forwarded') : { member: null, reason: 'not-protected', via: 'forwarded' };
  }
  const hit = findProtected(from);
  return hit ? admit(hit, 'member-call') : { member: null, reason: 'not-forwarded', via: null };
}

function admit({ member, entry }, via) {
  if (!member.active) return { member: null, reason: 'inactive', via };
  if (entry.suspendedAt) return { member: null, reason: 'seat-expired', via };
  if (lifecycleOf(member).state === 'lapsed') return { member: null, reason: 'lapsed', via };
  return { member, protectedPhone: entry.phone, via, reason: 'ok' };
}

// ---- answer caps ----
// Caller ID is cheap to spoof: anyone can dial the central number showing a
// protected phone's number and be answered as "member-call", and one caller
// can flood forwards to drain the payer's quota. Daily caps per household;
// over a cap the gate rejects unanswered ($0). member.answerLog resets daily.
export const ANSWER_CAPS = { memberCallPerDay: 3, perCallerPerDay: 5 };

// Free trial = TRIAL.days OR TRIAL.calls screened calls, whichever comes
// first. Spending the calls ends the trial now; the household then gets the
// normal "trial ended" notice and 3-day grace (still answered), never a
// silent cut-off. Called before each answer (allowAnswer) and by the sweep.
// `answering` = 1 when called for a call about to be answered (it counts).
export function endTrialIfCallsUsedUp(m, now = Date.now(), { answering = 0 } = {}) {
  if (!m || m.trialCallsUsedUpAt) return false;
  const trial = quotaSummary(m, now).trial;
  if (!trial?.active || trial.callsRemaining - answering > 0) return false;
  m.trialCallsUsedUpAt = new Date(now).toISOString();
  m.trialEndsAt = m.trialCallsUsedUpAt;
  return true;
}

export function allowAnswer(m, { from, protectedPhone, via } = {}, now = Date.now()) {
  endTrialIfCallsUsedUp(m, now);
  const day = new Date(now).toISOString().slice(0, 10);
  if (m.answerLog?.day !== day) m.answerLog = { day, member: {}, caller: {} };
  const log = m.answerLog;
  if (via === 'member-call') {
    const n = log.member[protectedPhone] || 0;
    if (n >= ANSWER_CAPS.memberCallPerDay) return { ok: false, reason: 'member-call-cap' };
    log.member[protectedPhone] = n + 1;
    endTrialIfCallsUsedUp(m, now, { answering: 1 });
    return { ok: true };
  }
  const key = `${protectedPhone || '-'}|${toE164(from) || 'anonymous'}`;
  const n = log.caller[key] || 0;
  if (n >= ANSWER_CAPS.perCallerPerDay) return { ok: false, reason: 'caller-cap' };
  log.caller[key] = n + 1;
  endTrialIfCallsUsedUp(m, now, { answering: 1 }); // the last trial call is being answered
  return { ok: true };
}

// ---- consent withdrawal ----
// The protected person (proven by an OTP on their own phone) takes their
// number out of the household: protected or still pending. The caller
// tells the payer and reminds the person to dial ##002#.
export function withdrawProtected(phone) {
  const p = toE164(phone);
  if (!p) return { withdrawn: false };
  for (const member of listMembers()) {
    const had = protectedOf(member).find((e) => e.phone === p) || (member.pendingProtected || []).find((s) => s.phone === p);
    if (!had) continue;
    removeProtected(member, p);
    // The payer sees who left (label + when) in the app; kept 30 days, max 5.
    const now = Date.now();
    member.withdrawn = [{ phone: p, label: had.label, at: new Date(now).toISOString() },
      ...(member.withdrawn || []).filter((w) => now - Date.parse(w.at) < WITHDRAWN_KEEP_MS)].slice(0, 5);
    return { withdrawn: true, member, label: had.label, phone: p };
  }
  return { withdrawn: false };
}

// Replaces the honour-system "I've set it up" button: the first call that
// actually arrives forwarded from a phone proves its forwarding works.
export function markForwardingVerified(m, phone, at = new Date().toISOString()) {
  const p = toE164(phone);
  const entry = protectedOf(m).find((e) => e.phone === p);
  if (!entry || entry.forwardingVerifiedAt) return false;
  entry.forwardingVerifiedAt = at;
  if (!m.forwardingVerifiedAt) m.forwardingVerifiedAt = at;
  m.forwardingConfirmed = true;
  return true;
}

// ---- signup ----
// The free trial runs on the Family plan ("Mom · Dad" needs 2+ phones);
// the plan the member picks applies when they pay. Limits always come from
// the PLANS table, so new pricing changes seat counts without code changes.
export const TRIAL_PLAN = Object.keys(PLANS).find((id) => id.startsWith('family')) || Object.keys(PLANS)[0];

export async function provisionMember({ ownerPhone, plan = TRIAL_PLAN, mode = 'B' } = {}) {
  if (mode === 'B') plan = TRIAL_PLAN;
  if (mode !== 'B') {
    const num = await assignNumber();
    if (!num.ok) return { ok: false, error: num.error };
    const legacy = addMember({ ownerPhone, aiNumber: num.number, plan });
    legacy.lifecycleV = 1;
    return { ok: true, member: legacy, central: null };
  }
  const central = centralStatus('TH');
  const member = addMember({ ownerPhone, aiNumber: central.number, plan });
  member.lifecycleV = 1; // born under trial enforcement: no migration needed
  member.protected = [];
  member.pendingProtected = [];
  member.waitlist = central.state === 'live' ? null : { country: 'TH', channel: 'sms', at: new Date().toISOString() };
  return { ok: true, member, central };
}

export function joinWaitlist(m, { channel } = {}) {
  m.waitlist = { country: 'TH', channel: channel === 'line' ? 'line' : 'sms', at: new Date().toISOString() };
  return m.waitlist;
}

export function waitlistCount() {
  return listMembers().filter((m) => m.waitlist && m.active !== false).length;
}

// ---- family watchers ----
// A watcher proves their phone by OTP and their LINE by ID token (LIFF);
// then every household that lists that phone sends them alerts.
export function linkWatcherLine(phone, lineUserId) {
  const p = toE164(phone);
  if (!p || !lineUserId) return 0;
  let n = 0;
  for (const m of listMembers()) {
    if (!(m.familyWatchers || []).includes(p)) continue;
    m.watcherLine = { ...(m.watcherLine || {}), [p]: String(lineUserId).slice(0, 64) };
    n += 1;
  }
  return n;
}

export function watcherLineIds(m) {
  const map = m?.watcherLine || {};
  return (m?.familyWatchers || []).map((p) => map[p]).filter(Boolean);
}

// Owner first, then linked watchers (deduped). notify/index.js pushes to each.
export function alertRecipients(m, defaultTo = '') {
  const owner = m.lineUserId || defaultTo || m.ownerPhone;
  return [...new Set([owner, ...watcherLineIds(m)].filter(Boolean))];
}

// ---- what the member app may see ----
export const maskWhitelist = (list) => (list || []).map((w) => ({
  phone: w.phone, label: w.label, hasSafeWord: !!w.safeWord,
}));

export function publicCentral() {
  const c = centralStatus('TH');
  return { ...c, codes: c.number ? forwardingCodes(c.number) : null };
}

function seatNotice(m) {
  const st = seatStatus(m);
  return st ? { state: st.state, phones: st.phones.map((p) => p.phone), endsAt: st.endsAt || null, daysLeft: st.daysLeft ?? null } : null;
}

export function publicHousehold(m) {
  pruneProtected(m);
  const plan = planOf(m);
  const watcherMap = m.watcherLine || {};
  return {
    protected: protectedOf(m).map((e) => ({
      phone: e.phone, label: e.label, self: e.phone === m.ownerPhone,
      verifiedAt: e.verifiedAt || null, forwardingVerifiedAt: e.forwardingVerifiedAt || null,
      suspendedAt: e.suspendedAt || null,
    })),
    seatsPaid: activeSeats(m), // active 30-day seat periods (overrides publicMember's legacy field)
    withdrawn: (m.withdrawn || []).filter((w) => Date.now() - Date.parse(w.at) < WITHDRAWN_KEEP_MS)
      .map((w) => ({ phone: w.phone, label: w.label, at: w.at })),
    seatNotice: seatNotice(m),
    pendingProtected: (m.pendingProtected || []).map((s) => ({ phone: s.phone, label: s.label })),
    protectedMax: seatCap(m),
    forwardingVerifiedAt: m.forwardingVerifiedAt || null,
    lifecycle: lifecycleOf(m),
    waitlist: m.waitlist || null,
    central: publicCentral(),
    watchers: (m.familyWatchers || []).map((p) => ({ phone: p, line: !!watcherMap[p] })),
    watchersMax: plan.watchers === undefined ? 0 : plan.watchers, // null = unlimited (see watchersUnlimited)
    watchersUnlimited: watcherCap(plan) === Infinity,
    intendedPlan: m.intendedPlan || null, // plan picked on the pricing page (checkout preselect)
    whitelisted: maskWhitelist(m.whitelisted),
  };
}
