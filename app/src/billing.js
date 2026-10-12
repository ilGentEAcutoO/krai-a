// Stripe billing (test mode): Checkout Sessions + webhook fulfillment.
// No Stripe SDK — direct REST via fetch + manual webhook signature check,
// so the demo has zero new dependencies. Production would swap one-time
// `payment` mode for card subscriptions; PromptPay stays one-time only
// (Stripe does not support recurring PromptPay).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import {
  PLANS, GIFTS, TOPUP_PACKS, setPlan, getMemberById, grantTopup, quotaSummary,
  isFulfilled, markFulfilled, resetFulfilled, addSeatPeriod, quotaPeriodKey, currentPlanId,
} from './store.js';
import { take } from './ratelimit.js';

export const STRIPE_API = 'https://api.stripe.com/v1';
const WEBHOOK_TOLERANCE_SEC = 300;

// kind: 'plan' | 'seat' | 'topup' | 'gift'. region: 'th' (THB, card +
// PromptPay) | 'intl' (USD, card). `plan` carries the plan id, the pack id
// (topup) or the gift id (gift). interval 'year' = the annual plan price.
// Only items on sale (PLANS / GIFTS / TOPUP_PACKS) have a price.
export function priceIdFor(kind, plan, region, interval = 'month') {
  const r = region === 'intl' ? 'intl' : 'th';
  if (kind === 'seat') return config.stripePrices.seat[r] || '';
  if (kind === 'topup') return TOPUP_PACKS[plan] ? config.stripePrices[plan]?.[r] || '' : '';
  if (kind === 'gift') return GIFTS[plan] ? config.stripePrices[plan]?.[r] || '' : '';
  if (!PLANS[plan]) return '';
  return config.stripePrices[plan]?.[interval === 'year' ? `${r}_year` : r] || '';
}

// TH checkouts offer card + PromptPay (annual PromptPay is the cheapest
// rail); intl is card only.
export function paymentMethodsFor(kind, plan, region) {
  if (region === 'intl') return ['card'];
  return ['card', 'promptpay'];
}

export const billingConfigured = () => config.stripeSecretKey.length > 10;

// Create a one-time Checkout Session. fetchImpl is injectable for tests.
// Card checkouts save the card for future off-session auto-topup: the
// known Stripe customer is reused, otherwise Checkout creates one
// (customer_creation=always — the default if_required would NOT create
// one in payment mode) and the webhook stamps session.customer onto the
// member. (A PromptPay-only checkout would set neither — Stripe rejects
// off_session setup on PromptPay, which can never be charged off-session.)
export async function createCheckoutSession(
  { memberId, kind, plan, interval = 'month', region = 'th', successUrl, cancelUrl },
  { fetchImpl = fetch, secretKey = config.stripeSecretKey, member = null } = {},
) {
  const price = priceIdFor(kind, plan, region, interval);
  if (!secretKey) throw Object.assign(new Error('billing-unconfigured'), { status: 503 });
  if (!price) throw Object.assign(new Error('price-unconfigured'), { status: 503 });
  const methods = paymentMethodsFor(kind, plan, region);
  const m = member || (memberId ? getMemberById(memberId) : null);
  const body = new URLSearchParams();
  body.set('mode', 'payment');
  body.set('client_reference_id', memberId);
  if (methods.includes('card')) {
    if (m?.stripeCustomerId) body.set('customer', m.stripeCustomerId);
    else body.set('customer_creation', 'always');
    body.set('payment_intent_data[setup_future_usage]', 'off_session');
  }
  body.set('line_items[0][price]', price);
  body.set('line_items[0][quantity]', '1');
  for (const m of methods) body.append('payment_method_types[]', m);
  body.set('metadata[memberId]', memberId);
  body.set('metadata[kind]', kind);
  body.set('metadata[region]', region === 'intl' ? 'intl' : 'th');
  if (kind === 'plan') {
    body.set('metadata[plan]', plan);
    body.set('metadata[interval]', interval === 'year' ? 'year' : 'month');
  }
  if (kind === 'topup') body.set('metadata[pack]', plan);
  if (kind === 'gift') body.set('metadata[gift]', plan);
  body.set('success_url', successUrl);
  body.set('cancel_url', cancelUrl);
  if (region !== 'intl') body.set('locale', 'th');
  const res = await fetchImpl(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data?.error?.message || 'stripe-error'), {
      status: 502, code: data?.error?.code,
    });
  }
  return data;
}

// Verify the Stripe-Signature header over the RAW request bytes.
export function verifyWebhookSignature(rawBody, sigHeader, secret, { toleranceSec = WEBHOOK_TOLERANCE_SEC, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  if (!secret || !sigHeader) return false;
  const parts = Object.fromEntries(
    String(sigHeader).split(',').map((kv) => {
      const i = kv.indexOf('=');
      return i < 0 ? [] : [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }).filter((e) => e.length === 2),
  );
  const t = Number(parts.t);
  const v1s = String(sigHeader).split(',').filter((kv) => kv.trim().startsWith('v1=')).map((kv) => kv.trim().slice(3));
  if (!Number.isFinite(t) || v1s.length === 0) return false;
  if (Math.abs(nowSec - t) > toleranceSec) return false;
  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  const expected = createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`${t}.`, 'utf8'), raw])).digest();
  return v1s.some((v1) => {
    const sig = Buffer.from(v1, 'hex');
    return sig.length === expected.length && timingSafeEqual(sig, expected);
  });
}

// Monthly plan = 30 days; annual (metadata[interval]=year) = 365.
const planPeriodDays = (md = {}) => (md.interval === 'year' ? 365 : 30);

// Paid period: renewals and gifts stack from the later of now / current
// paid-until. The trial lifecycle counts a household as paid only while
// this is in the future. Top-ups and seats never touch it.
function grantPaidPlan(member, planId, days) {
  setPlan(member.id, planId);
  const now = Date.now();
  const from = Math.max(now, Date.parse(member.planPaidUntil || '') || 0);
  member.planPaidAt = new Date(now).toISOString();
  member.planPaidUntil = new Date(from + days * 86400000).toISOString();
  member.active = true;
  member.cancelledAt = null;
}

// Fulfilled Stripe ids (idempotency for webhook retries) live in store.js
// so they persist with the snapshot — a redelivery after a restart is a no-op.
export const __resetFulfilled = resetFulfilled;

// Grant plan/seat/topup from a checkout.session.completed session object.
// Returns { granted, reason } — never throws for unknown payloads.
export function fulfillCheckoutSession(session = {}) {
  const id = session.id;
  if (!id) return { granted: false, reason: 'no-session-id' };
  if (isFulfilled(id)) return { granted: false, reason: 'duplicate' };
  // Async methods complete Checkout before the money lands: grant only when
  // paid (checkout.session.async_payment_succeeded re-sends the session).
  if (session.payment_status && !['paid', 'no_payment_required'].includes(session.payment_status)) {
    return { granted: false, reason: 'unpaid' };
  }
  const md = session.metadata || {};
  const memberId = md.memberId || session.client_reference_id || '';
  const kind = md.kind || '';
  const member = memberId ? getMemberById(memberId) : null;
  if (!member) return { granted: false, reason: 'unknown-member' };
  if (kind === 'seat') {
    const seatsPaid = addSeatPeriod(member); // one-time ฿69 = one 30-day seat period
    stampPaymentOrigin(member, session, md);
    markFulfilled(id);
    return { granted: true, kind: 'seat', seatsPaid };
  }
  const planId = kind === 'plan' ? currentPlanId(md.plan) : null; // sessions from before v2 map to the successor
  if (planId) {
    grantPaidPlan(member, planId, planPeriodDays(md));
    stampPaymentOrigin(member, session, md);
    markFulfilled(id);
    return { granted: true, kind: 'plan', plan: planId, interval: md.interval === 'year' ? 'year' : 'month' };
  }
  if (kind === 'gift' && GIFTS[md.gift]) {
    const gift = GIFTS[md.gift];
    grantPaidPlan(member, gift.plan, gift.days); // one-time: nothing renews it
    member.lastGift = { id: md.gift, at: new Date().toISOString() };
    stampPaymentOrigin(member, session, md);
    markFulfilled(id);
    return { granted: true, kind: 'gift', gift: md.gift, plan: gift.plan };
  }
  if (kind === 'topup' && TOPUP_PACKS[md.pack]) {
    grantTopup(member, md.pack);
    stampPaymentOrigin(member, session, md);
    markFulfilled(id);
    return { granted: true, kind: 'topup', pack: md.pack, topupMinutes: member.topupMinutes, topupCalls: member.topupCalls };
  }
  return { granted: false, reason: 'unknown-kind' };
}

// Remember HOW the member paid: auto-billing can only charge saved cards.
// PromptPay (and unknown) users always get the manual-topup prompt instead.
function stampPaymentOrigin(member, session, md = {}) {
  const pm = session.payment_method_types?.[0];
  if (pm === 'card' || pm === 'promptpay') member.payMethod = pm;
  if (session.customer) member.stripeCustomerId = String(session.customer).slice(0, 64);
  if (md.region === 'intl' || md.region === 'th') member.billingRegion = md.region;
}

// Grant a topup bought via off-session auto-charge (payment_intent.succeeded).
// Same idempotency set as Checkout (pi_* ids never collide with cs_* ids).
export function fulfillAutoTopup(pi = {}) {
  const id = pi.id;
  if (!id) return { granted: false, reason: 'no-payment-intent-id' };
  if (isFulfilled(id)) return { granted: false, reason: 'duplicate' };
  const md = pi.metadata || {};
  if (md.kind !== 'topup' || !TOPUP_PACKS[md.pack]) return { granted: false, reason: 'unknown-kind' };
  const member = md.memberId ? getMemberById(md.memberId) : null;
  if (!member) return { granted: false, reason: 'unknown-member' };
  if (pi.status && pi.status !== 'succeeded') return { granted: false, reason: 'not-succeeded' };
  member.autoTopupPendingUntil = null; // the pending charge resolved
  grantTopup(member, md.pack);
  if (pi.customer) member.stripeCustomerId = String(pi.customer).slice(0, 64);
  member.payMethod = 'card';
  markFulfilled(id);
  return { granted: true, kind: 'topup', pack: md.pack, topupMinutes: member.topupMinutes, topupCalls: member.topupCalls };
}

// ---- auto-billing (card path; PromptPay can never be charged off-session)
// Card checkouts save the card via payment_intent_data[setup_future_usage]
// (see createCheckoutSession); the webhook stamps session.customer onto
// the member. Members without stripeCustomerId get { charged:false,
// manual:true } and the LIFF meter shows the manual-topup button.
export function topupAmountFor(packId, region) {
  const pack = TOPUP_PACKS[packId];
  if (!pack) return null;
  return region === 'intl'
    ? { amount: pack.usd * 100, currency: 'usd' }
    : { amount: pack.price * 100, currency: 'thb' };
}

// Newest saved card for off-session charging. The PaymentIntent fallback
// without payment_method is the legacy customer.default_source
// (Charges-API era) — Checkout-saved cards are PaymentMethods, so the id
// must be passed explicitly (Stripe docs: "We recommend that you
// explicitly provide the payment_method"). Lists are newest-first, so
// limit=1 returns the latest card.
export async function latestSavedCard(customerId, { fetchImpl = fetch, secretKey = config.stripeSecretKey } = {}) {
  let res;
  try {
    res = await fetchImpl(`${STRIPE_API}/payment_methods?customer=${encodeURIComponent(customerId)}&type=card&limit=1`, {
      headers: { Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}` },
    });
  } catch {
    return { ok: false, detail: 'transport-error' };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, detail: data?.error?.message || '' };
  return { ok: true, paymentMethodId: data?.data?.[0]?.id || '' };
}

// Charge the saved card off-session for one topup pack. fetchImpl injectable.
export async function createAutoTopupPayment(
  member,
  { fetchImpl = fetch, secretKey = config.stripeSecretKey } = {},
) {
  const q = quotaSummary(member);
  const auto = q.autoTopup;
  if (!member) return { charged: false, reason: 'unknown-member' };
  if (!auto.enabled) return { charged: false, reason: 'auto-topup-disabled' };
  if (!secretKey) return { charged: false, reason: 'billing-unconfigured' };
  if (member.payMethod !== 'card' || !member.stripeCustomerId) {
    return { charged: false, reason: 'no-saved-card', manual: true };
  }
  const card = await latestSavedCard(member.stripeCustomerId, { fetchImpl, secretKey });
  if (!card.ok) return { charged: false, reason: 'stripe-error', manual: true, detail: card.detail };
  if (!card.paymentMethodId) return { charged: false, reason: 'no-saved-card', manual: true };
  const money = topupAmountFor(auto.pack, member.billingRegion);
  if (!money) return { charged: false, reason: 'unknown-pack' };
  const body = new URLSearchParams();
  body.set('customer', member.stripeCustomerId);
  body.set('payment_method', card.paymentMethodId);
  body.set('amount', String(money.amount));
  body.set('currency', money.currency);
  body.set('off_session', 'true');
  body.set('confirm', 'true');
  body.set('metadata[memberId]', member.id);
  body.set('metadata[kind]', 'topup');
  body.set('metadata[pack]', auto.pack);
  // One key per attempt: a network retry of THIS request can never create
  // a second charge; a later attempt (new card, next low) gets a new key.
  const period = quotaPeriodKey();
  if (member.autoTopupAttempts?.period !== period) member.autoTopupAttempts = { period, n: 0 };
  member.autoTopupAttempts.n += 1;
  let res;
  try {
    res = await fetchImpl(`${STRIPE_API}/payment_intents`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': `auto-${member.id}-${period}-${member.autoTopupAttempts.n}`,
      },
      body: body.toString(),
    });
  } catch {
    return { charged: false, reason: 'stripe-error', manual: true, detail: 'transport-error' };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { charged: false, reason: 'stripe-error', manual: true, detail: data?.error?.message || '' };
  }
  // Not settled yet (bank auth / processing): quota still reads "due", so
  // block new charges until the webhook resolves it or the hold expires.
  if (PENDING_STATUSES.has(data.status)) member.autoTopupPendingUntil = new Date(Date.now() + PENDING_HOLD_MS).toISOString();
  // Webhook payment_intent.succeeded grants the minutes (idempotent); grant
  // here too for the synchronous success path — fulfillAutoTopup dedupes.
  if (data.status === 'succeeded') fulfillAutoTopup({ ...data, metadata: { memberId: member.id, kind: 'topup', pack: auto.pack } });
  return { charged: data.status === 'succeeded', paymentIntentId: data.id, status: data.status, quota: quotaSummary(member) };
}

// Decide + charge when quota runs low. Called by POST /api/billing/auto-topup/charge
// (LIFF "charge now" button / cron). Never throws for routine states.
// Off-session charges are single-flight per member, held while a previous
// intent is still pending, and capped per member per day.
const PENDING_STATUSES = new Set(['processing', 'requires_action', 'requires_confirmation', 'requires_capture']);
const PENDING_HOLD_MS = 30 * 60 * 1000;
const AUTO_CHARGES_PER_DAY = 3;
const chargesInFlight = new Set(); // member ids

export async function maybeAutoTopup(member, opts = {}) {
  const q = quotaSummary(member);
  if (!q.autoTopup.enabled) return { charged: false, reason: 'auto-topup-disabled', quota: q };
  if (!q.autoTopup.due && !q.autoTopup.manualPrompt) return { charged: false, reason: 'quota-healthy', quota: q };
  if (q.autoTopup.manualPrompt) return { charged: false, reason: 'manual-topup-required', manual: true, quota: q };
  if (chargesInFlight.has(member.id)) return { charged: false, reason: 'charge-in-flight', quota: q };
  if (Date.parse(member.autoTopupPendingUntil || '') > Date.now()) return { charged: false, reason: 'charge-pending', quota: q };
  if (!take(`autotopup:member:${member.id}`, AUTO_CHARGES_PER_DAY, 86400000).ok) {
    return { charged: false, reason: 'daily-cap', manual: true, quota: q };
  }
  chargesInFlight.add(member.id);
  try {
    return await createAutoTopupPayment(member, opts);
  } finally {
    chargesInFlight.delete(member.id);
  }
}
