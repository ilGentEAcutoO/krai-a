// Billing HTTP surface: POST /checkout (auth) + POST /webhook (Stripe).
// Mounted at /api/billing. Webhook signature is verified over req.rawBody
// (captured in server.js) — never over the parsed JSON.
import { Router } from 'express';
import { config } from './config.js';
import { getMemberById } from './store.js';
import { requireAuth } from './auth.js';
import { PLANS, TOPUP_PACKS, GIFTS } from './store.js';
import {
  billingConfigured, createCheckoutSession, verifyWebhookSignature,
  fulfillCheckoutSession, fulfillAutoTopup, maybeAutoTopup, priceIdFor,
} from './billing.js';

export function billingRouter() {
  const r = Router();
  const auth = requireAuth(getMemberById);

  const baseOf = (req) => config.publicBaseUrl
    || `${req.protocol}://${req.get('host')}`;

  // Buy/upgrade a plan (monthly or annual), buy an extra family seat, a
  // 1-year gift, or top up quota minutes.
  // body: { kind: 'plan', plan, interval?: 'month'|'year', region?, from? }
  //       | { kind: 'seat', region?, from? } | { kind: 'gift', gift, region?, from? }
  //       | { kind: 'topup', pack: 'topup-small'|'topup-medium', region?, from? }
  // from 'liff' returns to liff.html after Checkout (LINE in-app flow).
  r.post('/checkout', auth, async (req, res) => {
    if (!billingConfigured()) return res.status(503).json({ error: 'billing-unconfigured' });
    const kind = ['seat', 'topup', 'gift'].includes(req.body?.kind) ? req.body.kind : 'plan';
    const plan = req.body?.plan;
    const pack = req.body?.pack;
    const gift = req.body?.gift;
    const interval = req.body?.interval === 'year' ? 'year' : 'month';
    const region = req.body?.region === 'intl' ? 'intl' : 'th';
    if (kind === 'plan' && !PLANS[plan]) return res.status(400).json({ error: 'invalid-plan' });
    if (kind === 'topup' && !TOPUP_PACKS[pack]) return res.status(400).json({ error: 'invalid-pack' });
    if (kind === 'gift' && !GIFTS[gift]) return res.status(400).json({ error: 'invalid-gift' });
    const item = kind === 'topup' ? pack : kind === 'gift' ? gift : plan;
    if (!priceIdFor(kind, item, region, interval)) return res.status(503).json({ error: 'price-unconfigured' });
    const base = baseOf(req);
    const liff = req.body?.from === 'liff';
    try {
      const session = await createCheckoutSession({
        memberId: req.member.id,
        kind,
        plan: kind === 'seat' ? undefined : item,
        interval,
        region,
        successUrl: liff
          ? `${base}/liff.html?paid=1&kind=${kind}&session_id={CHECKOUT_SESSION_ID}`
          : `${base}/dashboard.html?paid=1&kind=${kind}&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: liff ? `${base}/liff.html?cancelled=1` : `${base}/pricing.html?cancelled=1`,
      });
      res.json({ url: session.url, sessionId: session.id });
    } catch (e) {
      // Stripe's message can name customers/prices: log it, never echo it.
      console.error('[billing] checkout failed:', e.message);
      res.status(e.status === 503 ? 503 : 502).json({ error: e.status === 503 ? e.message : 'stripe-error' });
    }
  });

  // LIFF "charge now" / cron: run the auto-topup decision for this member.
  // Card on file → off-session charge; PromptPay/unknown → manual prompt.
  r.post('/auto-topup/charge', auth, async (req, res) => {
    if (!billingConfigured()) return res.status(503).json({ error: 'billing-unconfigured' });
    try {
      const { detail, ...result } = await maybeAutoTopup(req.member);
      if (detail) console.error('[billing] auto-topup:', detail);
      res.json(result);
    } catch (e) {
      console.error('[billing] auto-topup failed:', e.message);
      res.status(502).json({ error: 'stripe-error' });
    }
  });

  // Stripe CLI local dev: stripe listen --forward-to localhost:PORT/api/billing/webhook
  r.post('/webhook', async (req, res) => {
    if (!config.stripeWebhookSecret) return res.status(503).json({ error: 'billing-unconfigured' });
    const ok = verifyWebhookSignature(req.rawBody, req.headers['stripe-signature'], config.stripeWebhookSecret);
    if (!ok) return res.status(400).json({ error: 'invalid-signature' });
    const event = req.body;
    if (event?.type === 'checkout.session.completed' || event?.type === 'checkout.session.async_payment_succeeded') {
      const result = fulfillCheckoutSession(event.data?.object);
      return res.json({ received: true, ...result });
    }
    if (event?.type === 'payment_intent.succeeded') {
      const result = fulfillAutoTopup(event.data?.object);
      return res.json({ received: true, ...result });
    }
    res.json({ received: true, granted: false, reason: 'ignored-event' });
  });

  return r;
}
