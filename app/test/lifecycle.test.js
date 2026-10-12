// Trial / plan lifecycle: period end (free trial or paid plan) -> reminder
// 2 days before -> "ended" notice -> 3-day grace (still screening, one
// reminder a day) -> lapsed (the gate rejects forwarded calls). When a
// household lapses, EVERY protected phone gets one SMS telling it to cancel
// forwarding: with **21* an unanswered forward means that person silently
// misses all calls, so we never stop without telling them.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { addMember, PLANS, createCall, TRIAL } from '../src/store.js';
// Plan ids/limits come from the PLANS table (pricing changes without test edits).
const FAMILY = Object.keys(PLANS).find((id) => id.startsWith('family'));
const SOLO = Object.keys(PLANS).find((id) => PLANS[id].numbers === 1);
import { lifecycleOf, requestProtected, confirmProtected, resolveIncoming, GRACE_DAYS, publicHousehold, protectedOf, allowAnswer } from '../src/household.js';
import { runLifecycle, migrateLifecycle, farewellProtected } from '../src/lifecycle.js';

const DAY = 86400000;
let seq = 0;
function household({ line = '', paidUntil = null, legacy = false } = {}) {
  seq += 1;
  const m = addMember({ ownerPhone: `+6689444${String(1000 + seq)}`, aiNumber: '', plan: FAMILY });
  if (!legacy) m.lifecycleV = 1; // signed up under enforcement (provisionMember sets this)
  m.protected = [];
  if (line) m.lineUserId = line;
  if (paidUntil) m.planPaidUntil = new Date(paidUntil).toISOString();
  const mom = `+6689555${String(1000 + seq)}`;
  requestProtected(m, { phone: mom, label: 'mother' });
  confirmProtected(m, mom);
  return { m, mom, end: Date.parse(m.trialEndsAt) };
}
function outbox() {
  const sent = [];
  return {
    sent,
    deps: {
      sendLine: async (to, text) => { sent.push({ via: 'line', to, text }); return { ok: true }; },
      sendSms: async (to, text) => { sent.push({ via: 'sms', to, text }); return { ok: true }; },
    },
  };
}
const noticed = (m, at) => { m.lifecycleSent = { cycle: lifecycleOf(m, at).endsAt, 't-0': new Date(at).toISOString() }; };

describe('lifecycle states', () => {
  it('is trial for 7 days, then grace for 3, then lapsed', () => {
    const { m, end } = household();
    assert.equal(lifecycleOf(m, end - DAY).state, 'trial');
    noticed(m, end); // the "trial ended" notice went out at the end
    assert.equal(lifecycleOf(m, end + 1000).state, 'grace');
    assert.equal(lifecycleOf(m, end + GRACE_DAYS * DAY - 1000).state, 'grace');
    assert.equal(lifecycleOf(m, end + GRACE_DAYS * DAY + 1000).state, 'lapsed');
  });

  it('never lapses without the 3-day notice', () => {
    const { m, end } = household();
    assert.equal(lifecycleOf(m, end + 30 * DAY).state, 'grace');
  });

  it('a top-up or seat purchase does not make a household paid', () => {
    const { m, end } = household();
    m.payMethod = 'card'; // stamped by any checkout, incl. a ฿29 top-up
    m.planPaidAt = new Date().toISOString(); // no planPaidUntil = no paid period
    noticed(m, end);
    assert.equal(lifecycleOf(m, end + GRACE_DAYS * DAY + 1000).state, 'lapsed');
  });

  it('a paid plan expires and then follows reminder -> grace -> lapse', () => {
    const now = Date.now();
    const { m } = household({ paidUntil: now + 30 * DAY });
    assert.equal(lifecycleOf(m, now + 10 * DAY).state, 'paid');
    const end = now + 30 * DAY;
    assert.equal(lifecycleOf(m, end + 1000).kind, 'plan');
    noticed(m, end);
    assert.equal(lifecycleOf(m, end + 1000).state, 'grace');
    assert.equal(lifecycleOf(m, end + GRACE_DAYS * DAY + 1000).state, 'lapsed');
  });

  it('renewing extends paid and starts a fresh reminder cycle', async () => {
    const now = Date.now();
    const { m } = household({ line: 'Urenew', paidUntil: now + 30 * DAY });
    const o = outbox();
    await runLifecycle(m, now + 28 * DAY + 1000, o.deps); // t-2 for period 1
    assert.equal(o.sent.length, 1);
    assert.match(o.sent[0].text, /แผน/);
    m.planPaidUntil = new Date(now + 60 * DAY).toISOString(); // renewed
    assert.equal(lifecycleOf(m, now + 31 * DAY).state, 'paid');
    await runLifecycle(m, now + 58 * DAY + 1000, o.deps); // t-2 again for period 2
    assert.equal(o.sent.length, 2);
  });

  it('the demo seed household never lapses', () => {
    const m = addMember({ ownerPhone: config.seedMemberPhone, aiNumber: '' });
    m.trialEndsAt = new Date(Date.now() - 90 * DAY).toISOString();
    assert.equal(lifecycleOf(m).exempt, true);
    assert.notEqual(lifecycleOf(m).state, 'lapsed');
  });
});

describe('one-time migration (deploy safety)', () => {
  it('households from before enforcement get a fresh 7-day trial and no texts', async () => {
    const { m } = household({ legacy: true, line: 'Ulegacy' });
    m.trialEndsAt = new Date(Date.now() - 20 * DAY).toISOString(); // trial "ended" long ago, never enforced
    const o = outbox();
    await runLifecycle(m, Date.now(), o.deps);
    assert.equal(o.sent.length, 0);
    assert.equal(lifecycleOf(m).state, 'trial');
    assert.ok(Date.parse(m.trialEndsAt) > Date.now() + 6 * DAY);
  });

  it('a household with no trialEndsAt gets a fresh trial, not paid', () => {
    const { m } = household({ legacy: true });
    delete m.trialEndsAt;
    migrateLifecycle(m);
    assert.equal(lifecycleOf(m).state, 'trial');
  });

  it('runs once (idempotent)', () => {
    const { m } = household({ legacy: true });
    assert.equal(migrateLifecycle(m), true);
    const after = m.trialEndsAt;
    assert.equal(migrateLifecycle(m, Date.now() + 5 * DAY), false);
    assert.equal(m.trialEndsAt, after);
  });

  it('honours a plan paid before planPaidUntil existed', () => {
    const { m } = household({ legacy: true });
    m.planPaidAt = new Date(Date.now() - 2 * DAY).toISOString();
    migrateLifecycle(m);
    assert.equal(lifecycleOf(m).state, 'paid');
  });
});

describe('reminders', () => {
  it('reminds the payer on LINE at T-2 days, exactly once', async () => {
    const { m, end } = household({ line: 'Upayer1' });
    const o = outbox();
    await runLifecycle(m, end - 2 * DAY + 1000, o.deps);
    await runLifecycle(m, end - 2 * DAY + 5000, o.deps);
    assert.equal(o.sent.length, 1);
    assert.deepEqual([o.sent[0].via, o.sent[0].to], ['line', 'Upayer1']);
    assert.match(o.sent[0].text, /2 วัน/);
  });

  it('falls back to SMS when the payer has no LINE linked', async () => {
    const { m, end } = household();
    const o = outbox();
    await runLifecycle(m, end + 1000, o.deps); // T-0
    assert.equal(o.sent.length, 1);
    assert.deepEqual([o.sent[0].via, o.sent[0].to], ['sms', m.ownerPhone]);
  });

  it('sends one reminder per grace day', async () => {
    const { m, end } = household({ line: 'Upayer2' });
    const o = outbox();
    await runLifecycle(m, end + 1000, o.deps); // T-0
    await runLifecycle(m, end + DAY + 1000, o.deps); // grace day 1
    await runLifecycle(m, end + DAY + 9000, o.deps); // same day again: nothing new
    await runLifecycle(m, end + 2 * DAY + 1000, o.deps); // grace day 2
    assert.equal(o.sent.length, 3);
  });

  it('cancelled households get no reminders', async () => {
    const { m, end } = household({ line: 'Upayer4' });
    m.active = false;
    const o = outbox();
    await runLifecycle(m, end - 2 * DAY + 1000, o.deps);
    assert.equal(o.sent.length, 0);
  });
});

describe('lapse', () => {
  it('lapsed household: gate rejects forwarded calls ($0)', () => {
    const { m, mom } = household();
    m.trialEndsAt = new Date(Date.now() - (GRACE_DAYS + 1) * DAY).toISOString();
    noticed(m, Date.parse(m.trialEndsAt));
    const g = resolveIncoming({ from: '+66811119999', forwardedFrom: mom, mode: 'B' });
    assert.equal(g.member, null);
    assert.equal(g.reason, 'lapsed');
  });

  it('texts every protected phone to cancel forwarding, once, and tells the payer', async () => {
    const { m, mom, end } = household({ line: 'Upayer3' });
    const o = outbox();
    await runLifecycle(m, end + 1000, o.deps); // the "ended" notice starts the grace clock
    const at = end + GRACE_DAYS * DAY + 2000;
    await runLifecycle(m, at, o.deps);
    await runLifecycle(m, at + DAY, o.deps);
    const toMom = o.sent.filter((s) => s.to === mom);
    assert.equal(toMom.length, 1);
    assert.equal(toMom[0].via, 'sms');
    assert.match(toMom[0].text, /##002#/);
    assert.match(o.sent.filter((s) => s.to === 'Upayer3').at(-1).text, /หยุด/);
  });
});

describe('farewell on cancel / erasure', () => {
  it('texts every protected phone (not the payer) to dial ##002#, once per call', async () => {
    const { m, mom } = household();
    m.protected.push({ phone: m.ownerPhone, label: 'self', verifiedAt: new Date().toISOString(), forwardingVerifiedAt: null });
    const o = outbox();
    assert.equal(await farewellProtected(m, o.deps), 1);
    assert.deepEqual(o.sent.map((x) => [x.via, x.to]), [['sms', mom]]);
    assert.match(o.sent[0].text, /##002#/);
  });
});

describe('extra seat expiry (phones above the plan limit)', () => {
  // Family protects PLANS.numbers phones; one paid 30-day seat adds one more.
  // Fill the household to plan + seat; the last-added ("kid") rides on the seat.
  function seated() {
    const now = Date.now();
    const { m, mom } = household({ line: 'Useat', paidUntil: now + 90 * DAY });
    m.seats = [{ paidAt: new Date(now).toISOString(), paidUntil: new Date(now + 10 * DAY).toISOString() }];
    const extra = PLANS[FAMILY].numbers; // mom is already #1 -> add numbers more = plan + 1 seat
    let kid = null;
    for (let i = 0; i < extra; i += 1) {
      const p = `+66897${String(seq).padStart(2, '0')}${String(i).padStart(4, '0')}`;
      const label = i === extra - 1 ? 'child' : 'father';
      assert.equal(requestProtected(m, { phone: p, label }).ok, true);
      confirmProtected(m, p);
      kid = p;
    }
    return { m, mom, kid, seatEnd: now + 10 * DAY };
  }

  it('publicHousehold reports the active seat count', () => {
    const { m } = seated();
    assert.equal(publicHousehold(m).seatsPaid, 1);
    assert.equal(publicHousehold(m).protectedMax, PLANS[FAMILY].numbers + 1);
  });

  it('reminds the payer 2 days before the seat ends, naming who will drop', async () => {
    const { m, seatEnd } = seated();
    const o = outbox();
    await runLifecycle(m, seatEnd - 2 * DAY + 1000, o.deps);
    assert.equal(o.sent.length, 1);
    assert.match(o.sent[0].text, /ลูก/);
  });

  it('after the seat ends: 3-day grace, then that phone stops (SMS ##002# once) and the gate rejects it', async () => {
    const { m, mom, kid, seatEnd } = seated();
    const o = outbox();
    await runLifecycle(m, seatEnd + 1000, o.deps); // "seat ended" notice starts grace
    assert.equal(protectedOf(m).find((e) => e.phone === kid).suspendedAt, undefined);
    await runLifecycle(m, seatEnd + GRACE_DAYS * DAY + 2000, o.deps);
    await runLifecycle(m, seatEnd + GRACE_DAYS * DAY + 9000, o.deps);
    const toKid = o.sent.filter((x) => x.to === kid);
    assert.equal(toKid.length, 1);
    assert.match(toKid[0].text, /##002#/);
    assert.ok(protectedOf(m).find((e) => e.phone === kid).suspendedAt);
    assert.equal(resolveIncoming({ from: '+66811110077', forwardedFrom: kid, mode: 'B' }).reason, 'seat-expired');
    assert.equal(resolveIncoming({ from: '+66811110077', forwardedFrom: mom, mode: 'B' }).member?.id, m.id);
  });

  it('renewing the seat brings the phone back', async () => {
    const { m, kid, seatEnd } = seated();
    const o = outbox();
    await runLifecycle(m, seatEnd + 1000, o.deps);
    await runLifecycle(m, seatEnd + GRACE_DAYS * DAY + 2000, o.deps);
    m.seats.push({ paidAt: new Date().toISOString(), paidUntil: new Date(seatEnd + 60 * DAY).toISOString() });
    await runLifecycle(m, seatEnd + GRACE_DAYS * DAY + 5000, o.deps);
    assert.equal(protectedOf(m).find((e) => e.phone === kid).suspendedAt, undefined);
  });
});

describe('trial already used (tombstone re-signup)', () => {
  it('is lapsed at once — no grace, no texts — and the gate rejects until a plan is paid', async () => {
    const { m, mom } = household({ line: 'Udenied' });
    m.trialDenied = true;
    m.trialEndsAt = new Date().toISOString();
    const lc = lifecycleOf(m);
    assert.equal(lc.state, 'lapsed');
    assert.equal(lc.denied, true);
    const o = outbox();
    await runLifecycle(m, Date.now() + 1000, o.deps);
    await runLifecycle(m, Date.now() + 5 * DAY, o.deps);
    assert.equal(o.sent.length, 0);
    assert.equal(resolveIncoming({ from: '+66811115555', forwardedFrom: mom, mode: 'B' }).reason, 'lapsed');
    m.planPaidUntil = new Date(Date.now() + 30 * DAY).toISOString(); // pays
    assert.equal(lifecycleOf(m).state, 'paid');
    assert.equal(resolveIncoming({ from: '+66811115555', forwardedFrom: mom, mode: 'B' }).member?.id, m.id);
  });
});

describe('trial call allowance (TRIAL.calls)', () => {
  it('answering the last trial call ends the trial at that moment', () => {
    const { m, mom } = household({ line: 'Utrial5' });
    for (let i = 0; i < TRIAL.calls - 1; i += 1) createCall({ memberId: m.id, callerPhone: `+6681998${String(1000 + i)}`, aiNumber: '', source: 'twilio' });
    assert.equal(lifecycleOf(m).state, 'trial');
    assert.equal(allowAnswer(m, { from: '+66811116666', protectedPhone: mom, via: 'forwarded' }).ok, true); // the 5th is answered
    assert.ok(m.trialCallsUsedUpAt);
    assert.ok(Date.parse(m.trialEndsAt) <= Date.now());
    assert.equal(lifecycleOf(m).state, 'grace');
  });

  it('a rejected call never uses up the trial', () => {
    const { m, mom } = household({ line: 'Utrial5b' });
    for (let i = 0; i < TRIAL.calls - 1; i += 1) createCall({ memberId: m.id, callerPhone: `+6681997${String(1000 + i)}`, aiNumber: '', source: 'twilio' });
    m.answerLog = { day: new Date().toISOString().slice(0, 10), member: { [mom]: 99 }, caller: {} };
    assert.equal(allowAnswer(m, { from: mom, protectedPhone: mom, via: 'member-call' }).ok, false); // over the cap
    assert.equal(m.trialCallsUsedUpAt, undefined);
  });

  it('using up the trial calls ends the trial now — then the normal notice + 3-day grace (still answered)', async () => {
    const { m, mom } = household({ line: 'Utrialcalls' });
    for (let i = 0; i < TRIAL.calls; i += 1) createCall({ memberId: m.id, callerPhone: `+6681999${String(1000 + i)}`, aiNumber: '', source: 'twilio' });
    assert.equal(lifecycleOf(m).state, 'trial');
    // the next forwarded call: the gate's answer check notices the allowance is spent
    assert.equal(allowAnswer(m, { from: '+66811117777', protectedPhone: mom, via: 'forwarded' }).ok, true);
    assert.ok(m.trialCallsUsedUpAt);
    assert.ok(Date.parse(m.trialEndsAt) <= Date.now());
    assert.equal(lifecycleOf(m).state, 'grace'); // still answered — nobody is cut off silently
    const o = outbox();
    await runLifecycle(m, Date.now() + 1000, o.deps);
    assert.equal(o.sent.length, 1);
    assert.match(o.sent[0].text, new RegExp(`${TRIAL.calls} สาย`));
  });
});
