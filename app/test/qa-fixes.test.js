// QA (TASK-017) fixes: the owner alert says "ใครอะ", names the protected
// person the call was forwarded from, and formats numbers like the app;
// calls used per period is a counter that deleting or purging a call record
// can never refund.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMember, createCall, deleteCall, purgeCalls, endCall, quotaSummary, serializeStore, restoreStore, getMemberById,
} from '../src/store.js';
import { buildMessage, buildFlexMessage, buildQuotaLowMessage, buildQuotaLowFlex } from '../src/notify/index.js';
import { otpMessage } from '../src/sms.js';

let n = 0;
const member = (extra = {}) => {
  n += 1;
  return addMember({ ownerPhone: `+668100055${String(n).padStart(2, '0')}`, aiNumber: `+662100055${String(n).padStart(2, '0')}`, plan: 'plus-100', ...extra });
};
const verdict = { verdict: 'SCAM', confidence: 0.95, reason: 'ขอโอนเงิน', reasonEn: 'transfer', engine: 'rule' };

describe('owner alert copy', () => {
  it('uses the brand ใครอะ everywhere (never ใครอ่ะ)', () => {
    const m = member();
    const call = { callerPhone: '+66812220001', turns: [], minutesBilled: 1 };
    const quota = { remaining: 1, quota: 10, callsRemaining: 1, usedPct: 0.9, resetAt: new Date().toISOString(), autoTopup: {} };
    const blob = JSON.stringify([
      buildMessage({ call, member: m, verdict }), buildFlexMessage({ call, member: m, verdict }),
      buildQuotaLowMessage({ quota }), buildQuotaLowFlex({ quota }), buildQuotaLowMessage({ quota, level: 'out' }), otpMessage('123456'),
    ]);
    assert.doesNotMatch(blob, /ใครอ่ะ/);
    assert.match(blob, /ใครอะ/);
  });

  it('names the protected person the call was forwarded from, numbers formatted like the app', () => {
    const m = member();
    m.protected = [{ phone: m.ownerPhone, label: 'self' }, { phone: '+66890000202', label: 'mother' }];
    const call = { callerPhone: '+66812220001', protectedPhone: '+66890000202', turns: [], minutesBilled: 1 };
    const text = buildMessage({ call, member: m, verdict }).text;
    assert.match(text, /081-222-0001/);
    assert.doesNotMatch(text, /\+66812220001/);
    assert.match(text, /แม่ 089-000-0202/);
    const flex = JSON.stringify(buildFlexMessage({ call, member: m, verdict }));
    assert.match(flex, /081-222-0001/);
    assert.match(flex, /แม่/);
    assert.doesNotMatch(flex, /\+66812220001/);
  });

  it('a call to the payer\'s own phone says เบอร์คุณ; landlines format too', () => {
    const m = member();
    const self = buildMessage({ call: { callerPhone: '+6621002003', protectedPhone: m.ownerPhone, turns: [], minutesBilled: 1 }, member: m, verdict }).text;
    assert.match(self, /02-100-2003/);
    assert.match(self, /เบอร์คุณ/);
    const legacy = buildMessage({ call: { callerPhone: '+6621002003', turns: [], minutesBilled: 1 }, member: m, verdict }).text;
    assert.match(legacy, /เบอร์คุณ/, 'no protectedPhone (mode A) = the payer');
  });
});

describe('calls used is a counter, not a count of surviving records', () => {
  it('deleting a transcript or the retention purge never refunds call quota', () => {
    const m = member();
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      const c = createCall({ memberId: m.id, callerPhone: `+6681222000${i}`, aiNumber: m.aiNumber, source: 'twilio' });
      endCall(c.id);
      ids.push(c.id);
    }
    assert.equal(quotaSummary(m).callsUsed, 3);
    deleteCall(ids[0]);
    assert.equal(quotaSummary(m).callsUsed, 3, 'delete does not refund');
    const old = createCall({ memberId: m.id, callerPhone: '+66812220009', aiNumber: m.aiNumber, source: 'twilio' });
    endCall(old.id);
    old.endedAt = new Date(Date.now() - 400 * 86400000).toISOString(); // past every retention window
    purgeCalls();
    assert.equal(quotaSummary(m).callsUsed, 4, 'purge does not refund');
  });

  it('the counter survives a restart; legacy snapshots are backfilled from this month\'s calls', () => {
    const m = member();
    createCall({ memberId: m.id, callerPhone: '+66812220010', aiNumber: m.aiNumber, source: 'twilio' });
    restoreStore(JSON.parse(JSON.stringify(serializeStore())));
    assert.equal(quotaSummary(getMemberById(m.id)).callsUsed, 1);
    const snap = JSON.parse(JSON.stringify(serializeStore()));
    const legacy = snap.members.find((x) => x.id === m.id);
    delete legacy.callsUsed; // pre-counter snapshot
    restoreStore(snap);
    assert.equal(quotaSummary(getMemberById(m.id)).callsUsed, 1, 'backfilled from surviving records once');
  });
});
