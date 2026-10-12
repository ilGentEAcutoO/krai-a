// Background jobs: the trial-lifecycle sweep runs hourly on an unref'd
// timer, never under NODE_ENV=test, and is idempotent — a second sweep, or a
// sweep after a restart from the snapshot, sends nothing new; the snapshot
// is flushed right after any sweep that sent a notice.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { addMember, serializeStore, restoreStore } from '../src/store.js';
import { startJobs, lifecycleTick, staleCallsTick, LIFECYCLE_EVERY_MS, STALE_CALLS_EVERY_MS } from '../src/jobs.js';

config.thsmsApiKey = ''; // never a real SMS from this suite
config.lineChannelAccessToken = '';

const DAY = 86400000;

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

describe('startJobs()', () => {
  it('never starts under NODE_ENV=test', () => {
    let calls = 0;
    const bump = () => { calls += 1; };
    assert.equal(startJobs({ env: 'test', tick: bump, staleTick: bump }), null);
    assert.equal(calls, 0);
  });

  it('runs once at boot, then hourly (lifecycle) and every 5 min (stale calls), never holding the process open', () => {
    const calls = { life: 0, stale: 0 };
    const t = startJobs({ env: 'production', tick: () => { calls.life += 1; }, staleTick: () => { calls.stale += 1; } });
    try {
      assert.deepEqual(calls, { life: 1, stale: 1 }, 'one run of each at boot');
      assert.equal(LIFECYCLE_EVERY_MS, 3600000);
      assert.equal(STALE_CALLS_EVERY_MS, 300000);
      assert.equal(t.lifecycle.hasRef(), false, 'unref');
      assert.equal(t.stale.hasRef(), false, 'unref');
    } finally {
      clearInterval(t.lifecycle);
      clearInterval(t.stale);
    }
  });
});

describe('lifecycleTick() is idempotent', () => {
  it('sends a notice once — not again on the next tick, after a restart, or until the next day', async () => {
    const m = addMember({ ownerPhone: '+66810006601', aiNumber: '+66210006601', plan: 'family-149' });
    const now = Date.now();
    m.lifecycleV = 1; // born under trial enforcement (no legacy fresh-trial migration)
    m.trialEndsAt = new Date(now - DAY).toISOString(); // trial already over
    const box = outbox();
    let saves = 0;
    const save = async () => { saves += 1; };

    assert.equal(await lifecycleTick({ now, deps: box.deps, save }), 1, 'T-0 notice');
    assert.equal(box.sent.length, 1);
    assert.equal(saves, 1, 'snapshot flushed right after sending');

    assert.equal(await lifecycleTick({ now: now + 3600000, deps: box.deps, save }), 0, 'next hour: nothing new');
    assert.equal(saves, 1);

    restoreStore(JSON.parse(JSON.stringify(serializeStore()))); // simulated restart
    assert.equal(await lifecycleTick({ now: now + 7200000, deps: box.deps, save }), 0, 'after restart: nothing new');
    assert.equal(box.sent.length, 1);

    assert.equal(await lifecycleTick({ now: now + DAY + 60000, deps: box.deps, save }), 1, 'next day: one grace reminder');
    assert.equal(box.sent.length, 2);
  });

  it('never runs two sweeps at once and never throws', async () => {
    let running = 0; let peak = 0;
    const sweep = async () => { running += 1; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 20)); running -= 1; return 0; };
    await Promise.all([lifecycleTick({ sweep }), lifecycleTick({ sweep })]);
    assert.equal(peak, 1);
    assert.equal(await lifecycleTick({ sweep: async () => { throw new Error('boom'); } }), 0);
  });
});

describe('staleCallsTick()', () => {
  it('saves only when calls were closed, never overlaps, never throws', async () => {
    let saves = 0;
    const save = async () => { saves += 1; };
    assert.equal(await staleCallsTick({ close: async () => 0, save }), 0);
    assert.equal(saves, 0);
    assert.equal(await staleCallsTick({ close: async () => 2, save }), 2);
    assert.equal(saves, 1);
    let running = 0; let peak = 0;
    const slow = async () => { running += 1; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 20)); running -= 1; return 0; };
    await Promise.all([staleCallsTick({ close: slow, save }), staleCallsTick({ close: slow, save })]);
    assert.equal(peak, 1);
    assert.equal(await staleCallsTick({ close: async () => { throw new Error('boom'); }, save }), 0);
  });
});
