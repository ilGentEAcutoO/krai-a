// Quota-low warning: one alert per billing period when minutes or calls
// run low, tailored copy for auto-topup vs manual members, never throws.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import {
  addMember, createCall, consumeMinutes, setAutoTopup, quotaPeriodKey,
  PLANS,
} from '../src/store.js';

import {
  buildQuotaLowMessage, buildQuotaLowFlex, maybeNotifyQuotaLow,
} from '../src/notify/index.js';

// Quota mechanics run on two small fixture plans with round numbers (the real
// catalog — Solo 99 / Family 199 — is pinned in plans.test.js and
// pricing-v2.test.js). Added to PLANS in this test process only.
PLANS['fixture-small'] = { name: 'Fixture S', price: 20, usd: 2, annual: 200, quota: 10, calls: 5, numbers: 1, watchers: 0 };
PLANS['fixture-mid'] = { name: 'Fixture M', price: 100, usd: 6, annual: 1000, quota: 50, calls: 25, numbers: 1, watchers: 0 };

const savedAdapters = [...config.notifyAdapters];
const savedBase = config.publicBaseUrl;
afterEach(() => { config.notifyAdapters = [...savedAdapters]; config.publicBaseUrl = savedBase; });

let seq = 0;
const freshMember = (plan = 'fixture-small') => {
  seq += 1;
  return addMember({ ownerPhone: `+668100009${String(seq).padStart(2, '0')}`, aiNumber: `+662100019${String(seq).padStart(2, '0')}`, plan });
};

describe('maybeNotifyQuotaLow', () => {
  it('stays silent when quota is healthy', async () => {
    config.notifyAdapters = ['console'];
    const m = freshMember('fixture-mid');
    const r = await maybeNotifyQuotaLow(m);
    assert.deepEqual(r, { warned: false, reason: 'quota-healthy' });
    assert.equal(m.quotaWarnedPeriod, '');
  });

  it('warns once per period when minutes run low', async () => {
    config.notifyAdapters = ['console'];
    const m = freshMember('fixture-small');
    consumeMinutes(m, 9); // remaining 1 <= default threshold 5
    const first = await maybeNotifyQuotaLow(m);
    assert.equal(first.warned, true);
    assert.equal(first.results[0].ok, true);
    assert.equal(first.quota.remaining, 1);
    assert.equal(m.quotaWarnedPeriod, quotaPeriodKey());
    assert.match(first.results[0].detail, /logged/);
    const second = await maybeNotifyQuotaLow(m);
    assert.deepEqual(second, { warned: false, reason: 'already-warned' });
  });

  it('warns again in a new period after a stale stamp', async () => {
    config.notifyAdapters = ['console'];
    const m = freshMember('fixture-small');
    consumeMinutes(m, 9);
    m.quotaWarnedPeriod = '2000-01'; // warned long ago, still low now
    const r = await maybeNotifyQuotaLow(m);
    assert.equal(r.warned, true);
    assert.equal(m.quotaWarnedPeriod, quotaPeriodKey());
  });

  it('warns when calls run out even with minutes left', async () => {
    config.notifyAdapters = ['console'];
    const m = freshMember('fixture-small'); // 10 min / 5 calls
    for (let i = 0; i < 5; i += 1) {
      createCall({ memberId: m.id, callerPhone: `+668139901${i}`, aiNumber: m.aiNumber, source: 'demo' });
    }
    const r = await maybeNotifyQuotaLow(m);
    assert.equal(r.warned, true);
    assert.equal(r.quota.callsRemaining, 0);
  });

  it('uses the member threshold when auto-topup is armed', async () => {
    config.notifyAdapters = ['console'];
    const m = freshMember('fixture-mid');
    setAutoTopup(m, { enabled: true, threshold: 30 });
    consumeMinutes(m, 25); // remaining 25 <= 30
    const r = await maybeNotifyQuotaLow(m);
    assert.equal(r.warned, true);
  });

  it('never throws for unknown members or odd shapes', async () => {
    assert.equal((await maybeNotifyQuotaLow(null)).reason, 'unknown-member');
    assert.equal((await maybeNotifyQuotaLow(undefined)).reason, 'unknown-member');
  });
});

describe('quota-low copy', () => {
  it('reassures auto-topup card members, nudges the rest to top up', () => {
    const card = freshMember('fixture-small');
    card.payMethod = 'card';
    card.stripeCustomerId = 'cus_warn_1';
    setAutoTopup(card, { enabled: true, threshold: 30 });
    consumeMinutes(card, 9);
    const auto = buildQuotaLowMessage({ member: card, quota: { remaining: 1, quota: 10, callsRemaining: 5, resetAt: new Date().toISOString(), payMethod: 'card', autoTopup: { enabled: true, threshold: 30 } } });
    assert.match(auto.text, /เติมอัตโนมัติ/);
    assert.match(auto.text, /เหลือ 1\/10 นาที/);

    const pp = freshMember('fixture-small');
    pp.payMethod = 'promptpay';
    const manual = buildQuotaLowMessage({ member: pp, quota: { remaining: 1, quota: 10, callsRemaining: 5, resetAt: new Date().toISOString(), payMethod: 'promptpay', autoTopup: { enabled: false } } });
    assert.match(manual.text, /เติมแพ็กเสริม/);
    assert.match(manual.text, /ไม่หมดอายุ/);
  });

  it('builds an amber flex bubble with a dashboard button when hosted', () => {
    config.publicBaseUrl = 'https://demo.test';
    const flex = buildQuotaLowFlex({ member: {}, quota: { remaining: 1, quota: 10, callsRemaining: 5, payMethod: '', autoTopup: { enabled: false } } });
    assert.equal(flex.type, 'bubble');
    assert.match(flex.header.contents[0].text, /โควต้าใกล้หมด/);
    assert.match(flex.header.contents[1].text, /ไม่ตัดการป้องกัน/);
    const btn = flex.footer.contents.find((c) => c.type === 'button');
    assert.equal(btn.action.uri, 'https://demo.test/dashboard.html');
  });
});
