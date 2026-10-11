// Public stats: floor tiers, brag-gate minimums, purge-proof counters,
// snapshot round-trip, and legacy-snapshot backfill.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMember, createCall, getCall, setVerdict, endCall, purgeCalls,
  serializeStore, restoreStore,
} from '../src/store.js';
import {
  STATS_MIN, floorTier, recordCallEnd, recordMemberJoin, resetStats,
  snapshotStats, restoreStats, getPublicStats,
} from '../src/stats.js';

beforeEach(() => {
  restoreStore({}); // clears members/calls AND zeroes stats (no stats key)
});

function endRealCall(verdict, minutes = 1, source = 'twilio', counted = true) {
  const m = addMember({ ownerPhone: `+6681${Math.floor(Math.random() * 1e7)}`, aiNumber: `+6621${Math.floor(Math.random() * 1e7)}`, counted });
  const call = createCall({ memberId: m.id, callerPhone: '+66819990000', aiNumber: m.aiNumber, source });
  // 5s margin: endCall bills ceil(elapsed), so exact N-minute ages flake to N+1.
  call.startedAt = new Date(Date.now() - (minutes * 60000 - 5000)).toISOString();
  setVerdict(call.id, { verdict, confidence: 0.9 });
  return endCall(call.id);
}

describe('floorTier', () => {
  it('floors to the largest tier at or below the value', () => {
    assert.equal(floorTier(0), 0);
    assert.equal(floorTier(49), 0);
    assert.equal(floorTier(50), 50);
    assert.equal(floorTier(99), 50);
    assert.equal(floorTier(100), 100);
    assert.equal(floorTier(1234), 1000);
    assert.equal(floorTier(999999), 500000);
  });

  it('floors millions past the last tier, clamps garbage to 0', () => {
    assert.equal(floorTier(1000000), 1000000);
    assert.equal(floorTier(2345678), 2000000);
    assert.equal(floorTier(-5), 0);
    assert.equal(floorTier(NaN), 0);
    assert.equal(floorTier('2500'), 2500);
  });
});

describe('recording', () => {
  it('counts real ended calls by verdict plus minutes', () => {
    endRealCall('SCAM', 3);
    endRealCall('LEGIT', 2);
    endRealCall('UNSURE', 1);
    const s = snapshotStats();
    assert.equal(s.calls, 3);
    assert.equal(s.scams, 1);
    assert.equal(s.legit, 1);
    assert.equal(s.unsure, 1);
    assert.equal(s.minutes, 6);
    assert.equal(s.demo, 0);
  });

  it('never counts demo sessions as real calls', () => {
    endRealCall('SCAM', 2, 'demo');
    const s = snapshotStats();
    assert.equal(s.calls, 0);
    assert.equal(s.scams, 0);
    assert.equal(s.minutes, 0);
    assert.equal(s.demo, 1);
  });

  it('counts each call once even when endCall repeats', () => {
    const call = endRealCall('SCAM', 1);
    endCall(call.id);
    endCall(call.id);
    assert.equal(snapshotStats().calls, 1);
  });

  it('counts verdict-less ended calls as unsure, skips unended records', () => {
    recordCallEnd({ source: 'twilio', endedAt: new Date().toISOString(), minutesBilled: 2, verdict: null });
    recordCallEnd({ source: 'twilio', endedAt: null, minutesBilled: 9, verdict: { verdict: 'SCAM' } });
    const s = snapshotStats();
    assert.equal(s.calls, 1);
    assert.equal(s.unsure, 1);
    assert.equal(s.scams, 0);
  });

  it('counts member joins unless the caller opts out (seed fixture)', () => {
    addMember({ ownerPhone: '+66810000001', aiNumber: '+6621000142', counted: false });
    addMember({ ownerPhone: '+66810000002', aiNumber: '+6621000143' });
    assert.equal(snapshotStats().households, 1);
    recordMemberJoin();
    assert.equal(snapshotStats().households, 2);
  });
});

describe('brag gates', () => {
  it('hides every metric below its minimum', () => {
    for (let i = 0; i < STATS_MIN.calls - 1; i += 1) endRealCall('SCAM', 6, 'twilio', false);
    const p = getPublicStats();
    assert.equal(p.calls.shown, false);
    assert.equal(p.calls.display, 0);
    assert.equal(p.scamRate.shown, false); // ratio needs a real base
    assert.equal(p.households.shown, false);
    assert.equal(p.minutes.shown, true); // gates are independent: minutes crossed first
  });

  it('shows floored figures once minimums clear', () => {
    for (let i = 0; i < 120; i += 1) endRealCall(i % 2 ? 'SCAM' : 'LEGIT', 5, 'twilio', false);
    for (let i = 0; i < 60; i += 1) recordMemberJoin();
    const p = getPublicStats();
    assert.deepEqual(p.calls, { value: 120, display: 100, shown: true });
    assert.equal(p.scams.display, 50); // 60 floored
    assert.equal(p.scams.shown, true);
    assert.equal(p.legit.shown, true);
    assert.deepEqual(p.minutes, { value: 600, display: 500, shown: true });
    assert.equal(p.households.display, 50);
    assert.equal(p.scamRate.shown, true);
    assert.ok(Math.abs(p.scamRate.value - 0.5) < 1e-9);
    assert.ok(Date.parse(p.updatedAt) > 0);
  });
});

describe('durability', () => {
  it('survives retention purges (counters outlive records)', () => {
    const call = endRealCall('LEGIT', 4);
    getCall(call.id).endedAt = new Date(Date.now() - 30 * 86400000).toISOString();
    assert.equal(purgeCalls({ LEGIT: 7, UNSURE: 90, SCAM: 365 }), 1);
    assert.equal(getCall(call.id), null);
    const s = snapshotStats();
    assert.equal(s.calls, 1);
    assert.equal(s.minutes, 4);
  });

  it('round-trips through snapshots (JSON-safe, like Firestore)', () => {
    endRealCall('SCAM', 3);
    recordMemberJoin();
    const snap = JSON.parse(JSON.stringify(serializeStore()));
    assert.equal(typeof snap.stats.calls, 'number');
    restoreStore({});
    assert.equal(snapshotStats().calls, 0);
    restoreStore(snap);
    assert.equal(snapshotStats().calls, 1);
    assert.equal(snapshotStats().scams, 1);
    assert.equal(snapshotStats().minutes, 3);
    assert.equal(snapshotStats().households, 2); // endRealCall member + explicit join
  });

  it('backfills legacy snapshots once, never double-counts', () => {
    const call = endRealCall('SCAM', 2);
    const legacy = { members: [], calls: [{ ...getCall(call.id) }] }; // no stats key
    restoreStore(legacy);
    assert.equal(snapshotStats().calls, 1);
    assert.equal(snapshotStats().scams, 1);
    restoreStore(legacy); // restore is a replace, not an add
    assert.equal(snapshotStats().calls, 1);
  });

  it('sanitizes tampered snapshots to safe counts', () => {
    restoreStats({ calls: -50, scams: 'many', legit: NaN, minutes: null, households: 2.9, demo: {} });
    assert.deepEqual(snapshotStats(), {
      calls: 0, scams: 0, legit: 0, unsure: 0, minutes: 0, households: 2, demo: 0,
    });
    resetStats();
    assert.equal(snapshotStats().households, 0);
    restoreStats(null);
    assert.equal(snapshotStats().calls, 0);
  });
});
