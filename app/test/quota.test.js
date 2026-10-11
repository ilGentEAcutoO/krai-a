// Quota model + topup packs + auto-billing tests: pooled quota math, monthly
// reset, Checkout topup grants (idempotent), auto-topup toggle, off-session
// card charge (mocked Stripe) vs PromptPay manual prompt, and HTTP routes.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import express from 'express';
import { config } from '../src/config.js';
import {
  addMember, getMemberById, createCall, getCall, TOPUP_PACKS,
  quotaSummary, consumeMinutes, grantTopup, setAutoTopup, quotaTotal,
  callsQuotaTotal, quotaPeriodKey, quotaResetAt,
  AUTO_TOPUP_MIN_THRESHOLD, AUTO_TOPUP_MAX_THRESHOLD, AUTO_TOPUP_DEFAULT_THRESHOLD,
} from '../src/store.js';
import { talkBudgetMinutes } from '../src/verdict.js';
import { createSession } from '../src/auth.js';
import {
  priceIdFor, paymentMethodsFor, createCheckoutSession,
  fulfillCheckoutSession, fulfillAutoTopup, createAutoTopupPayment,
  maybeAutoTopup, topupAmountFor, latestSavedCard, __resetFulfilled,
} from '../src/billing.js';
import { billingRouter } from '../src/billingRoutes.js';
import { demoRouter } from '../src/routes.js';

// Fake price IDs (never real Stripe IDs).
config.stripePrices['starter-20'] = { th: 'price_starter_th', intl: 'price_starter_intl' };
config.stripePrices['plus-100'] = { th: 'price_plus_th', intl: 'price_plus_intl' };
config.stripePrices['family-149'] = { th: 'price_family_th', intl: 'price_family_intl' };
config.stripePrices.seat = { th: 'price_seat_th', intl: 'price_seat_intl' };
config.stripePrices['topup-small'] = { th: 'price_topup_small_th', intl: 'price_topup_small_intl' };
config.stripePrices['topup-medium'] = { th: 'price_topup_medium_th', intl: 'price_topup_medium_intl' };

let seq = 0;
const freshMember = (plan = 'starter-20') => {
  seq += 1;
  return addMember({ ownerPhone: `+668100008${String(seq).padStart(2, '0')}`, aiNumber: `+662100018${String(seq).padStart(2, '0')}`, plan });
};

describe('quota model', () => {
  it('summarizes a fresh member from its plan (used 0, full remaining)', () => {
    const q = quotaSummary(freshMember('starter-20'));
    assert.equal(q.plan, 'starter-20');
    assert.equal(q.quota, 10);
    assert.equal(q.used, 0);
    assert.equal(q.remaining, 10);
    assert.equal(q.callsQuota, 5);
    assert.equal(q.callsUsed, 0);
    assert.equal(q.callsRemaining, 5);
    assert.equal(q.period, quotaPeriodKey());
    assert.equal(q.topupMinutes, 0);
    assert.equal(q.payMethod, '');
    assert.deepEqual(q.autoTopup, { enabled: false, threshold: 5, pack: 'topup-small', due: false, manualPrompt: false });
  });

  it('resets on the 1st of next month (UTC)', () => {
    const d = new Date();
    const expected = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
    assert.equal(quotaResetAt(), expected);
    assert.equal(quotaSummary(freshMember()).resetAt, expected);
  });

  it('pools plan + paid seats + topups, and burns via consumeMinutes', () => {
    const m = freshMember('plus-100');
    m.seatsPaid = 1;
    grantTopup(m, 'topup-small');
    assert.equal(quotaTotal(m), 50 + 50 + 10);
    assert.equal(callsQuotaTotal(m), 25 + 25 + 5); // topup-small also adds 5 calls
    const q = consumeMinutes(m, 7);
    assert.equal(q.used, 7);
    assert.equal(q.remaining, 103);
    assert.equal(getMemberById(m.id).minutesUsed, 7);
  });

  it('clamps remaining at 0 and ignores negative burns', () => {
    const m = freshMember('starter-20');
    consumeMinutes(m, -5);
    assert.equal(quotaSummary(m).used, 0);
    const q = consumeMinutes(m, 999);
    assert.equal(q.used, 999);
    assert.equal(q.remaining, 0);
  });

  it('rolls used minutes into a new period but keeps topupMinutes', () => {
    const m = freshMember('starter-20');
    m.quotaPeriod = '2000-01';
    m.minutesUsed = 7;
    m.topupMinutes = 10;
    const q = quotaSummary(m);
    assert.equal(q.period, quotaPeriodKey());
    assert.equal(q.used, 0);
    assert.equal(q.topupMinutes, 10);
    assert.equal(q.quota, 20);
    assert.equal(q.remaining, 20);
  });

  it('counts only this-period calls toward callsUsed', () => {
    const m = freshMember('starter-20');
    const c1 = createCall({ memberId: m.id, callerPhone: '+6681300001', aiNumber: m.aiNumber, source: 'demo' });
    const c2 = createCall({ memberId: m.id, callerPhone: '+6681300002', aiNumber: m.aiNumber, source: 'demo' });
    getCall(c2.id).startedAt = '2000-01-15T00:00:00.000Z';
    assert.ok(c1.id);
    assert.equal(quotaSummary(m).callsUsed, 1);
  });

  it('grants topup minutes AND calls together (coupled packs)', () => {
    const m = freshMember('starter-20');
    const g = grantTopup(m, 'topup-small');
    assert.deepEqual(g, { granted: true, pack: 'topup-small', minutes: 10, calls: 5, topupMinutes: 10, topupCalls: 5 });
    assert.equal(quotaTotal(m), 20); // 10 plan + 10 topup
    assert.equal(callsQuotaTotal(m), 10); // 5 plan + 5 topup
    const q = quotaSummary(m);
    assert.equal(q.topupMinutes, 10);
    assert.equal(q.topupCalls, 5);
    assert.equal(q.callsRemaining, 10);
  });

  it('grows the per-call talk budget with pooled quota', () => {
    const m = freshMember('starter-20');
    assert.equal(talkBudgetMinutes(m), 2); // 20% of 10
    grantTopup(m, 'topup-medium');
    assert.equal(talkBudgetMinutes(m), 8); // 20% of 40
  });
});

describe('topup packs', () => {
  it('catalogs small (+10) and medium (+30) packs with TH/USD prices', () => {
    assert.deepEqual(TOPUP_PACKS['topup-small'], { minutes: 10, calls: 5, price: 29, usd: 2 });
    assert.deepEqual(TOPUP_PACKS['topup-medium'], { minutes: 30, calls: 15, price: 69, usd: 5 });
    assert.deepEqual(Object.keys(TOPUP_PACKS), ['topup-small', 'topup-medium']);
  });

  it('resolves topup price IDs per region, card+PromptPay in TH', () => {
    assert.equal(priceIdFor('topup', 'topup-small', 'th'), 'price_topup_small_th');
    assert.equal(priceIdFor('topup', 'topup-medium', 'intl'), 'price_topup_medium_intl');
    assert.equal(priceIdFor('topup', 'topup-huge', 'th'), '');
    assert.deepEqual(paymentMethodsFor('topup', 'topup-small', 'th'), ['card', 'promptpay']);
    assert.deepEqual(paymentMethodsFor('topup', 'topup-small', 'intl'), ['card']);
  });

  it('posts a one-time topup session with pack + region metadata', async () => {
    let form = null;
    const fetchImpl = async (url, opts) => {
      form = new URLSearchParams(opts.body);
      return { ok: true, json: async () => ({ id: 'cs_topup_1', url: 'https://checkout.stripe.com/c/pay/cs_topup_1' }) };
    };
    await createCheckoutSession(
      { memberId: 'm_1', kind: 'topup', plan: 'topup-medium', region: 'th', successUrl: 's', cancelUrl: 'c' },
      { fetchImpl, secretKey: 'sk_test_fake_key_123' },
    );
    assert.equal(form.get('line_items[0][price]'), 'price_topup_medium_th');
    assert.equal(form.get('metadata[kind]'), 'topup');
    assert.equal(form.get('metadata[pack]'), 'topup-medium');
    assert.equal(form.get('metadata[region]'), 'th');
    assert.deepEqual(form.getAll('payment_method_types[]'), ['card', 'promptpay']);
  });

  it('grants topup minutes once (webhook retries dedupe)', () => {
    __resetFulfilled();
    const m = freshMember('starter-20');
    const first = fulfillCheckoutSession({
      id: 'cs_topup_grant_1',
      payment_method_types: ['promptpay'],
      metadata: { memberId: m.id, kind: 'topup', pack: 'topup-small', region: 'th' },
    });
    assert.deepEqual(first, { granted: true, kind: 'topup', pack: 'topup-small', topupMinutes: 10, topupCalls: 5 });
    assert.equal(getMemberById(m.id).payMethod, 'promptpay');
    assert.equal(quotaSummary(m).quota, 20);
    const replay = fulfillCheckoutSession({
      id: 'cs_topup_grant_1',
      metadata: { memberId: m.id, kind: 'topup', pack: 'topup-medium' },
    });
    assert.equal(replay.reason, 'duplicate');
    assert.equal(getMemberById(m.id).topupMinutes, 10); // replay grants nothing
  });

  it('rejects unknown packs and stamps card customer IDs', () => {
    __resetFulfilled();
    const m = freshMember('plus-100');
    assert.equal(
      fulfillCheckoutSession({ id: 'cs_bad_pack', metadata: { memberId: m.id, kind: 'topup', pack: 'topup-huge' } }).reason,
      'unknown-kind',
    );
    const ok = fulfillCheckoutSession({
      id: 'cs_card_stamp', customer: 'cus_test_1', payment_method_types: ['card'],
      metadata: { memberId: m.id, kind: 'plan', plan: 'plus-100', region: 'intl' },
    });
    assert.equal(ok.granted, true);
    assert.equal(getMemberById(m.id).payMethod, 'card');
    assert.equal(getMemberById(m.id).stripeCustomerId, 'cus_test_1');
    assert.equal(getMemberById(m.id).billingRegion, 'intl');
  });

  it('maps packs to off-session charge amounts (satang/cents)', () => {
    assert.deepEqual(topupAmountFor('topup-small', 'th'), { amount: 2900, currency: 'thb' });
    assert.deepEqual(topupAmountFor('topup-medium', 'intl'), { amount: 500, currency: 'usd' });
    assert.equal(topupAmountFor('topup-huge', 'th'), null);
  });
});

describe('auto-topup toggle + charge decision', () => {
  it('toggles with threshold clamp and pack validation', () => {
    const m = freshMember('starter-20');
    assert.deepEqual(setAutoTopup(m, { enabled: true }), { enabled: true, threshold: 5, pack: 'topup-small' });
    assert.equal(setAutoTopup(m, { threshold: 99 }).threshold, AUTO_TOPUP_MAX_THRESHOLD);
    assert.equal(setAutoTopup(m, { threshold: -3 }).threshold, AUTO_TOPUP_MIN_THRESHOLD);
    assert.equal(setAutoTopup(m, { pack: 'topup-huge' }).pack, 'topup-small'); // invalid keeps current
    assert.equal(setAutoTopup(m, { pack: 'topup-medium' }).pack, 'topup-medium');
    assert.equal(setAutoTopup(m, { enabled: false }).enabled, false);
    assert.equal(AUTO_TOPUP_DEFAULT_THRESHOLD, 5);
  });

  it('flags due for saved cards, manualPrompt for PromptPay when low', () => {
    const card = freshMember('starter-20');
    card.payMethod = 'card';
    card.stripeCustomerId = 'cus_test_2';
    setAutoTopup(card, { enabled: true, threshold: 30 });
    consumeMinutes(card, 5); // remaining 5 <= 30
    assert.deepEqual(quotaSummary(card).autoTopup, { enabled: true, threshold: 30, pack: 'topup-small', due: true, manualPrompt: false });

    const pp = freshMember('starter-20');
    pp.payMethod = 'promptpay';
    setAutoTopup(pp, { enabled: true, threshold: 30 });
    consumeMinutes(pp, 5);
    assert.deepEqual(quotaSummary(pp).autoTopup, { enabled: true, threshold: 30, pack: 'topup-small', due: false, manualPrompt: true });

    const healthy = freshMember('plus-100');
    healthy.payMethod = 'card';
    healthy.stripeCustomerId = 'cus_test_3';
    setAutoTopup(healthy, { enabled: true, threshold: 5 });
    assert.equal(quotaSummary(healthy).autoTopup.due, false);
    assert.equal(quotaSummary(healthy).autoTopup.manualPrompt, false);
  });

  it('flags auto-topup when calls run low even with minutes left', () => {
    const m = freshMember('starter-20'); // 10 min / 5 calls
    m.payMethod = 'card';
    m.stripeCustomerId = 'cus_test_calls';
    setAutoTopup(m, { enabled: true, threshold: 5 });
    for (let i = 0; i < 5; i += 1) {
      createCall({ memberId: m.id, callerPhone: `+668139900${i}`, aiNumber: m.aiNumber, source: 'demo' });
    }
    const q = quotaSummary(m);
    assert.equal(q.remaining, 10); // minutes untouched
    assert.equal(q.callsRemaining, 0); // calls exhausted
    assert.equal(q.autoTopup.due, true); // calls-low triggers despite healthy minutes
  });

  it('maybeAutoTopup short-circuits disabled / healthy / manual states', async () => {
    const off = freshMember('starter-20');
    assert.equal((await maybeAutoTopup(off)).reason, 'auto-topup-disabled');

    const healthy = freshMember('plus-100');
    setAutoTopup(healthy, { enabled: true, threshold: 5 });
    assert.equal((await maybeAutoTopup(healthy)).reason, 'quota-healthy');

    const manual = freshMember('starter-20');
    manual.payMethod = 'promptpay';
    setAutoTopup(manual, { enabled: true, threshold: 30 });
    consumeMinutes(manual, 9);
    const r = await maybeAutoTopup(manual);
    assert.equal(r.reason, 'manual-topup-required');
    assert.equal(r.manual, true);
    assert.equal(r.charged, false);
  });

  it('charges the saved card off-session (mocked) and grants minutes', async () => {
    __resetFulfilled();
    const m = freshMember('starter-20');
    m.payMethod = 'card';
    m.stripeCustomerId = 'cus_test_4';
    setAutoTopup(m, { enabled: true, threshold: 30, pack: 'topup-small' });
    consumeMinutes(m, 9); // remaining 1
    let form = null;
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push(url);
      if (url.startsWith('https://api.stripe.com/v1/payment_methods?')) {
        const u = new URL(url);
        assert.equal(u.searchParams.get('customer'), 'cus_test_4');
        assert.equal(u.searchParams.get('type'), 'card');
        return { ok: true, json: async () => ({ data: [{ id: 'pm_test_1' }] }) };
      }
      assert.equal(url, 'https://api.stripe.com/v1/payment_intents');
      form = new URLSearchParams(opts.body);
      return { ok: true, json: async () => ({ id: 'pi_auto_1', status: 'succeeded', customer: 'cus_test_4' }) };
    };
    const r = await maybeAutoTopup(m, { fetchImpl, secretKey: 'sk_test_fake_key_123' });
    assert.equal(r.charged, true);
    assert.equal(r.paymentIntentId, 'pi_auto_1');
    assert.deepEqual(calls.map((u) => u.split('?')[0]), [
      'https://api.stripe.com/v1/payment_methods',
      'https://api.stripe.com/v1/payment_intents',
    ]);
    assert.equal(form.get('customer'), 'cus_test_4');
    assert.equal(form.get('payment_method'), 'pm_test_1');
    assert.equal(form.get('amount'), '2900');
    assert.equal(form.get('currency'), 'thb');
    assert.equal(form.get('off_session'), 'true');
    assert.equal(form.get('confirm'), 'true');
    assert.equal(form.get('metadata[pack]'), 'topup-small');
    assert.equal(getMemberById(m.id).topupMinutes, 10);
    assert.equal(r.quota.remaining, 11);
  });

  it('looks up the newest saved card, empty list means manual top-up', async () => {
    assert.deepEqual(
      await latestSavedCard('cus_x', { fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: 'pm_a' }, { id: 'pm_b' }] }) }), secretKey: 'sk_test_fake_key_123' }),
      { ok: true, paymentMethodId: 'pm_a' }, // lists are newest-first
    );
    assert.deepEqual(
      await latestSavedCard('cus_x', { fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }), secretKey: 'sk_test_fake_key_123' }),
      { ok: true, paymentMethodId: '' },
    );
    const bad = await latestSavedCard('cus_x', { fetchImpl: async () => ({ ok: false, json: async () => ({ error: { message: 'boom' } }) }), secretKey: 'sk_test_fake_key_123' });
    assert.equal(bad.ok, false);
    assert.equal(bad.detail, 'boom');
  });

  it('prompts manual top-up when the customer has no saved card on file', async () => {
    const m = freshMember('starter-20');
    m.payMethod = 'card';
    m.stripeCustomerId = 'cus_test_nocard';
    setAutoTopup(m, { enabled: true, threshold: 30 });
    consumeMinutes(m, 9);
    let piCalls = 0;
    const fetchImpl = async (url) => {
      if (url.startsWith('https://api.stripe.com/v1/payment_methods?')) {
        return { ok: true, json: async () => ({ data: [] }) };
      }
      piCalls += 1;
      return { ok: true, json: async () => ({}) };
    };
    const r = await createAutoTopupPayment(m, { fetchImpl, secretKey: 'sk_test_fake_key_123' });
    assert.equal(r.charged, false);
    assert.equal(r.reason, 'no-saved-card');
    assert.equal(r.manual, true);
    assert.equal(piCalls, 0); // never attempts a chargeless PaymentIntent
  });

  it('falls back to manual on Stripe errors and missing cards', async () => {
    const declined = freshMember('starter-20');
    declined.payMethod = 'card';
    declined.stripeCustomerId = 'cus_test_5';
    setAutoTopup(declined, { enabled: true, threshold: 30 });
    consumeMinutes(declined, 9);
    const errFetch = async () => ({ ok: false, json: async () => ({ error: { message: 'card-declined' } }) });
    const r = await createAutoTopupPayment(declined, { fetchImpl: errFetch, secretKey: 'sk_test_fake_key_123' });
    assert.equal(r.charged, false);
    assert.equal(r.manual, true);

    const noCard = freshMember('starter-20');
    setAutoTopup(noCard, { enabled: true, threshold: 30 });
    const r2 = await createAutoTopupPayment(noCard, { secretKey: 'sk_test_fake_key_123' });
    assert.equal(r2.reason, 'no-saved-card');
    assert.equal(r2.manual, true);
  });

  it('fulfills payment_intent.succeeded once, rejects the rest', () => {
    __resetFulfilled();
    const m = freshMember('starter-20');
    const md = { memberId: m.id, kind: 'topup', pack: 'topup-medium' };
    assert.equal(fulfillAutoTopup({ id: 'pi_x', status: 'requires_payment_method', metadata: md }).reason, 'not-succeeded');
    const ok = fulfillAutoTopup({ id: 'pi_ok_1', status: 'succeeded', customer: 'cus_test_6', metadata: md });
    assert.deepEqual(ok, { granted: true, kind: 'topup', pack: 'topup-medium', topupMinutes: 30, topupCalls: 15 });
    assert.equal(getMemberById(m.id).payMethod, 'card');
    assert.equal(fulfillAutoTopup({ id: 'pi_ok_1', status: 'succeeded', metadata: md }).reason, 'duplicate');
    assert.equal(fulfillAutoTopup({ id: 'pi_bad', status: 'succeeded', metadata: { memberId: m.id, kind: 'topup', pack: 'nope' } }).reason, 'unknown-kind');
    assert.equal(fulfillAutoTopup({ status: 'succeeded', metadata: md }).reason, 'no-payment-intent-id');
  });
});

describe('quota + auto-topup routes (HTTP)', () => {
  const app = express();
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.use('/api', demoRouter(() => {}));
  app.use('/api/billing', billingRouter());
  let server, base;
  const member = addMember({ ownerPhone: '+66810000891', aiNumber: '+66210001891', plan: 'plus-100' });
  const token = createSession(member.id);
  const prevSecret = config.stripeSecretKey;
  const prevWh = config.stripeWebhookSecret;

  before(async () => {
    config.stripeSecretKey = 'sk_test_fake_key_123';
    config.stripeWebhookSecret = 'whsec_quota_test';
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    config.stripeSecretKey = prevSecret;
    config.stripeWebhookSecret = prevWh;
    await new Promise((resolve) => server.close(resolve));
  });

  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  it('requires auth on /me/quota and returns the full meter', async () => {
    let r = await fetch(`${base}/api/me/quota`);
    assert.equal(r.status, 401);
    r = await fetch(`${base}/api/me/quota`, { headers: auth });
    assert.equal(r.status, 200);
    const q = await r.json();
    assert.equal(q.plan, 'plus-100');
    assert.equal(q.quota, 50);
    assert.equal(q.remaining, 50);
    assert.deepEqual(Object.keys(q.packs), ['topup-small', 'topup-medium']);
    assert.equal(q.canTopup, true);
    assert.deepEqual(q.autoTopupBounds, { min: 1, max: 30 });
    assert.ok(q.resetAt);
  });

  it('toggles auto-topup and validates pack + threshold', async () => {
    let r = await fetch(`${base}/api/me/auto-topup`, {
      method: 'POST', headers: auth, body: JSON.stringify({ enabled: true, pack: 'topup-huge' }),
    });
    assert.equal(r.status, 400);
    r = await fetch(`${base}/api/me/auto-topup`, {
      method: 'POST', headers: auth, body: JSON.stringify({ enabled: true, threshold: 'lots' }),
    });
    assert.equal(r.status, 400);
    r = await fetch(`${base}/api/me/auto-topup`, {
      method: 'POST', headers: auth, body: JSON.stringify({ enabled: true, threshold: 8, pack: 'topup-medium' }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(j.autoTopup, { enabled: true, threshold: 8, pack: 'topup-medium' });
    assert.equal(j.quota.autoTopup.due, false);
  });

  it('rejects invalid topup packs on /checkout', async () => {
    const r = await fetch(`${base}/api/billing/checkout`, {
      method: 'POST', headers: auth, body: JSON.stringify({ kind: 'topup', pack: 'topup-huge' }),
    });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid-pack');
  });

  it('grants topup on signed payment_intent.succeeded, dedupes replays', async () => {
    const event = {
      id: 'evt_pi_1', type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_route_1', status: 'succeeded', metadata: { memberId: member.id, kind: 'topup', pack: 'topup-small' } } },
    };
    const body = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},v1=${createHmac('sha256', 'whsec_quota_test').update(Buffer.concat([Buffer.from(`${t}.`), Buffer.from(body)])).digest('hex')}`;
    let r = await fetch(`${base}/api/billing/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': sig }, body,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { received: true, granted: true, kind: 'topup', pack: 'topup-small', topupMinutes: 10, topupCalls: 5 });
    r = await fetch(`${base}/api/billing/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': sig }, body,
    });
    assert.equal((await r.json()).reason, 'duplicate');
  });

  it('charge-now reports manual for PromptPay members without charging', async () => {
    const m = getMemberById(member.id);
    m.payMethod = 'promptpay';
    m.stripeCustomerId = '';
    setAutoTopup(m, { enabled: true, threshold: 30 });
    consumeMinutes(m, 49); // plus-100 + 10 topup = 60 total, remaining 11 <= 30
    const r = await fetch(`${base}/api/billing/auto-topup/charge`, { method: 'POST', headers: auth });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.charged, false);
    assert.equal(j.manual, true);
    assert.equal(j.reason, 'manual-topup-required');
  });
});
