// Background jobs, started once from server.js after the snapshot restore.
// Trial lifecycle (household.js / lifecycle.js): T-2 + T-0 reminders, grace
// reminders, lapse + SMS to every protected phone. Hourly, on an unref'd
// timer, never under NODE_ENV=test (suites drive ticks directly). Each
// notice is marked on the member before it is sent (member.lifecycleSent)
// and the snapshot is flushed right after any tick that sent one, so a
// restart never re-sends.
import { sweepLifecycle, defaultDeps as lifecycleDeps } from './lifecycle.js';
import { flush } from './persist/index.js';
import { config } from './config.js';
import { listMembers, deleteMember, pruneTombstones } from './store.js';
import { destroySessionsFor } from './auth.js';
import { lifecycleOf } from './household.js';
import { closeStaleCalls } from './twilio/voice.js';

export const LIFECYCLE_EVERY_MS = 3600000;
export const STALE_CALLS_EVERY_MS = 300000;

// PDPA storage limitation: households cancelled, or lapsed (grace over),
// for ERASE_AFTER_DAYS are erased entirely, after one notice to the payer
// ERASE_NOTICE_DAYS before (LINE if linked, else SMS; m.eraseNoticeAt).
// Never the operator's demo household; never a member the lifecycle
// migration hasn't seen yet.
export const ERASE_AFTER_DAYS = 90;
export const ERASE_NOTICE_DAYS = 7;
const DAY_MS = 86400000;
const eraseNotice = () => `ใครอะ: บัญชีที่หยุดใช้จะถูกลบพร้อมข้อมูลทั้งหมดใน ${ERASE_NOTICE_DAYS} วัน ต้องการเก็บไว้ เปิดใช้อีกครั้งที่ ${config.publicBaseUrl || 'https://krai-a.com'}/dashboard.html`;

// When this household becomes erasable (ms), or null while it is in use.
function eraseAt(m, now) {
  if (m.ownerPhone === config.seedMemberPhone) return null;
  if (m.active === false && Number.isFinite(Date.parse(m.cancelledAt || ''))) return Date.parse(m.cancelledAt) + ERASE_AFTER_DAYS * DAY_MS;
  if (!m.lifecycleV) return null;
  const lc = lifecycleOf(m, now);
  if (lc.state !== 'lapsed' || !Number.isFinite(Date.parse(lc.graceEndsAt || ''))) return null;
  return Date.parse(lc.graceEndsAt) + ERASE_AFTER_DAYS * DAY_MS;
}

export async function purgeInactiveMembers(now = Date.now(), deps = lifecycleDeps) {
  let n = 0;
  for (const m of listMembers()) {
    const at = eraseAt(m, now);
    if (at == null) continue;
    if (now >= at) {
      deleteMember(m.id);
      destroySessionsFor(m.id);
      n += 1;
    } else if (now >= at - ERASE_NOTICE_DAYS * DAY_MS && !m.eraseNoticeAt) {
      m.eraseNoticeAt = new Date(now).toISOString(); // mark first: never twice
      try {
        await (m.lineUserId ? deps.sendLine(m.lineUserId, eraseNotice()) : deps.sendSms(m.ownerPhone, eraseNotice()));
      } catch (e) { console.error('[privacy] erase notice failed', e.message); }
    }
  }
  if (n) console.log(`[privacy] erased ${n} inactive household(s)`);
  return n;
}

let running = false;

export async function lifecycleTick({
  sweep = sweepLifecycle, purge = purgeInactiveMembers, save = flush, now = Date.now(), deps,
} = {}) {
  if (running) return 0; // a slow sweep (many SMS) never overlaps the next
  running = true;
  try {
    const n = await sweep(now, deps); // migrates + notifies first, then erase
    const erased = await purge(now, deps);
    pruneTombstones(now); // trial tombstones live 12 months
    if (n) console.log(`[lifecycle] sent ${n} notice(s)`);
    if (n || erased) await save();
    return n;
  } catch (e) {
    console.error('[lifecycle] sweep failed', e.message);
    return 0;
  } finally {
    running = false;
  }
}

// Phone calls whose Twilio status callback never came (voice.js settles
// them — verdict, bill, owner alert); every 5 min, saved when any closed.
let staleRunning = false;
export async function staleCallsTick({ close = closeStaleCalls, save = flush, now = Date.now() } = {}) {
  if (staleRunning) return 0;
  staleRunning = true;
  try {
    const n = await close(now);
    if (n) {
      console.log(`[voice] settled ${n} stale call(s)`);
      await save();
    }
    return n;
  } catch (e) {
    console.error('[voice] stale sweep failed', e.message);
    return 0;
  } finally {
    staleRunning = false;
  }
}

export function startJobs({ env = process.env.NODE_ENV, tick = lifecycleTick, staleTick = staleCallsTick } = {}) {
  if (env === 'test') return null;
  tick();
  staleTick();
  const lifecycle = setInterval(() => tick(), LIFECYCLE_EVERY_MS);
  const stale = setInterval(() => staleTick(), STALE_CALLS_EVERY_MS);
  lifecycle.unref?.();
  stale.unref?.();
  return { lifecycle, stale };
}
