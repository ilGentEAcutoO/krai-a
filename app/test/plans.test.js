// Plan, quota, cancel, and family-number tests: 3-tier trial-first pricing,
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
  it('exposes 3 trial-first tiers with quota/calls/numbers/watchers/tapes', () => {
    assert.deepEqual(Object.keys(PLANS), ['starter-20', 'plus-100', 'family-149']);
    assert.deepEqual(PLANS['starter-20'], { price: 20, usd: 2, pppOff: 71, quota: 10, calls: 5, numbers: 1, watchers: 0, tapes: false });
    assert.deepEqual(PLANS['plus-100'], { price: 100, usd: 6, pppOff: 52, quota: 50, calls: 25, numbers: 1, watchers: 0, tapes: true });
    assert.deepEqual(PLANS['family-149'], { price: 149, usd: 8, pppOff: 47, quota: 50, calls: 25, numbers: 2, watchers: 2, tapes: true });
    assert.equal(TRIAL_DAYS, 7);
  });

  it('pins quota/calls/tapes/watchers ladder (family matches plus quota)', () => {
    const tiers = ['starter-20', 'plus-100', 'family-149'];
    assert.deepEqual(tiers.map((p) => PLANS[p].quota), [10, 50, 50]);
    assert.deepEqual(tiers.map((p) => PLANS[p].calls), [5, 25, 25]);
    assert.deepEqual(tiers.map((p) => PLANS[p].tapes), [false, true, true]);
    assert.deepEqual(tiers.map((p) => PLANS[p].watchers), [0, 0, 2]);
  });

  it('prices extra household seats at +69 with a plus-sized chunk', () => {
    assert.deepEqual(ADDON_SEAT, { price: 69, usd: 3, quota: 50, calls: 25, numbers: 1 });
  });

  it('caps households at 5 seats (family base + addon seats)', () => {
    assert.equal(MAX_HOUSEHOLD_SEATS, 5);
    assert.equal(PLANS['family-149'].numbers + 3 * ADDON_SEAT.numbers, MAX_HOUSEHOLD_SEATS);
  });

  it('planOf falls back to starter for unknown plans', () => {
    assert.equal(planOf({ plan: 'nope' }), PLANS['starter-20']);
    assert.equal(planOf(null), PLANS['starter-20']);
  });
});

describe('member plan lifecycle', () => {
  const m = addMember({ ownerPhone: '+66810000901', aiNumber: '+6621000191', plan: 'family-149' });

  it('starts with a 7-day trial and active membership', () => {
    assert.equal(m.plan, 'family-149');
    assert.equal(m.active, true);
    assert.equal(m.cancelledAt, null);
    assert.ok(trialDaysLeft(m) >= 6 && trialDaysLeft(m) <= 7);
    assert.deepEqual(m.numbers, ['+6621000191']);
  });

  it('switches plans and rejects invalid ones', () => {
    assert.equal(setPlan(m.id, 'plus-100').plan, 'plus-100');
    assert.equal(planOf(getMemberById(m.id)).quota, 50);
    assert.equal(setPlan(m.id, 'yearly-999'), null);
    assert.equal(getMemberById(m.id).plan, 'plus-100');
    setPlan(m.id, 'family-149');
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
    assert.equal(r.plan, 'family-149');
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
  const m = addMember({ ownerPhone: '+66810000902', aiNumber: '+6621000192', plan: 'family-149' });

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

  it('keeps starter at a single number via plan meta', () => {
    const s = addMember({ ownerPhone: '+66810000903', aiNumber: '+6621000195', plan: 'starter-20' });
    assert.equal(planOf(s).numbers, 1);
  });
});

describe('extra family seats (OTP-gated)', () => {
  it('caps seats at plan base + paid, max 5', () => {
    const m = addMember({ ownerPhone: '+66810000911', aiNumber: '+6621000191', plan: 'family-149' });
    assert.equal(seatCap(m), 2);
    m.seatsPaid = 2;
    assert.equal(seatCap(m), 4);
    m.seatsPaid = 9;
    assert.equal(seatCap(m), 5);
    const s = addMember({ ownerPhone: '+66810000912', aiNumber: '+6621000192', plan: 'starter-20' });
    assert.equal(seatCap(s), 1);
  });

  it('requests, reuses, confirms, and caps seats', async () => {
    const m = addMember({ ownerPhone: '+66810000913', aiNumber: '+6621000193', plan: 'family-149' });
    const a = await assignNumber();
    assert.equal(a.ok, true);
    const seat = requestSeat(m.id, a.number, '+66811110001');
    assert.equal(seat.aiNumber, a.number);
    assert.equal(requestSeat(m.id, '+66219999999', '+66811110001').aiNumber, a.number); // resend reuses
    assert.equal(requestSeat(m.id, '+66219999998', '+66811110002'), null); // over cap
    const nums = confirmSeat(m.id, a.number);
    assert.ok(nums.includes(a.number));
    assert.equal(getMemberById(m.id).pendingSeats.length, 0);
  });

  it('prunes expired seats and releases the number', async () => {
    const m = addMember({ ownerPhone: '+66810000914', aiNumber: '+6621000194', plan: 'family-149' });
    const a = await assignNumber();
    requestSeat(m.id, a.number, '+66811110003');
    getMemberById(m.id).pendingSeats[0].requestedAt = new Date(Date.now() - SEAT_TTL_MS - 1000).toISOString();
    pruneSeats(m.id);
    assert.equal(getMemberById(m.id).pendingSeats.length, 0);
    const b = await assignNumber();
    assert.equal(b.ok, true); // pool not leaked
  });
});
