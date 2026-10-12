// Pricing v2 (decided): Solo ฿99 / Family ฿199 with annual (−25%), extra
// seat ฿59, 1-year gifts ฿990 / ฿1,990, 7-day / 5-call trial on Family.
// Old plans are off sale and migrate on restore; /api/plans drives the
// pricing page.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { config } from '../src/config.js';
import {
  PLANS, GIFTS, TRIAL, ADDON_SEAT, MAX_HOUSEHOLD_SEATS, planOf, addMember, getMemberById,
  serializeStore, restoreStore, seatCap, quotaSummary, createCall,
} from '../src/store.js';
import {
  priceIdFor, paymentMethodsFor, fulfillCheckoutSession, createCheckoutSession, __resetFulfilled,
} from '../src/billing.js';
import { demoRouter } from '../src/routes.js';
import { createSession } from '../src/auth.js';

const DAY = 86400000;
const near = (iso, ms) => Math.abs(Date.parse(iso) - ms) < 60000;

describe('the plan table', () => {
  it('sells exactly Solo 99 and Family 199, with the decided limits', () => {
    assert.deepEqual(Object.keys(PLANS).sort(), ['family-199', 'solo-99']);
    const solo = PLANS['solo-99'];
    const fam = PLANS['family-199'];
    assert.deepEqual([solo.price, solo.usd, solo.annual, solo.quota, solo.calls, solo.numbers, solo.watchers], [99, 3, 890, 60, 30, 1, 3]);
    assert.deepEqual([fam.price, fam.usd, fam.annual, fam.quota, fam.calls, fam.numbers, fam.watchers], [199, 6, 1790, 180, 90, 3, null], 'null watchers = unlimited');
    assert.deepEqual([ADDON_SEAT.price, ADDON_SEAT.usd, ADDON_SEAT.quota, ADDON_SEAT.calls], [59, 2, 60, 30]);
    assert.equal(MAX_HOUSEHOLD_SEATS, 5);
    assert.deepEqual(GIFTS['gift-solo-990'], { plan: 'solo-99', price: 990, days: 365 });
    assert.deepEqual(GIFTS['gift-family-1990'], { plan: 'family-199', price: 1990, days: 365 });
    assert.deepEqual(TRIAL, { plan: 'family-199', days: 7, calls: 5 });
  });

  it('unknown or old plans fall back to Solo; old ids map to their successor', () => {
    assert.equal(planOf({ plan: 'nope' }), PLANS['solo-99']);
    assert.equal(planOf({ plan: 'starter-20' }), PLANS['solo-99']);
    assert.equal(planOf({ plan: 'plus-100' }), PLANS['solo-99']);
    assert.equal(planOf({ plan: 'family-149' }), PLANS['family-199']);
    assert.equal(addMember({ ownerPhone: '+66810003301', aiNumber: '+66210003301', plan: 'family-149' }).plan, 'family-199');
  });

  it('family seats: 3 included, up to 5 with paid seats', () => {
    const m = addMember({ ownerPhone: '+66810003302', aiNumber: '+66210003302', plan: 'family-199' });
    assert.equal(seatCap(m), 3);
    m.seats = [1, 2, 3].map(() => ({ paidAt: new Date().toISOString(), paidUntil: new Date(Date.now() + DAY).toISOString() }));
    assert.equal(seatCap(m), 5, 'capped at 5');
  });

  it('trial facts are exposed on the quota summary (7 days / 5 calls)', () => {
    const m = addMember({ ownerPhone: '+66810003303', aiNumber: '+66210003303', plan: 'family-199' });
    createCall({ memberId: m.id, callerPhone: '+66812223301', aiNumber: m.aiNumber, source: 'twilio' });
    const t = quotaSummary(m).trial;
    assert.equal(t.active, true);
    assert.equal(t.calls, 5);
    assert.equal(t.callsRemaining, 4);
    m.planPaidUntil = new Date(Date.now() + 30 * DAY).toISOString();
    assert.equal(quotaSummary(m).trial.active, false, 'a paid household is not on trial');
  });
});

describe('migration on restore', () => {
  it('starter/plus → solo-99, family-149 → family-199, paid-until kept', () => {
    const paid = new Date(Date.now() + 12 * DAY).toISOString();
    const a = addMember({ ownerPhone: '+66810003311', aiNumber: '+66210003311' });
    const b = addMember({ ownerPhone: '+66810003312', aiNumber: '+66210003312' });
    const c = addMember({ ownerPhone: '+66810003313', aiNumber: '+66210003313' });
    const snap = JSON.parse(JSON.stringify(serializeStore()));
    snap.members.find((x) => x.id === a.id).plan = 'starter-20';
    snap.members.find((x) => x.id === b.id).plan = 'plus-100';
    Object.assign(snap.members.find((x) => x.id === c.id), { plan: 'family-149', planPaidUntil: paid });
    restoreStore(snap);
    assert.equal(getMemberById(a.id).plan, 'solo-99');
    assert.equal(getMemberById(b.id).plan, 'solo-99');
    assert.equal(getMemberById(c.id).plan, 'family-199');
    assert.equal(getMemberById(c.id).planPaidUntil, paid);
  });
});

describe('billing', () => {
  const saved = JSON.parse(JSON.stringify(config.stripePrices));
  before(() => {
    Object.assign(config.stripePrices, {
      'solo-99': { th: 'price_solo_m', intl: '', th_year: 'price_solo_y', intl_year: '' },
      'family-199': { th: 'price_fam_m', intl: 'price_fam_m_usd', th_year: 'price_fam_y', intl_year: '' },
      'gift-solo-990': { th: 'price_gift_solo', intl: '' },
      'gift-family-1990': { th: 'price_gift_fam', intl: '' },
    });
  });
  after(() => { for (const k of Object.keys(config.stripePrices)) delete config.stripePrices[k]; Object.assign(config.stripePrices, saved); });

  it('price ids per plan × interval × region, gifts by id; unset = none', () => {
    assert.equal(priceIdFor('plan', 'solo-99', 'th'), 'price_solo_m');
    assert.equal(priceIdFor('plan', 'solo-99', 'th', 'year'), 'price_solo_y');
    assert.equal(priceIdFor('plan', 'family-199', 'intl'), 'price_fam_m_usd');
    assert.equal(priceIdFor('plan', 'family-199', 'intl', 'year'), '', 'optional intl annual unset');
    assert.equal(priceIdFor('gift', 'gift-family-1990', 'th'), 'price_gift_fam');
    assert.equal(priceIdFor('plan', 'starter-20', 'th'), '', 'off sale');
    assert.deepEqual(paymentMethodsFor('plan', 'solo-99', 'th'), ['card', 'promptpay']);
  });

  it('an annual plan pays 365 days; a monthly 30', () => {
    __resetFulfilled();
    const m = addMember({ ownerPhone: '+66810003321', aiNumber: '+66210003321' });
    fulfillCheckoutSession({ id: 'cs_v2_year', payment_status: 'paid', metadata: { memberId: m.id, kind: 'plan', plan: 'family-199', interval: 'year' } });
    assert.equal(m.plan, 'family-199');
    assert.ok(near(m.planPaidUntil, Date.now() + 365 * DAY));
    const s = addMember({ ownerPhone: '+66810003322', aiNumber: '+66210003322' });
    fulfillCheckoutSession({ id: 'cs_v2_month', payment_status: 'paid', metadata: { memberId: s.id, kind: 'plan', plan: 'solo-99' } });
    assert.ok(near(s.planPaidUntil, Date.now() + 30 * DAY));
  });

  it('a gift grants its plan for one year, stacking on paid time, never auto-renewing', () => {
    __resetFulfilled();
    const m = addMember({ ownerPhone: '+66810003323', aiNumber: '+66210003323' });
    m.planPaidUntil = new Date(Date.now() + 10 * DAY).toISOString();
    const r = fulfillCheckoutSession({ id: 'cs_v2_gift', payment_status: 'paid', metadata: { memberId: m.id, kind: 'gift', gift: 'gift-solo-990' } });
    assert.equal(r.granted, true);
    assert.equal(r.kind, 'gift');
    assert.equal(m.plan, 'solo-99');
    assert.ok(near(m.planPaidUntil, Date.now() + 375 * DAY));
    assert.equal(fulfillCheckoutSession({ id: 'cs_v2_gift_bad', payment_status: 'paid', metadata: { memberId: m.id, kind: 'gift', gift: 'gift-nope' } }).granted, false);
  });

  it('checkout sends interval and gift id as metadata', async () => {
    let form;
    const fetchImpl = async (url, opts) => { form = new URLSearchParams(opts.body); return { ok: true, json: async () => ({ id: 'cs_x', url: 'https://stripe.test' }) }; };
    await createCheckoutSession({ memberId: 'm_1', kind: 'plan', plan: 'solo-99', interval: 'year', region: 'th', successUrl: 's', cancelUrl: 'c' }, { fetchImpl, secretKey: 'sk_test_fake_key_123' });
    assert.equal(form.get('line_items[0][price]'), 'price_solo_y');
    assert.equal(form.get('metadata[interval]'), 'year');
    await createCheckoutSession({ memberId: 'm_1', kind: 'gift', plan: 'gift-family-1990', region: 'th', successUrl: 's', cancelUrl: 'c' }, { fetchImpl, secretKey: 'sk_test_fake_key_123' });
    assert.equal(form.get('line_items[0][price]'), 'price_gift_fam');
    assert.equal(form.get('metadata[gift]'), 'gift-family-1990');
    assert.equal(form.get('metadata[kind]'), 'gift');
  });
});

describe('/api/plans drives the pricing page', () => {
  let server; let base;
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', demoRouter(() => {}));
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { await new Promise((resolve) => server.close(resolve)); });

  it('exposes monthly + annual plans, the seat add-on, gifts, top-ups, trial and retention', async () => {
    const r = await fetch(`${base}/api/plans`, { signal: AbortSignal.timeout(5000) }).then((x) => x.json());
    assert.deepEqual(Object.keys(r.plans), ['solo-99', 'family-199']);
    assert.deepEqual(r.plans['solo-99'], {
      id: 'solo-99', name: 'Solo', price: 99, usd: 3, annual: 890, annualUsd: null,
      numbers: 1, calls: 30, minutes: 60, quota: 60, watchers: 3, recommended: false,
      purchasable: { month: false, year: false },
    });
    assert.equal(r.plans['family-199'].watchers, null, 'unlimited');
    assert.equal(r.plans['family-199'].recommended, true);
    assert.deepEqual(r.extraSeat, {
      price: 59, usd: 2, calls: 30, minutes: 60, allowedOn: ['family-199'], maxNumbers: 5, purchasable: false,
    });
    assert.deepEqual(r.gifts['gift-family-1990'], {
      id: 'gift-family-1990', plan: 'family-199', price: 1990, usd: null, days: 365, months: 12, numbers: 3, autoRenew: false, purchasable: false,
    });
    assert.deepEqual(r.topups['topup-small'], { id: 'topup-small', price: 29, usd: 2, calls: 5, minutes: 10, purchasable: false });
    assert.deepEqual(r.trial, { plan: 'family-199', days: 7, calls: 5 });
    assert.deepEqual(r.retention, { legitDays: config.retentionLegitDays, unsureDays: config.retentionUnsureDays, scamDays: config.retentionScamDays });
    assert.equal(r.checkout.path, '/api/billing/checkout');
    assert.equal(r.trialDays, 7);
    assert.equal(r.maxNumbers, 5);
    assert.equal(r.addon.price, 59, 'legacy field kept for old clients');
  });

  it('purchasable turns on per item once billing + the Stripe price are configured', async () => {
    const saved = { key: config.stripeSecretKey, p: JSON.parse(JSON.stringify(config.stripePrices)) };
    config.stripeSecretKey = 'sk_test_fake_key_123';
    config.stripePrices['family-199'] = { th: 'price_f_m', intl: '', th_year: 'price_f_y', intl_year: '' };
    config.stripePrices['gift-family-1990'] = { th: 'price_g_f', intl: '' };
    try {
      const r = await fetch(`${base}/api/plans`, { signal: AbortSignal.timeout(5000) }).then((x) => x.json());
      assert.deepEqual(r.plans['family-199'].purchasable, { month: true, year: true });
      assert.deepEqual(r.plans['solo-99'].purchasable, { month: false, year: false });
      assert.equal(r.gifts['gift-family-1990'].purchasable, true);
      assert.equal(r.gifts['gift-solo-990'].purchasable, false);
    } finally {
      config.stripeSecretKey = saved.key;
      for (const k of Object.keys(config.stripePrices)) delete config.stripePrices[k];
      Object.assign(config.stripePrices, saved.p);
    }
  });
});

describe('unlimited watchers (null) are enforced as unlimited', () => {
  let server; let base;
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', demoRouter(() => {}));
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { await new Promise((resolve) => server.close(resolve)); });
  const post = async (p, body, token) => {
    const r = await fetch(`${base}${p}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  it('family adds many watchers; solo stops at 3 with max reported', async () => {
    const fam = addMember({ ownerPhone: '+66810003331', aiNumber: '+66210003331', plan: 'family-199' });
    const ft = createSession(fam.id);
    for (let i = 0; i < 6; i += 1) assert.equal((await post('/api/me/watchers', { phone: `08100033${40 + i}` }, ft)).status, 200);
    const solo = addMember({ ownerPhone: '+66810003332', aiNumber: '+66210003332', plan: 'solo-99' });
    const st = createSession(solo.id);
    for (let i = 0; i < 3; i += 1) assert.equal((await post('/api/me/watchers', { phone: `08100033${50 + i}` }, st)).status, 200);
    const over = await post('/api/me/watchers', { phone: '0810003359' }, st);
    assert.equal(over.status, 403);
    assert.equal(over.body.max, 3);
  });

  it('switching family → solo is a downgrade (no payment), solo → family is not', async () => {
    const fam = addMember({ ownerPhone: '+66810003333', aiNumber: '+66210003333', plan: 'family-199' });
    assert.equal((await post('/api/me/plan', { plan: 'solo-99' }, createSession(fam.id))).status, 200);
    const solo = addMember({ ownerPhone: '+66810003334', aiNumber: '+66210003334', plan: 'solo-99' });
    assert.equal((await post('/api/me/plan', { plan: 'family-199' }, createSession(solo.id))).status, 402);
  });
});
