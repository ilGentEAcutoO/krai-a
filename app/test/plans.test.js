// Plan, quota, cancel, and family-number tests: 2-tier trial-first pricing (v2),
// per-plan quotas, cancel/reactivate, multi-number aliasing, LINE linking.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMember, getMemberById, findMember, PLANS, ADDON_SEAT, MAX_HOUSEHOLD_SEATS, TRIAL_DAYS, planOf,
  trialDaysLeft, setPlan, addNumber, cancelMember, reactivateMember,
  requestSeat, confirmSeat, pruneSeats, seatCap, SEAT_TTL_MS,
  setLineUserId, setForwardingConfirmed,
} from '../src/store.js';
import { assignNumber } from '../src/numbers.js';

describe('plans catalog', () => {
  it('sells two trial-first tiers (pricing v2): Solo 99 and Family 199', () => {
    assert.deepEqual(Object.keys(PLANS), ['solo-99', 'family-199']);
    assert.deepEqual(PLANS['solo-99'], { name: 'Solo', price: 99, usd: 3, annual: 890, quota: 60, calls: 30, numbers: 1, watchers: 3 });
    assert.deepEqual(PLANS['family-199'], { name: 'Family', price: 199, usd: 6, annual: 1790, quota: 180, calls: 90, numbers: 3, watchers: null });
    assert.equal(TRIAL_DAYS, 7);
  });

  it('annual is about 25% off twelve months', () => {
    for (const p of Object.values(PLANS)) assert.ok(p.annual < p.price * 12 * 0.8 && p.annual > p.price * 12 * 0.7);
  });

  it('prices extra household seats at +59 with a solo-sized chunk', () => {
    assert.deepEqual(ADDON_SEAT, { price: 59, usd: 2, quota: 60, calls: 30, numbers: 1 });
  });

  it('caps households at 5 seats (family base 3 + 2 addon seats)', () => {
    assert.equal(MAX_HOUSEHOLD_SEATS, 5);
    assert.equal(PLANS['family-199'].numbers + 2 * ADDON_SEAT.numbers, MAX_HOUSEHOLD_SEATS);
  });

  it('planOf falls back to solo for unknown plans', () => {
    assert.equal(planOf({ plan: 'nope' }), PLANS['solo-99']);
    assert.equal(planOf(null), PLANS['solo-99']);
  });
});

describe('member plan lifecycle', () => {
  const m = addMember({ ownerPhone: '+66810000901', aiNumber: '+6621000191', plan: 'family-199' });

  it('starts with a 7-day trial and active membership', () => {
    assert.equal(m.plan, 'family-199');
    assert.equal(m.active, true);
    assert.equal(m.cancelledAt, null);
    assert.ok(trialDaysLeft(m) >= 6 && trialDaysLeft(m) <= 7);
    assert.deepEqual(m.numbers, ['+6621000191']);
  });

  it('switches plans and rejects invalid ones', () => {
    assert.equal(setPlan(m.id, 'solo-99').plan, 'solo-99');
    assert.equal(planOf(getMemberById(m.id)).quota, 60);
    assert.equal(setPlan(m.id, 'yearly-999'), null);
    assert.equal(getMemberById(m.id).plan, 'solo-99');
    setPlan(m.id, 'family-199');
  });

  it('cancels and reactivates without losing data', () => {
    cancelMember(m.id);
    const c = getMemberById(m.id);
    assert.equal(c.active, false);
    assert.ok(c.cancelledAt);
    reactivateMember(m.id);
    const r = getMemberById(m.id);
    assert.equal(r.active, true);
    assert.equal(r.cancelledAt, null);
    assert.equal(r.plan, 'family-199');
  });

  it('tracks forwarding opt-out (##21# status)', () => {
    setForwardingConfirmed(m.id, true);
    assert.equal(getMemberById(m.id).forwardingConfirmed, true);
    setForwardingConfirmed(m.id, false);
    assert.equal(getMemberById(m.id).forwardingConfirmed, false);
  });

  it('links and unlinks LINE (optional channel)', () => {
    setLineUserId(m.id, 'U1234');
    assert.equal(getMemberById(m.id).lineUserId, 'U1234');
    setLineUserId(m.id, '');
    assert.equal(getMemberById(m.id).lineUserId, '');
  });
});

describe('family numbers', () => {
  const m = addMember({ ownerPhone: '+66810000902', aiNumber: '+6621000192', plan: 'family-199' });

  it('adds numbers up to the plan limit and aliases each to the member', () => {
    addNumber(m.id, '+6621000193');
    assert.deepEqual(getMemberById(m.id).numbers, ['+6621000192', '+6621000193']);
    for (const n of ['+6621000192', '+6621000193']) {
      const { member, reason } = findMember({ to: n, forwardedFrom: '', mode: 'A' });
      assert.equal(reason, 'ok');
      assert.equal(member.id, m.id);
    }
  });

  it('dedupes repeated numbers', () => {
    addNumber(m.id, '+6621000193');
    assert.equal(getMemberById(m.id).numbers.length, 2);
  });

  it('keeps solo at a single number via plan meta', () => {
    const s = addMember({ ownerPhone: '+66810000903', aiNumber: '+6621000195', plan: 'solo-99' });
    assert.equal(planOf(s).numbers, 1);
  });
});

describe('extra family seats (OTP-gated)', () => {
  it('caps seats at plan base + paid, max 5', () => {
    const m = addMember({ ownerPhone: '+66810000911', aiNumber: '+6621000191', plan: 'family-199' });
    assert.equal(seatCap(m), 3);
    m.seatsPaid = 1;
    assert.equal(seatCap(m), 4);
    m.seatsPaid = 9;
    assert.equal(seatCap(m), 5);
    const s = addMember({ ownerPhone: '+66810000912', aiNumber: '+6621000192', plan: 'solo-99' });
    assert.equal(seatCap(s), 1);
  });

  it('requests, reuses, confirms, and caps seats', async () => {
    const m = addMember({ ownerPhone: '+66810000913', aiNumber: '+6621000193', plan: 'family-199' });
    const a = await assignNumber();
    assert.equal(a.ok, true);
    const seat = requestSeat(m.id, a.number, '+66811110001');
    assert.equal(seat.aiNumber, a.number);
    assert.equal(requestSeat(m.id, '+66219999999', '+66811110001').aiNumber, a.number); // resend reuses
    assert.ok(requestSeat(m.id, '+66219999998', '+66811110002')); // family has room for a third
    assert.equal(requestSeat(m.id, '+66219999997', '+66811110005'), null); // over cap
    const nums = confirmSeat(m.id, a.number);
    assert.ok(nums.includes(a.number));
    assert.equal(getMemberById(m.id).pendingSeats.length, 1);
  });

  it('prunes expired seats and releases the number', async () => {
    const m = addMember({ ownerPhone: '+66810000914', aiNumber: '+6621000194', plan: 'family-199' });
    const a = await assignNumber();
    requestSeat(m.id, a.number, '+66811110003');
    getMemberById(m.id).pendingSeats[0].requestedAt = new Date(Date.now() - SEAT_TTL_MS - 1000).toISOString();
    pruneSeats(m.id);
    assert.equal(getMemberById(m.id).pendingSeats.length, 0);
    const b = await assignNumber();
    assert.equal(b.ok, true); // pool not leaked
  });
});
