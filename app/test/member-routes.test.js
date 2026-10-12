// Member app API (central-number households): household snapshot, adding a
// protected person (OTP goes to THAT phone = consent), plan caps, removal,
// waitlist channel, and the watcher LINE-link guard rails.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { config } from '../src/config.js';
import { addMember, addWhitelist, PLANS } from '../src/store.js';
// Plan ids/limits come from the PLANS table (pricing changes without test edits).
const FAMILY = Object.keys(PLANS).find((id) => id.startsWith('family'));
const SOLO = Object.keys(PLANS).find((id) => PLANS[id].numbers === 1);
import { createSession, requestOtp, verifyOtp, peekOtpForMockSms, sendOtp } from '../src/auth.js';
import { memberRouter } from '../src/memberRoutes.js';
import { resetLimits } from '../src/ratelimit.js';

// Mock SMS only: .env may hold a live THSMS key — tests must never text anyone.
const savedSms = { thsms: config.thsmsApiKey, sid: config.twilioVerifySid, captcha: config.recaptchaApiKey };
let server;
let base;
before(async () => {
  config.thsmsApiKey = '';
  config.twilioVerifySid = '';
  config.recaptchaApiKey = ''; // gate off unless a test turns it on
  const app = express();
  app.use(express.json());
  app.use('/api', memberRouter());
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => {
  server.close();
  config.thsmsApiKey = savedSms.thsms;
  config.twilioVerifySid = savedSms.sid;
  config.recaptchaApiKey = savedSms.captcha;
});

let seq = 0;
function login(plan = FAMILY) {
  seq += 1;
  const m = addMember({ ownerPhone: `+66893330${String(100 + seq)}`, aiNumber: '', plan });
  m.protected = [];
  return { m, token: createSession(m.id) };
}
async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

describe('member routes', () => {
  it('requires a session', async () => {
    assert.equal((await call('/me/household')).status, 401);
  });

  it('returns the household snapshot without plaintext safe words', async () => {
    const { m, token } = login();
    addWhitelist(m.id, { phone: '+66893339991', label: 'aunt', safeWord: 'papaya' });
    const r = await call('/me/household', { token });
    assert.equal(r.status, 200);
    assert.equal(r.data.household.protectedMax, PLANS[FAMILY].numbers);
    assert.ok(['live', 'waitlist'].includes(r.data.household.central.state));
    assert.equal(JSON.stringify(r.data).includes('papaya'), false);
  });

  it('adds a protected person after the OTP on their own phone', async () => {
    const { token } = login();
    const mom = '0893331001';
    const a = await call('/me/protected', { method: 'POST', token, body: { phone: mom, label: 'mother' } });
    assert.equal(a.status, 200);
    assert.equal(a.data.pending, true);
    assert.match(a.data.devCode, /^\d{6}$/); // mock SMS mode shows the code
    const bad = await call('/me/protected/verify', { method: 'POST', token, body: { phone: mom, code: '000000' } });
    assert.equal(bad.status, 400);
    const ok = await call('/me/protected/verify', { method: 'POST', token, body: { phone: mom, code: a.data.devCode } });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.household.protected[0].phone, '+66893331001');
    assert.equal(ok.data.household.protected[0].label, 'mother');
  });

  it('refuses a second person beyond the plan cap', async () => {
    const { token } = login(SOLO);
    await call('/me/protected/self', { method: 'POST', token });
    const r = await call('/me/protected', { method: 'POST', token, body: { phone: '0893331002', label: 'father' } });
    assert.equal(r.status, 403);
    assert.equal(r.data.error, 'plan-limit');
  });

  it('removes a protected person', async () => {
    const { m, token } = login();
    await call('/me/protected/self', { method: 'POST', token });
    const r = await call('/me/protected', { method: 'DELETE', token, body: { phone: m.ownerPhone } });
    assert.equal(r.status, 200);
    assert.equal(r.data.household.protected.length, 0);
  });

  it('records the waitlist channel', async () => {
    const { token } = login();
    const r = await call('/me/waitlist', { method: 'POST', token, body: { channel: 'line' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.household.waitlist.channel, 'line');
  });

  it('watcher link needs a LINE token and a phone code', async () => {
    const r = await call('/watchers/link', { method: 'POST', body: { phone: '0893331003', code: '123456' } });
    assert.equal(r.status, 401);
    assert.equal(r.data.error, 'id-token-required');
  });

  it('watcher code request needs a LINE token too (no anonymous SMS sends)', async () => {
    const r = await call('/watchers/request-otp', { method: 'POST', body: { phone: '0893331004' } });
    assert.equal(r.status, 401);
  });
});

describe('OTP safety (consent + takeover)', () => {
  it('refuses to send a protect code in production when SMS is mock (no devCode leak)', async () => {
    const { token } = login();
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const r = await call('/me/protected', { method: 'POST', token, body: { phone: '0893331005', label: 'mother' } });
      assert.equal(r.status, 503);
      assert.equal(r.data.error, 'sms-unavailable');
      assert.equal(r.data.devCode, undefined);
    } finally {
      if (saved === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved;
    }
  });

  it('a protect code cannot log in as that phone', async () => {
    const { token } = login();
    const a = await call('/me/protected', { method: 'POST', token, body: { phone: '0893331006', label: 'father' } });
    assert.equal(a.status, 200);
    assert.equal(verifyOtp('+66893331006', a.data.devCode, 'login').ok, false);
  });

  it("payer A's protect code fails payer B's verify (one pending payer per phone)", async () => {
    const a = login();
    const b = login();
    const phone = '0893331008';
    const ra = await call('/me/protected', { method: 'POST', token: a.token, body: { phone, label: 'mother' } });
    assert.equal(ra.status, 200);
    const rb = await call('/me/protected', { method: 'POST', token: b.token, body: { phone, label: 'mother' } });
    assert.equal(rb.status, 409);
    assert.equal(rb.data.error, 'pending-elsewhere');
    a.m.pendingProtected[0].requestedAt = new Date(Date.now() - 11 * 60000).toISOString(); // A's window lapsed
    const rb2 = await call('/me/protected', { method: 'POST', token: b.token, body: { phone, label: 'mother' } });
    assert.equal(rb2.status, 200);
    if (ra.data.devCode !== rb2.data.devCode) {
      const v = await call('/me/protected/verify', { method: 'POST', token: b.token, body: { phone, code: ra.data.devCode } });
      assert.equal(v.status, 400);
    }
    const ok = await call('/me/protected/verify', { method: 'POST', token: b.token, body: { phone, code: rb2.data.devCode } });
    assert.equal(ok.status, 200);
  });

  it('twilio-verify: a protect request while a login code is pending is refused', async () => {
    const saved = { sid: config.twilioVerifySid, acct: config.twilioAccountSid, tok: config.twilioAuthToken, fetch: globalThis.fetch };
    config.twilioVerifySid = 'VA' + '0'.repeat(32);
    config.twilioAccountSid = 'AC' + '0'.repeat(32);
    config.twilioAuthToken = 'x'.repeat(32);
    const realFetch = saved.fetch;
    globalThis.fetch = async (url, opts) => (String(url).includes('verify.twilio.com')
      ? new Response('{}', { status: 201 }) : realFetch(url, opts));
    try {
      const { token } = login();
      const phone = '+66893331009';
      const l = await sendOtp(phone, 'login', { ip: 'test' });
      assert.equal(l.ok, true);
      const r = await call('/me/protected', { method: 'POST', token, body: { phone, label: 'father' } });
      assert.equal(r.status, 429);
      assert.equal(r.data.error, 'otp-pending');
    } finally {
      config.twilioVerifySid = saved.sid; config.twilioAccountSid = saved.acct; config.twilioAuthToken = saved.tok;
      globalThis.fetch = saved.fetch;
    }
  });

  it('a login code cannot confirm a protected person', async () => {
    const { token } = login();
    const phone = '+66893331007';
    await call('/me/protected', { method: 'POST', token, body: { phone, label: 'child' } });
    requestOtp(phone, 'login'); // login-purpose code for the same phone
    const loginCode = peekOtpForMockSms(phone, 'login');
    const r = await call('/me/protected/verify', { method: 'POST', token, body: { phone, code: loginCode } });
    assert.equal(r.status, 400);
  });
});

describe('consent withdrawal (/withdraw.html)', () => {
  const flush = () => new Promise((r) => setTimeout(r, 20)); // the send happens after the reply
  async function protectedBy(token, phone, label = 'mother') {
    const a = await call('/me/protected', { method: 'POST', token, body: { phone, label } });
    await call('/me/protected/verify', { method: 'POST', token, body: { phone, code: a.data.devCode } });
  }

  it('the protected person withdraws with a code sent to their own phone', async () => {
    const { m, token } = login();
    await protectedBy(token, '0893332001');
    const r = await call('/withdraw/request-otp', { method: 'POST', body: { phone: '0893332001' } });
    assert.equal(r.status, 200);
    assert.match(r.data.devCode, /^\d{6}$/); // dev/mock only — production never returns it
    const bad = await call('/withdraw', { method: 'POST', body: { phone: '0893332001', code: '000000' } });
    assert.equal(bad.status, 400);
    const ok = await call('/withdraw', { method: 'POST', body: { phone: '0893332001', code: r.data.devCode } });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.withdrawn, true);
    assert.equal(m.protected.some((p) => p.phone === '+66893332001'), false);
  });

  it('a withdraw code cannot confirm a pending consent request (no social-engineered consent)', async () => {
    const { token } = login();
    const victim = '0893332003';
    await call('/me/protected', { method: 'POST', token, body: { phone: victim, label: 'mother' } }); // pending
    const w = await call('/withdraw/request-otp', { method: 'POST', body: { phone: victim } });
    const v = await call('/me/protected/verify', { method: 'POST', token, body: { phone: victim, code: w.data.devCode } });
    assert.equal(v.status, 400);
  });

  it('a consent code cannot withdraw', async () => {
    const { token } = login();
    const phone = '0893332004';
    const a = await call('/me/protected', { method: 'POST', token, body: { phone, label: 'father' } });
    const r = await call('/withdraw', { method: 'POST', body: { phone, code: a.data.devCode } });
    assert.equal(r.status, 400);
  });

  it('production: same reply for protected and unknown phones, sending happens after the reply', async () => {
    const { token } = login();
    await protectedBy(token, '0893332005');
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const a = await call('/withdraw/request-otp', { method: 'POST', body: { phone: '0893332005' } });
      const b = await call('/withdraw/request-otp', { method: 'POST', body: { phone: '0893332998' } });
      await flush();
      assert.deepEqual([a.status, a.data], [200, { ok: true }]);
      assert.deepEqual([b.status, b.data], [200, { ok: true }]);
    } finally {
      if (saved === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved;
    }
  });

  it('a wrong code gets byte-identical replies for protected and unknown phones (no enumeration)', async () => {
    const { token } = login();
    await protectedBy(token, '0893332006');
    await call('/withdraw/request-otp', { method: 'POST', body: { phone: '0893332006' } }); // a real code is pending
    const raw = async (phone) => {
      const res = await fetch(`${base}/withdraw`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, code: '000001' }),
      });
      return [res.status, await res.text()];
    };
    const known = await raw('0893332006');
    const unknown = await raw('0893332997');
    await protectedBy(token, '0893332007', 'father'); // protected, but no withdraw code requested
    const noCode = await raw('0893332007');
    assert.deepEqual(known, unknown);
    assert.deepEqual(noCode, unknown);
    assert.equal(known[0], 400);
    assert.deepEqual(JSON.parse(known[1]), { error: 'wrong-code' });
  });

  it('withdraw verify is captcha-gated when reCAPTCHA is configured', async () => {
    const saved = config.recaptchaApiKey;
    config.recaptchaApiKey = 'k'.repeat(20);
    try {
      const r = await call('/withdraw', { method: 'POST', body: { phone: '0893332006', code: '123456' } });
      assert.equal(r.status, 400);
      assert.notEqual(r.data.error, 'wrong-code');
    } finally { config.recaptchaApiKey = saved; }
  });

  it('rate-limits code requests per IP before the captcha check (no reCAPTCHA spend on floods)', async () => {
    resetLimits();
    const saved = config.recaptchaApiKey;
    try {
      for (let i = 0; i < 10; i += 1) {
        const ok = await call('/withdraw/request-otp', { method: 'POST', body: { phone: '0893332996' } });
        assert.equal(ok.status, 200);
      }
      config.recaptchaApiKey = 'k'.repeat(20); // a captcha check would answer 400 — the limit must answer first
      const over = await call('/withdraw/request-otp', { method: 'POST', body: { phone: '0893332996' } });
      assert.equal(over.status, 429);
    } finally {
      config.recaptchaApiKey = saved;
      resetLimits();
    }
  });

  it('texts nothing when nobody protects the phone', async () => {
    const r = await call('/withdraw/request-otp', { method: 'POST', body: { phone: '0893332999' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.devCode, undefined);
    assert.equal(peekOtpForMockSms('+66893332999', 'withdraw'), null);
  });

  it('is captcha-gated when reCAPTCHA is configured', async () => {
    const saved = config.recaptchaApiKey;
    config.recaptchaApiKey = 'k'.repeat(20);
    try {
      const r = await call('/withdraw/request-otp', { method: 'POST', body: { phone: '0893332001' } });
      assert.equal(r.status, 400); // no token
    } finally { config.recaptchaApiKey = saved; }
  });

  it('a withdraw code is useless for logging in', async () => {
    const { token } = login();
    await protectedBy(token, '0893332002', 'father');
    const r = await call('/withdraw/request-otp', { method: 'POST', body: { phone: '0893332002' } });
    assert.equal(verifyOtp('+66893332002', r.data.devCode, 'login').ok, false);
  });
});
