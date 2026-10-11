// Stripe billing tests: price/method mapping, Checkout Session creation
// (mocked Stripe API), webhook signature verification, fulfillment grants,
// and HTTP route behavior (auth, validation, signed webhook round-trip).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import express from 'express';
import { config } from '../src/config.js';
import { addMember, getMemberById, cancelMember } from '../src/store.js';
import { createSession } from '../src/auth.js';
import {
  priceIdFor, paymentMethodsFor, createCheckoutSession,
  verifyWebhookSignature, fulfillCheckoutSession, __resetFulfilled,
} from '../src/billing.js';
import { billingRouter } from '../src/billingRoutes.js';

// Fake price IDs for mapping tests (never real Stripe IDs).
config.stripePrices['starter-20'] = { th: 'price_starter_th', intl: 'price_starter_intl' };
config.stripePrices['plus-100'] = { th: 'price_plus_th', intl: 'price_plus_intl' };
config.stripePrices['family-149'] = { th: 'price_family_th', intl: 'price_family_intl' };
config.stripePrices.seat = { th: 'price_seat_th', intl: 'price_seat_intl' };

describe('price + payment-method mapping', () => {
  it('resolves TH (THB) and INTL (USD) price IDs per plan and seat', () => {
    assert.equal(priceIdFor('plan', 'plus-100', 'th'), 'price_plus_th');
    assert.equal(priceIdFor('plan', 'family-149', 'intl'), 'price_family_intl');
    assert.equal(priceIdFor('seat', undefined, 'th'), 'price_seat_th');
    assert.equal(priceIdFor('seat', undefined, 'intl'), 'price_seat_intl');
    assert.equal(priceIdFor('plan', 'nope', 'th'), '');
  });

  it('makes starter-20 PromptPay-only in TH, card+PromptPay otherwise', () => {
    assert.deepEqual(paymentMethodsFor('plan', 'starter-20', 'th'), ['promptpay']);
    assert.deepEqual(paymentMethodsFor('plan', 'plus-100', 'th'), ['card', 'promptpay']);
    assert.deepEqual(paymentMethodsFor('seat', undefined, 'th'), ['card', 'promptpay']);
  });

  it('uses card-only for INTL (PromptPay is THB-only)', () => {
    assert.deepEqual(paymentMethodsFor('plan', 'starter-20', 'intl'), ['card']);
    assert.deepEqual(paymentMethodsFor('seat', undefined, 'intl'), ['card']);
  });
});

describe('createCheckoutSession (mocked Stripe)', () => {
  it('posts a one-time session with metadata + methods + locale', async () => {
    let got = null;
    const fetchImpl = async (url, opts) => {
      got = { url, opts, form: new URLSearchParams(opts.body) };
      return { ok: true, json: async () => ({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }) };
    };
    const s = await createCheckoutSession(
      { memberId: 'm_1', kind: 'plan', plan: 'starter-20', region: 'th', successUrl: 'https://x/s', cancelUrl: 'https://x/c' },
      { fetchImpl, secretKey: 'sk_test_fake_key_123' },
    );
    assert.equal(s.url, 'https://checkout.stripe.com/c/pay/cs_test_1');
    assert.equal(got.url, 'https://api.stripe.com/v1/checkout/sessions');
    assert.match(got.opts.headers.Authorization, /^Basic /);
    assert.equal(got.form.get('mode'), 'payment');
    assert.equal(got.form.get('line_items[0][price]'), 'price_starter_th');
    assert.deepEqual(got.form.getAll('payment_method_types[]'), ['promptpay']);
    assert.equal(got.form.get('metadata[memberId]'), 'm_1');
    assert.equal(got.form.get('metadata[plan]'), 'starter-20');
    assert.equal(got.form.get('locale'), 'th');
  });

  it('sends card+promptpay for plus TH and card-only, no locale, for INTL seat', async () => {
    const forms = [];
    const fetchImpl = async (url, opts) => {
      forms.push(new URLSearchParams(opts.body));
      return { ok: true, json: async () => ({ id: 'cs_x', url: 'https://checkout.stripe.com/u' }) };
    };
    await createCheckoutSession(
      { memberId: 'm_1', kind: 'plan', plan: 'plus-100', region: 'th', successUrl: 's', cancelUrl: 'c' },
      { fetchImpl, secretKey: 'sk_test_fake_key_123' },
    );
    await createCheckoutSession(
      { memberId: 'm_1', kind: 'seat', region: 'intl', successUrl: 's', cancelUrl: 'c' },
      { fetchImpl, secretKey: 'sk_test_fake_key_123' },
    );
    assert.deepEqual(forms[0].getAll('payment_method_types[]'), ['card', 'promptpay']);
    assert.deepEqual(forms[1].getAll('payment_method_types[]'), ['card']);
    assert.equal(forms[1].get('line_items[0][price]'), 'price_seat_intl');
    assert.equal(forms[1].get('locale'), null);
  });

  it('saves the card on card checkouts: reuses the known customer', async () => {
    const m = addMember({ ownerPhone: '+66810000711', aiNumber: '+66210001711', plan: 'plus-100' });
    m.stripeCustomerId = 'cus_known_1';
    let form = null;
    const fetchImpl = async (url, opts) => {
      form = new URLSearchParams(opts.body);
      return { ok: true, json: async () => ({ id: 'cs_save_1', url: 'https://checkout.stripe.com/u' }) };
    };
    await createCheckoutSession(
      { memberId: m.id, kind: 'plan', plan: 'plus-100', region: 'th', successUrl: 's', cancelUrl: 'c' },
      { fetchImpl, secretKey: 'sk_test_fake_key_123' },
    );
    assert.equal(form.get('customer'), 'cus_known_1');
    assert.equal(form.get('customer_creation'), null);
    assert.equal(form.get('payment_intent_data[setup_future_usage]'), 'off_session');
  });

  it('lets Checkout create the customer for first-time card payers', async () => {
    const m = addMember({ ownerPhone: '+66810000712', aiNumber: '+66210001712', plan: 'starter-20' });
    let form = null;
    const fetchImpl = async (url, opts) => {
      form = new URLSearchParams(opts.body);
      return { ok: true, json: async () => ({ id: 'cs_save_2', url: 'https://checkout.stripe.com/u' }) };
    };
    await createCheckoutSession(
      { memberId: m.id, kind: 'seat', region: 'intl', successUrl: 's', cancelUrl: 'c' },
      { fetchImpl, secretKey: 'sk_test_fake_key_123' },
    );
    assert.equal(form.get('customer'), null);
    assert.equal(form.get('customer_creation'), 'always');
    assert.equal(form.get('payment_intent_data[setup_future_usage]'), 'off_session');
  });

  it('never sets customer/save flags on the PromptPay-only checkout', async () => {
    let form = null;
    const fetchImpl = async (url, opts) => {
      form = new URLSearchParams(opts.body);
      return { ok: true, json: async () => ({ id: 'cs_save_3', url: 'https://checkout.stripe.com/u' }) };
    };
    await createCheckoutSession(
      { memberId: 'm_1', kind: 'plan', plan: 'starter-20', region: 'th', successUrl: 's', cancelUrl: 'c' },
      { fetchImpl, secretKey: 'sk_test_fake_key_123' },
    );
    assert.equal(form.get('customer'), null);
    assert.equal(form.get('customer_creation'), null);
    assert.equal(form.get('payment_intent_data[setup_future_usage]'), null);
  });

  it('throws 503 without a secret key and 502 on Stripe errors', async () => {
    await assert.rejects(
      createCheckoutSession({ memberId: 'm', kind: 'seat', region: 'th', successUrl: 's', cancelUrl: 'c' }, { secretKey: '' }),
      /billing-unconfigured/,
    );
    const errFetch = async () => ({ ok: false, json: async () => ({ error: { message: 'No such price', code: 'resource_missing' } }) });
    await assert.rejects(
      createCheckoutSession({ memberId: 'm', kind: 'seat', region: 'th', successUrl: 's', cancelUrl: 'c' }, { fetchImpl: errFetch, secretKey: 'sk_test_fake_key_123' }),
      /No such price/,
    );
  });
});

describe('webhook signature verification', () => {
  const secret = 'whsec_test_secret';
  const raw = Buffer.from(JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' }));
  const sign = (body, t) => `t=${t},v1=${createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`${t}.`), body])).digest('hex')}`;

  it('accepts a fresh valid signature, rejects tampering and staleness', () => {
    const t = Math.floor(Date.now() / 1000);
    assert.equal(verifyWebhookSignature(raw, sign(raw, t), secret), true);
    assert.equal(verifyWebhookSignature(Buffer.from('{"tampered":true}'), sign(raw, t), secret), false);
    assert.equal(verifyWebhookSignature(raw, sign(raw, t), 'whsec_wrong'), false);
    assert.equal(verifyWebhookSignature(raw, sign(raw, t - 600), secret), false);
    assert.equal(verifyWebhookSignature(raw, '', secret), false);
    assert.equal(verifyWebhookSignature(raw, sign(raw, t), ''), false);
  });
});

describe('fulfillment grants', () => {
  it('grants plan (and reactivates), seat, rejects dupes and unknowns', () => {
    __resetFulfilled();
    const m = addMember({ ownerPhone: '+66810000701', aiNumber: '+6621000171', plan: 'starter-20' });
    cancelMember(m.id);
    const plan = fulfillCheckoutSession({ id: 'cs_plan_1', metadata: { memberId: m.id, kind: 'plan', plan: 'family-149' } });
    assert.deepEqual(plan, { granted: true, kind: 'plan', plan: 'family-149' });
    assert.equal(getMemberById(m.id).plan, 'family-149');
    assert.equal(getMemberById(m.id).active, true);
    assert.equal(fulfillCheckoutSession({ id: 'cs_plan_1', metadata: { memberId: m.id, kind: 'plan', plan: 'plus-100' } }).reason, 'duplicate');
    assert.equal(getMemberById(m.id).plan, 'family-149'); // replay changes nothing

    const seat = fulfillCheckoutSession({ id: 'cs_seat_1', client_reference_id: m.id, metadata: { kind: 'seat' } });
    assert.deepEqual(seat, { granted: true, kind: 'seat', seatsPaid: 1 });

    assert.equal(fulfillCheckoutSession({ id: 'cs_x', metadata: { memberId: 'm_nope', kind: 'plan', plan: 'plus-100' } }).reason, 'unknown-member');
    assert.equal(fulfillCheckoutSession({ id: 'cs_y', metadata: { memberId: m.id, kind: 'plan', plan: 'yearly-999' } }).reason, 'unknown-kind');
    assert.equal(fulfillCheckoutSession({ metadata: {} }).reason, 'no-session-id');
  });
});

describe('billing routes (HTTP)', () => {
  const app = express();
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.use('/api/billing', billingRouter());
  let server, base;
  const member = addMember({ ownerPhone: '+66810000702', aiNumber: '+6621000172', plan: 'starter-20' });
  const token = createSession(member.id);
  const prevSecret = config.stripeSecretKey;
  const prevWh = config.stripeWebhookSecret;

  before(async () => {
    config.stripeSecretKey = 'sk_test_fake_key_123';
    config.stripeWebhookSecret = 'whsec_route_test';
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    config.stripeSecretKey = prevSecret;
    config.stripeWebhookSecret = prevWh;
    await new Promise((resolve) => server.close(resolve));
  });

  it('requires auth on /checkout and validates the plan', async () => {
    let r = await fetch(`${base}/api/billing/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 401);
    r = await fetch(`${base}/api/billing/checkout`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind: 'plan', plan: 'yearly-999' }),
    });
    assert.equal(r.status, 400);
  });

  it('rejects unsigned webhooks, fulfills signed checkout.session.completed once', async () => {
    const event = { id: 'evt_route_1', type: 'checkout.session.completed', data: { object: { id: 'cs_route_1', metadata: { memberId: member.id, kind: 'plan', plan: 'plus-100' } } } };
    const body = JSON.stringify(event);
    let r = await fetch(`${base}/api/billing/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(r.status, 400);
    const t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},v1=${createHmac('sha256', 'whsec_route_test').update(Buffer.concat([Buffer.from(`${t}.`), Buffer.from(body)])).digest('hex')}`;
    r = await fetch(`${base}/api/billing/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': sig }, body });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { received: true, granted: true, kind: 'plan', plan: 'plus-100' });
    assert.equal(getMemberById(member.id).plan, 'plus-100');
    r = await fetch(`${base}/api/billing/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': sig }, body });
    assert.equal((await r.json()).reason, 'duplicate');
  });

  it('acks ignored event types without granting', async () => {
    const body = JSON.stringify({ id: 'evt_route_2', type: 'payment_intent.created', data: { object: {} } });
    const t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},v1=${createHmac('sha256', 'whsec_route_test').update(Buffer.concat([Buffer.from(`${t}.`), Buffer.from(body)])).digest('hex')}`;
    const r = await fetch(`${base}/api/billing/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': sig }, body });
    assert.deepEqual(await r.json(), { received: true, granted: false, reason: 'ignored-event' });
  });
});
