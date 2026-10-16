// Persistence round-trips: store/auth serialize+restore, Firestore value
// writes through the Firebase Admin SDK. No live Firestore here: a fake
// db stands in for firebase-admin's Firestore (doc().get()/set()).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMember, getMemberById, createCall, getCall, addTurn, setVerdict,
  setReputation, getReputation, serializeStore, restoreStore,
} from '../src/store.js';
import { requestOtp, verifyOtp, createSession, getSession, serializeAuth, restoreAuth } from '../src/auth.js';
import { loadSnapshot, saveSnapshot, _setDb, persistDatabase, _databaseId } from '../src/persist/firestore.js';

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
  it('sessions survive serialize/restore; live OTP codes are never persisted', () => {
    requestOtp('+6681400003');
    const t = createSession('m_persist');
    const snap = serializeAuth();

    restoreAuth({});
    assert.equal(getSession(t), null);

    restoreAuth(JSON.parse(JSON.stringify(snap)));
    assert.equal(getSession(t).memberId, 'm_persist');
    assert.equal(verifyOtp('+6681400003', '000000').error, 'code-expired'); // codes stay out of snapshots
  });
});

describe('firestore snapshot (firebase-admin)', () => {
  it('stores plain JSON (thai, ints, nulls, empty arrays; undefined dropped) and reads it back', async () => {
    const docs = new Map();
    _setDb({ doc: (p) => ({
      get: async () => ({ exists: docs.has(p), data: () => structuredClone(docs.get(p)) }),
      set: async (v) => { docs.set(p, v); },
    }) });
    try {
      const obj = { s: 'สวัสดี otp ครับ', i: 7, f: 0.95, b: true, n: null, u: undefined, d: new Date('2026-10-16T00:00:00Z'),
        arr: [1, 'x', null], empty: [], nested: { a: [{ b: 2 }] } };
      await saveSnapshot('krai/test', obj);
      const back = await loadSnapshot('krai/test');
      assert.deepEqual(back, { s: obj.s, i: 7, f: 0.95, b: true, n: null, d: '2026-10-16T00:00:00.000Z',
        arr: [1, 'x', null], empty: [], nested: { a: [{ b: 2 }] } });
      assert.equal(await loadSnapshot('krai/missing'), null);
    } finally { _setDb(null); }
  });

  it('refuses to touch Firestore off Cloud Run (a laptop with gcloud credentials stays in-memory)', async () => {
    const saved = { k: process.env.K_SERVICE, e: process.env.FIRESTORE_EMULATOR_HOST };
    delete process.env.K_SERVICE; delete process.env.FIRESTORE_EMULATOR_HOST;
    try {
      await assert.rejects(loadSnapshot('krai/snapshot'), /not-on-cloud-run/);
      await assert.rejects(saveSnapshot('krai/snapshot', {}), /not-on-cloud-run/);
    } finally {
      if (saved.k !== undefined) process.env.K_SERVICE = saved.k;
      if (saved.e !== undefined) process.env.FIRESTORE_EMULATOR_HOST = saved.e;
    }
  });
});

describe('firestore database per role (PERSIST_DATABASE)', () => {
  const withEnv = async (vars, fn) => {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    _setDb(null);
    try { return await fn(); } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      _setDb(null);
    }
  };

  it('defaults to "(default)" and accepts a valid database id', async () => {
    await withEnv({ PERSIST_DATABASE: undefined }, () => assert.equal(persistDatabase(), '(default)'));
    await withEnv({ PERSIST_DATABASE: '(default)' }, () => assert.equal(persistDatabase(), '(default)'));
    await withEnv({ PERSIST_DATABASE: ' hackathon ' }, () => assert.equal(persistDatabase(), 'hackathon'));
  });

  it('refuses malformed ids instead of falling back to the member database', async () => {
    for (const bad of ['Hackathon', 'hack_athon', 'ab', '../(default)', 'projects/krai-a/databases/(default)', '1hack']) {
      await withEnv({ PERSIST_DATABASE: bad }, () => assert.throws(() => persistDatabase(), /bad-persist-database/));
    }
    await withEnv({ PERSIST_DATABASE: 'Bad_DB', FIRESTORE_EMULATOR_HOST: '127.0.0.1:1' }, async () => {
      await assert.rejects(loadSnapshot('krai/hackathon'), /bad-persist-database/);
    });
  });

  it('opens the configured database through firebase-admin (no network call)', async () => {
    await withEnv({ PERSIST_DATABASE: 'hackathon', FIRESTORE_EMULATOR_HOST: '127.0.0.1:1' }, async () => {
      assert.equal(await _databaseId(), 'hackathon');
    });
    await withEnv({ PERSIST_DATABASE: undefined, FIRESTORE_EMULATOR_HOST: '127.0.0.1:1' }, async () => {
      assert.equal(await _databaseId(), '(default)');
    });
  });
});
