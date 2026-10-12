// Trial / plan lifecycle reminders + lapse (states: household.lifecycleOf).
// Period end (free trial or paid plan) -> reminder 2 days before -> "ended"
// notice (starts the 3-day grace clock) -> one reminder per grace day ->
// lapsed: the gate rejects forwarded calls, the payer is told, and EVERY
// protected phone gets one SMS to cancel forwarding — with **21* an
// unanswered forward means that person silently misses all calls, so we
// never stop without telling them.
// Payer channel: LINE if linked, else SMS. Idempotency contract:
// member.lifecycleSent = { cycle: <period end ISO>, 't-2', 't-0', 'grace-N',
// 'lapsed' } — each key is sent once per cycle; a renewal starts a new cycle.
import { config } from './config.js';
import { listMembers } from './store.js';
import * as sms from './sms.js';
import { lifecycleOf, protectedOf, seatStatus, endTrialIfCallsUsedUp, GRACE_DAYS } from './household.js';
import { TRIAL } from './store.js';

const DAY_MS = 86400000;
const appUrl = () => `${config.publicBaseUrl || 'https://krai-a.com'}/dashboard.html`;

export const MSG = {
  t2: (kind) => (kind === 'plan'
    ? `ใครอะ: แผนของคุณจะหมดอายุในอีก 2 วัน ต่ออายุเพื่อให้ AI รับสายต่อ ${appUrl()}`
    : `ใครอะ: ทดลองฟรีเหลือ 2 วัน เลือกแผนเพื่อให้ AI รับสายต่อ ${appUrl()}`),
  t0Calls: () => `ใครอะ: ใช้ครบ ${TRIAL.calls} สายทดลองฟรีแล้ว AI ยังรับสายให้อีก ${GRACE_DAYS} วัน เลือกแผนที่ ${appUrl()}`,
  t0: (kind) => (kind === 'plan'
    ? `ใครอะ: แผนหมดอายุแล้ว AI ยังรับสายให้อีก ${GRACE_DAYS} วัน ต่ออายุที่ ${appUrl()}`
    : `ใครอะ: ครบทดลองฟรีแล้ว AI ยังรับสายให้อีก ${GRACE_DAYS} วัน เลือกแผนที่ ${appUrl()}`),
  grace: (kind, n) => `ใครอะ: อีก ${n} วัน AI จะหยุดรับสายแทน ${kind === 'plan' ? 'ต่ออายุ' : 'เลือกแผน'}ที่ ${appUrl()}`,
  lapsedPayer: () => `ใครอะ: บริการหยุดแล้ว AI ไม่รับสายแทนแล้ว กด ##002# ที่เครื่องที่ตั้งโอนไว้ เปิดใช้อีกครั้งที่ ${appUrl()}`,
  lapsedProtected: () => 'บริการใครอะหยุดแล้ว กด ##002# เพื่อรับสายตามปกติ',
  farewell: () => 'บริการใครอะสำหรับเบอร์นี้ถูกยกเลิกแล้ว กด ##002# เพื่อรับสายตามปกติ',
  seatT2: (who) => `ใครอะ: ที่นั่งเสริมจะหมดอายุในอีก 2 วัน ต่ออายุเพื่อให้ AI รับสายแทน${who}ต่อ ${appUrl()}`,
  seatT0: (who) => `ใครอะ: ที่นั่งเสริมหมดอายุแล้ว AI ยังรับสายแทน${who}อีก ${GRACE_DAYS} วัน ต่ออายุที่ ${appUrl()}`,
  seatGrace: (who, n) => `ใครอะ: อีก ${n} วัน AI จะหยุดรับสายแทน${who} ต่ออายุที่ ${appUrl()}`,
  seatStopped: (who) => `ใครอะ: AI หยุดรับสายแทน${who}แล้ว (ที่นั่งเสริมหมดอายุ) ต่ออายุได้ที่ ${appUrl()}`,
};

async function pushLine(to, text) {
  if (!config.lineChannelAccessToken) {
    console.log(`[lifecycle:line → ${to}] ${text}`);
    return { ok: true, mode: 'log' };
  }
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.lineChannelAccessToken}` },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
  });
  return { ok: res.ok, mode: 'line' };
}

export const defaultDeps = { sendLine: pushLine, sendSms: (phone, text) => sms.sendTextSms(phone, text) };

const toPayer = (m, text, deps) => (m.lineUserId ? deps.sendLine(m.lineUserId, text) : deps.sendSms(m.ownerPhone, text));

// Any account notice to the payer (LINE if linked, else SMS). Never throws.
export async function notifyPayer(m, text, deps = defaultDeps) {
  try { return await toPayer(m, text, deps); } catch (e) { console.error('[notify-payer] failed', e.message); return { ok: false }; }
}

// One-time, idempotent (lifecycleV): households created before enforcement
// shipped were never told about a trial end, so they get a fresh 7-day trial
// with the normal reminders. Households that paid before planPaidUntil
// existed keep 30 days from that payment (at least 7 from now). The demo
// seed household is never touched.
export function migrateLifecycle(m, now = Date.now()) {
  if (!m || m.lifecycleV) return false;
  m.lifecycleV = 1;
  if (m.ownerPhone === config.seedMemberPhone) return true;
  const week = now + 7 * DAY_MS;
  if (!m.planPaidUntil && m.planPaidAt) {
    m.planPaidUntil = new Date(Math.max(Date.parse(m.planPaidAt) + 30 * DAY_MS, week)).toISOString();
  }
  m.trialEndsAt = new Date(Math.max(Date.parse(m.trialEndsAt || '') || 0, week)).toISOString();
  m.lifecycleSent = {};
  return true;
}

const REL_TH = { self: 'คุณ', mother: 'แม่', father: 'พ่อ', grandparent: 'ปู่ย่าตายาย', child: 'ลูก', partner: 'คู่ชีวิต', other: 'คนในบ้าน' };
const whoOf = (phones) => ` ${phones.map((p) => REL_TH[p.label] || p.label).join(' · ')} `;

// Extra-seat expiry for the phones above the plan limit (household.seatStatus).
// member.seatLife = { cycle, 't-2', 't-0', 'grace-N', 'stopped' }, each once.
async function runSeatLifecycle(m, now, deps, events) {
  const st = seatStatus(m, now);
  if (!st || st.state === 'soon') {
    for (const p of protectedOf(m)) if (p.suspendedAt) delete p.suspendedAt; // renewed, or a phone was removed
    if (!st) { m.seatLife = null; return; }
  }
  if (!m.seatLife || (st.state === 'soon' && m.seatLife.cycle !== st.endsAt)) m.seatLife = { cycle: st.endsAt || new Date(now).toISOString() };
  const life = m.seatLife;
  const once = async (key, fn) => {
    if (life[key]) return;
    life[key] = new Date(now).toISOString();
    events.push(`seat:${key}`);
    try { await fn(); } catch (e) { console.error(`[lifecycle] seat ${key} failed`, e.message); }
  };
  const who = whoOf(st.phones);
  if (st.state === 'soon') { await once('t-2', () => toPayer(m, MSG.seatT2(who), deps)); return; }
  if (!life['t-0']) { await once('t-0', () => toPayer(m, MSG.seatT0(who), deps)); return; }
  if (st.state === 'grace') {
    const day = Math.floor((now - Date.parse(life['t-0'])) / DAY_MS);
    if (day >= 1 && day < GRACE_DAYS) await once(`grace-${day}`, () => toPayer(m, MSG.seatGrace(who, GRACE_DAYS - day), deps));
    return;
  }
  if (st.state === 'stop-due') {
    await once('stopped', async () => {
      for (const p of st.phones) {
        p.suspendedAt = new Date(now).toISOString();
        if (p.phone === m.ownerPhone) continue;
        try { await deps.sendSms(p.phone, MSG.farewell()); } catch (e) { console.error('[lifecycle] seat stop sms failed', e.message); }
      }
      await toPayer(m, MSG.seatStopped(who), deps);
    });
  }
}

export async function runLifecycle(m, now = Date.now(), deps = defaultDeps) {
  if (!m || m.active === false) return [];
  migrateLifecycle(m, now);
  endTrialIfCallsUsedUp(m, now);
  const events = await runHouseholdLifecycle(m, now, deps);
  if (lifecycleOf(m, now).state !== 'lapsed') await runSeatLifecycle(m, now, deps, events);
  return events;
}

async function runHouseholdLifecycle(m, now, deps) {
  const lc = lifecycleOf(m, now);
  if (lc.exempt || !lc.endsAt) return [];
  if (m.lifecycleSent?.cycle !== lc.endsAt) m.lifecycleSent = { cycle: lc.endsAt };
  const sent = m.lifecycleSent;
  const events = [];
  const once = async (key, fn) => {
    if (sent[key]) return;
    sent[key] = new Date(now).toISOString(); // mark first: a crash never double-texts
    events.push(key);
    try { await fn(); } catch (e) { console.error(`[lifecycle] ${key} send failed`, e.message); }
  };
  const end = Date.parse(lc.endsAt);

  if (lc.state === 'trial' || lc.state === 'paid') {
    if (now >= end - 2 * DAY_MS) await once('t-2', () => toPayer(m, MSG.t2(lc.kind), deps));
    return events;
  }
  if (!sent['t-0']) {
    const callsUsedUp = lc.kind === 'trial' && m.trialCallsUsedUpAt === m.trialEndsAt;
    await once('t-0', () => toPayer(m, callsUsedUp ? MSG.t0Calls() : MSG.t0(lc.kind), deps));
    return events;
  }
  if (lc.state === 'grace') {
    const day = Math.floor((now - Math.max(end, Date.parse(sent['t-0']))) / DAY_MS);
    if (day >= 1 && day < GRACE_DAYS) await once(`grace-${day}`, () => toPayer(m, MSG.grace(lc.kind, GRACE_DAYS - day), deps));
    return events;
  }
  await once('lapsed', async () => {
    await toPayer(m, MSG.lapsedPayer(), deps);
    for (const p of protectedOf(m)) {
      if (p.phone === m.ownerPhone && !m.lineUserId) continue; // the payer SMS already said it
      try { await deps.sendSms(p.phone, MSG.lapsedProtected()); } catch (e) { console.error('[lifecycle] lapse sms failed', e.message); }
    }
  });
  return events;
}

// Stable export for the hourly job (sec-demo's src/jobs.js): returns the
// number of notices sent this sweep.
// Cancel or erasure: the AI stops answering at once, so every protected
// phone (except the payer's own — they chose this) is told to dial ##002#.
// Called by the /me/cancel and DELETE /api/me routes BEFORE the record goes.
export async function farewellProtected(m, deps = defaultDeps) {
  let n = 0;
  for (const p of protectedOf(m)) {
    if (p.phone === m.ownerPhone) continue;
    try { await deps.sendSms(p.phone, MSG.farewell()); n += 1; } catch (e) { console.error('[farewell] sms failed', e.message); }
  }
  return n;
}

export async function sweepLifecycle(now = Date.now(), deps = defaultDeps) {
  let n = 0;
  for (const m of listMembers()) n += (await runLifecycle(m, now, deps)).length;
  return n;
}

// Standalone scheduler (kept for local use; production schedules
// sweepLifecycle from src/jobs.js).
export function startLifecycle(intervalMs = 3600000) {
  const tick = () => sweepLifecycle().then((n) => { if (n) console.log(`[lifecycle] sent ${n} notice(s)`); }).catch((e) => console.error('[lifecycle] sweep failed', e.message));
  tick();
  const t = setInterval(tick, intervalMs);
  t.unref?.();
  return t;
}
