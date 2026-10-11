// Persistence round-trips: store/auth serialize+restore, Firestore value
// codec. No live Firestore here (needs metadata server) — the REST shape is
// covered by _enc/_dec unit tests + a manual CLI probe at setup time.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMember, getMemberById, createCall, getCall, addTurn, setVerdict,
  setReputation, getReputation, serializeStore, restoreStore,
} from '../src/store.js';
import { requestOtp, verifyOtp, createSession, getSession, serializeAuth, restoreAuth } from '../src/auth.js';
import { _enc, _dec } from '../src/persist/firestore.js';

describe('store snapshot round-trip', () => {
  it('members, calls, verdicts, reputation survive serialize/restore', () => {
    const m = addMember({ ownerPhone: '+6681400001', aiNumber: '+6621400001' });
    const call = createCall({ memberId: m.id, callerPhone: '+6681400002', aiNumber: '+6621400001', source: 'demo' });
    addTurn(call.id, 'caller', 'สวัสดีครับ ขอ otp หน่อย');
    setVerdict(call.id, { verdict: 'SCAM', confidence: 0.95 });
    setReputation(m.id, '+6681400002', { verdict: 'SCAM', confidence: 0.95, signals: [] }, 60);
    const snap = serializeStore();

    restoreStore({}); // simulate fresh boot
    assert.equal(getMemberById(m.id), null);
    assert.equal(getCall(call.id), null);

    restoreStore(JSON.parse(JSON.stringify(snap))); // through JSON, like Firestore
    assert.equal(getMemberById(m.id).ownerPhone, '+6681400001');
    assert.equal(getCall(call.id).turns.length, 1);
    assert.equal(getCall(call.id).verdict.verdict, 'SCAM');
    assert.equal(getReputation(m.id, '+6681400002').verdict, 'SCAM');
  });
});

describe('auth snapshot round-trip', () => {
  it('sessions and pending OTPs survive serialize/restore', () => {
    requestOtp('+6681400003');
    const t = createSession('m_persist');
    const snap = serializeAuth();

    restoreAuth({});
    assert.equal(getSession(t), null);

    restoreAuth(JSON.parse(JSON.stringify(snap)));
    assert.equal(getSession(t).memberId, 'm_persist');
    assert.equal(verifyOtp('+6681400003', '000000').error, 'wrong-code'); // record present
  });
});

describe('firestore codec', () => {
  it('round-trips nested types incl. thai, ints, nulls, empty arrays', () => {
    const obj = {
      s: 'สวัสดี otp ครับ',
      i: 7,
      f: 0.95,
      b: true,
      n: null,
      u: undefined,
      arr: [1, 'x', null],
      empty: [],
      nested: { a: [{ b: 2 }] },
    };
    const back = _dec(_enc(obj));
    assert.equal(back.s, obj.s);
    assert.equal(back.i, 7);
    assert.equal(back.f, 0.95);
    assert.equal(back.b, true);
    assert.equal(back.n, null);
    assert.equal(back.u, null); // undefined -> null
    assert.deepEqual(back.arr, [1, 'x', null]);
    assert.deepEqual(back.empty, []);
    assert.deepEqual(back.nested, { a: [{ b: 2 }] });
  });
});
