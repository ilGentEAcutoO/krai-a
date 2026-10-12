// Hardening found by the PDPA hotfix (TASK-020): no free plan upgrades,
// Twilio webhook signatures, store indexes rebuilt after restart, crypto OTP
// codes, and secrets kept out of the Cloud Build upload.
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import express from 'express';
import { config } from '../src/config.js';
import {
  addMember, addNumber, getMemberByOwner, getMemberById, findMember,
  serializeStore, restoreStore, listMembers,
} from '../src/store.js';
import { createSession, requestOtp, peekOtpForMockSms } from '../src/auth.js';
import { resetLimits } from '../src/ratelimit.js';
import { demoRouter, engineLabel } from '../src/routes.js';
import { twilioSignature, twilioSignatureFor } from '../src/twilio/signature.js';

// Offline: mock SMS (devCode), no Gemini.
config.geminiApiKey = '';
config.thsmsApiKey = '';
config.twilioVerifySid = '';
config.recaptchaApiKey = '';

let server; let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', demoRouter(() => {}));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); });
afterEach(() => resetLimits());

const post = async (p, body, token) => {
  const r = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

describe('POST /me/plan never grants paid features without payment', () => {
  it('upgrade is refused with 402 and a checkout hint', async () => {
    const m = addMember({ ownerPhone: '+66810009401', aiNumber: '+66210009401', plan: 'solo-99' });
    const token = createSession(m.id);
    for (const plan of ['family-199']) {
      const r = await post('/api/me/plan', { plan }, token);
      assert.equal(r.status, 402, plan);
      assert.equal(r.body.error, 'payment-required');
      assert.deepEqual(r.body.checkout, { kind: 'plan', plan });
    }
    assert.equal(getMemberById(m.id).plan, 'solo-99');
  });

  it('downgrade / same plan is allowed (grants nothing)', async () => {
    const m = addMember({ ownerPhone: '+66810009402', aiNumber: '+66210009402', plan: 'family-199' });
    const token = createSession(m.id);
    const down = await post('/api/me/plan', { plan: 'solo-99' }, token);
    assert.equal(down.status, 200);
    assert.equal(down.body.member.plan, 'solo-99');
    const same = await post('/api/me/plan', { plan: 'solo-99' }, token);
    assert.equal(same.status, 200);
    const back = await post('/api/me/plan', { plan: 'family-199' }, token);
    assert.equal(back.status, 402, 'going back up needs billing');
  });

  it('unknown plan → 400, no session → 401', async () => {
    const m = addMember({ ownerPhone: '+66810009403', aiNumber: '+66210009403' });
    assert.equal((await post('/api/me/plan', { plan: 'gold' }, createSession(m.id))).status, 400);
    assert.equal((await post('/api/me/plan', { plan: 'solo-99' })).status, 401);
  });
});

describe('Twilio webhook signature (X-Twilio-Signature)', () => {
  // Worked example from Twilio's webhook security docs.
  it('matches the documented HMAC-SHA1 vector', () => {
    const sig = twilioSignatureFor('12345', 'https://mycompany.com/myapp.php?foo=1&bar=2', {
      CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212',
    });
    assert.equal(sig, '0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
  });

  const TOKEN = 'twilio-test-token-123';
  const saved = { token: config.twilioAuthToken, base: config.publicBaseUrl, env: process.env.NODE_ENV };
  let vServer; let vBase;
  before(async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.urlencoded({ extended: false }));
    app.use('/voice', twilioSignature());
    app.post('/voice/turn', (req, res) => res.type('text/xml').send('<Response/>'));
    await new Promise((resolve) => { vServer = app.listen(0, resolve); });
    vBase = `http://127.0.0.1:${vServer.address().port}`;
  });
  after(async () => {
    config.twilioAuthToken = saved.token;
    config.publicBaseUrl = saved.base;
    process.env.NODE_ENV = saved.env;
    await new Promise((resolve) => vServer.close(resolve));
  });

  // Independent reference implementation of Twilio's algorithm.
  const sign = (url, params, token = TOKEN) => createHmac('sha1', token)
    .update(url + Object.keys(params).sort().map((k) => k + params[k]).join(''), 'utf8').digest('base64');
  const send = (path, params, sig, headers = {}) => fetch(`${vBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(sig ? { 'X-Twilio-Signature': sig } : {}), ...headers },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(5000),
  });
  const params = { CallSid: 'CA1', From: '+66811112222', SpeechResult: 'สวัสดีครับ', To: '+6621000142' };

  it('accepts a request signed for PUBLIC_BASE_URL + path + query', async () => {
    config.twilioAuthToken = TOKEN;
    config.publicBaseUrl = 'https://krai-a.com';
    const r = await send('/voice/turn?callId=call_abc', params, sign('https://krai-a.com/voice/turn?callId=call_abc', params));
    assert.equal(r.status, 200);
  });

  it('accepts a request signed for the forwarded run.app host too', async () => {
    config.twilioAuthToken = TOKEN;
    config.publicBaseUrl = 'https://krai-a.com';
    const url = 'https://krai-a-x.a.run.app/voice/turn?callId=call_abc';
    const r = await send('/voice/turn?callId=call_abc', params, sign(url, params), {
      'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'krai-a-x.a.run.app',
    });
    assert.equal(r.status, 200);
  });

  it('rejects missing, wrong-token, and tampered requests with 403', async () => {
    config.twilioAuthToken = TOKEN;
    config.publicBaseUrl = 'https://krai-a.com';
    const url = 'https://krai-a.com/voice/turn?callId=call_abc';
    assert.equal((await send('/voice/turn?callId=call_abc', params)).status, 403);
    assert.equal((await send('/voice/turn?callId=call_abc', params, sign(url, params, 'other-token'))).status, 403);
    const tampered = { ...params, SpeechResult: 'โอนเงินมา' };
    assert.equal((await send('/voice/turn?callId=call_abc', tampered, sign(url, params))).status, 403);
    assert.equal((await send('/voice/turn?callId=call_other', params, sign(url, params))).status, 403);
  });

  it('bypass only when the token is empty AND NODE_ENV=test; otherwise fail closed', async () => {
    config.twilioAuthToken = '';
    process.env.NODE_ENV = 'test';
    assert.equal((await send('/voice/turn', params)).status, 200);
    process.env.NODE_ENV = 'production';
    assert.equal((await send('/voice/turn', params)).status, 403);
    delete process.env.NODE_ENV;
    assert.equal((await send('/voice/turn', params)).status, 403);
    config.twilioAuthToken = TOKEN;
    process.env.NODE_ENV = 'test';
    assert.equal((await send('/voice/turn', params)).status, 403, 'a configured token is always enforced');
  });
});

describe('restoreStore rebuilds every index', () => {
  it('owner + every AI number resolve after restart; no duplicate members', () => {
    const m = addMember({ ownerPhone: '+66810009501', aiNumber: '+66210009501', plan: 'family-199' });
    addNumber(m.id, '+66210009502');
    const snap = JSON.parse(JSON.stringify(serializeStore()));
    assert.equal(snap.members.filter((x) => x.id === m.id).length, 1, 'aliases serialize once');

    restoreStore({});
    restoreStore(snap);
    const owner = getMemberByOwner('+66810009501');
    assert.ok(owner, 'owner index rebuilt');
    assert.equal(owner.id, m.id);
    assert.equal(findMember({ to: '+66210009501', mode: 'A' }).member?.id, m.id, 'primary AI number');
    assert.equal(findMember({ to: '+66210009502', mode: 'A' }).member?.id, m.id, 'alias AI number');
    assert.equal(findMember({ forwardedFrom: '+66810009501', mode: 'B' }).member?.id, m.id, 'mode B');
    assert.strictEqual(findMember({ to: '+66210009502', mode: 'A' }).member, owner, 'one object per household');
    assert.equal(listMembers().filter((x) => x.id === m.id).length >= 1, true);
  });

  it('legacy snapshots with alias duplicates collapse to one household', () => {
    const m = addMember({ ownerPhone: '+66810009503', aiNumber: '+66210009503' });
    addNumber(m.id, '+66210009504');
    const legacy = JSON.parse(JSON.stringify({ members: [m, m] }));
    restoreStore(legacy);
    assert.equal(new Set([getMemberByOwner('+66810009503'), findMember({ to: '+66210009504', mode: 'A' }).member]).size, 1);
    assert.equal(JSON.parse(JSON.stringify(serializeStore())).members.length, 1);
  });

  it('OTP login after a restart reuses the account (no duplicate signup)', async () => {
    const m = addMember({ ownerPhone: '+66810009505', aiNumber: '+66210009505' });
    restoreStore(JSON.parse(JSON.stringify(serializeStore())));
    const phone = '+66810009505';
    const r1 = await post('/api/auth/request-otp', { phone });
    assert.equal(r1.status, 200);
    const r2 = await post('/api/auth/verify-otp', { phone, code: r1.body.devCode });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.isNew, false);
    assert.equal(r2.body.member.id, m.id);
  });
});

describe('OTP codes', () => {
  it('come from crypto, not Math.random', () => {
    const realRandom = Math.random;
    Math.random = () => 0; // the old generator would always yield 100000
    try {
      const codes = new Set();
      for (let i = 0; i < 6; i += 1) {
        const phone = `+6681000960${i}`;
        requestOtp(phone);
        const code = peekOtpForMockSms(phone);
        assert.match(code, /^\d{6}$/);
        codes.add(code);
      }
      assert.ok(codes.size > 1, 'codes are not predictable');
    } finally {
      Math.random = realRandom;
    }
  });
});

describe('.gcloudignore keeps secrets out of Cloud Build', () => {
  it('excludes .env and every .env.* except .env.example', () => {
    const lines = readFileSync(new URL('../.gcloudignore', import.meta.url), 'utf8').split(/\r?\n/).map((s) => s.trim());
    assert.ok(lines.includes('.env'));
    assert.ok(lines.includes('.env.*'));
    assert.ok(lines.includes('!.env.example'));
  });
});

describe('LINE binding needs a verified LINE login', () => {
  it('POST /me/notify can unlink but never set a raw LINE user id', async () => {
    const m = addMember({ ownerPhone: '+66810009701', aiNumber: '+66210009701', lineUserId: 'Uold' });
    const token = createSession(m.id);
    const set = await post('/api/me/notify', { lineUserId: 'Uvictim0000' }, token);
    assert.equal(set.status, 400);
    assert.equal(set.body.error, 'use-link-line');
    assert.equal(getMemberById(m.id).lineUserId, 'Uold');
    const clear = await post('/api/me/notify', { lineUserId: '' }, token);
    assert.equal(clear.status, 200);
    assert.equal(getMemberById(m.id).lineUserId, '');
  });
});

describe('Stripe fulfillment only grants paid sessions', () => {
  it('checkout.session.completed with payment_status unpaid grants nothing', async () => {
    const { fulfillCheckoutSession } = await import('../src/billing.js');
    const m = addMember({ ownerPhone: '+66810009702', aiNumber: '+66210009702', plan: 'solo-99' });
    const md = { memberId: m.id, kind: 'plan', plan: 'family-199' };
    assert.equal(fulfillCheckoutSession({ id: 'cs_unpaid_1', payment_status: 'unpaid', metadata: md }).granted, false);
    assert.equal(getMemberById(m.id).plan, 'solo-99');
    assert.equal(fulfillCheckoutSession({ id: 'cs_unpaid_1', payment_status: 'paid', metadata: md }).granted, true,
      'the async_payment_succeeded retry of the same session still grants once paid');
    assert.equal(getMemberById(m.id).plan, 'family-199');
  });
});

describe('retired pages redirect (301) to the one-page site', () => {
  it('maps every deleted page to its section', async () => {
    const { mountRedirects } = await import('../src/redirects.js');
    const app = express();
    mountRedirects(app);
    const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    try {
      const at = `http://127.0.0.1:${srv.address().port}`;
      const expected = { '/features.html': '/#family', '/how-it-works.html': '/#setup', '/family.html': '/#family', '/stats.html': '/' };
      for (const [from, to] of Object.entries(expected)) {
        const r = await fetch(`${at}${from}`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
        assert.equal(r.status, 301, from);
        assert.equal(r.headers.get('location'), to, from);
      }
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  });
});

describe('a paid plan is marked paid (trial lifecycle never lapses it)', () => {
  it('fulfilling a paid plan checkout stamps planPaidAt', async () => {
    const { fulfillCheckoutSession } = await import('../src/billing.js');
    const m = addMember({ ownerPhone: '+66810009703', aiNumber: '+66210009703', plan: 'solo-99' });
    assert.equal(m.planPaidAt, undefined);
    const r = fulfillCheckoutSession({ id: 'cs_paid_plan_1', payment_status: 'paid', metadata: { memberId: m.id, kind: 'plan', plan: 'family-199' } });
    assert.equal(r.granted, true);
    assert.ok(Date.parse(getMemberById(m.id).planPaidAt) > 0);
  });
});

describe('/api/status engine label is truthful', () => {
  const snap = (jev, gemini) => ({ mode: jev && gemini ? 'live' : jev || gemini ? 'degraded' : 'rules', jev: { ok: jev }, gemini: { ok: gemini } });
  it('names exactly the engines that are up', () => {
    assert.equal(engineLabel(snap(true, true)), 'jev+gemini');
    assert.equal(engineLabel(snap(true, false)), 'jev', 'Jev only is never called gemini');
    assert.equal(engineLabel(snap(false, true)), 'gemini');
    assert.equal(engineLabel(snap(false, false)), 'rules');
    assert.equal(engineLabel(undefined), 'rules');
  });

  it('offline suite reports rules with per-engine flags', async () => {
    const r = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(5000) }).then((x) => x.json());
    assert.equal(r.engine, 'rules');
    assert.deepEqual(r.engines, { jev: false, gemini: false });
    assert.equal(r.engineStatus.mode, 'rules');
  });
});

describe('paid plan period (planPaidUntil)', () => {
  const DAY = 86400000;
  const plan = (m, id, plan = 'solo-99') => ({ id, payment_status: 'paid', metadata: { memberId: m.id, kind: 'plan', plan } });
  const near = (iso, ms, label) => assert.ok(Math.abs(Date.parse(iso) - ms) < 60000, `${label}: ${iso}`);

  it('first purchase pays 30 days from now', async () => {
    const { fulfillCheckoutSession } = await import('../src/billing.js');
    const m = addMember({ ownerPhone: '+66810009801', aiNumber: '+66210009801' });
    fulfillCheckoutSession(plan(m, 'cs_period_1'));
    near(m.planPaidUntil, Date.now() + 30 * DAY, 'until');
  });

  it('early renewal extends from the current paid-until, late renewal from now', async () => {
    const { fulfillCheckoutSession } = await import('../src/billing.js');
    const early = addMember({ ownerPhone: '+66810009802', aiNumber: '+66210009802' });
    early.planPaidUntil = new Date(Date.now() + 10 * DAY).toISOString();
    fulfillCheckoutSession(plan(early, 'cs_period_2'));
    near(early.planPaidUntil, Date.now() + 40 * DAY, 'early renew');
    const late = addMember({ ownerPhone: '+66810009803', aiNumber: '+66210009803' });
    late.planPaidUntil = new Date(Date.now() - 5 * DAY).toISOString();
    fulfillCheckoutSession(plan(late, 'cs_period_3'));
    near(late.planPaidUntil, Date.now() + 30 * DAY, 'late renew');
  });

  it('top-ups and seats never touch planPaidAt / planPaidUntil', async () => {
    const { fulfillCheckoutSession, fulfillAutoTopup } = await import('../src/billing.js');
    const m = addMember({ ownerPhone: '+66810009804', aiNumber: '+66210009804' });
    fulfillCheckoutSession({ id: 'cs_topup_p1', payment_status: 'paid', metadata: { memberId: m.id, kind: 'topup', pack: 'topup-small' } });
    fulfillCheckoutSession({ id: 'cs_seat_p1', payment_status: 'paid', metadata: { memberId: m.id, kind: 'seat' } });
    fulfillAutoTopup({ id: 'pi_topup_p1', status: 'succeeded', metadata: { memberId: m.id, kind: 'topup', pack: 'topup-small' } });
    assert.equal(m.planPaidAt, undefined);
    assert.equal(m.planPaidUntil, undefined);
  });
});

describe('mode B: the legacy seat flow is closed', () => {
  it('/me/numbers never hands out pool numbers or texts seat codes in mode B', async () => {
    const saved = config.identifyMode;
    config.identifyMode = 'B';
    try {
      const m = addMember({ ownerPhone: '+66810009901', aiNumber: '', plan: 'family-199' });
      const token = createSession(m.id);
      const add = await post('/api/me/numbers', { ownerPhone: '0810009902' }, token);
      assert.equal(add.status, 410);
      assert.equal(add.body.error, 'use-protected');
      const verify = await post('/api/me/numbers/verify', { aiNumber: '+6621', code: '123456' }, token);
      assert.equal(verify.status, 410);
      assert.deepEqual(getMemberById(m.id).pendingSeats, []);
    } finally {
      config.identifyMode = saved;
    }
  });
});
