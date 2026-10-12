// Purpose-scoped OTP: a code texted for one flow (protect a parent's phone,
// link a watcher, add a seat) can never log anyone in, and vice versa. One
// shared sender (sendOtp) owns every SMS-cost guard: per-phone, per-IP and
// global caps, and no browser-visible code in production.
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { config } from '../src/config.js';
import {
  requestOtp, verifyOtp, peekOtpForMockSms, sendOtp, checkOtp, OTP_PURPOSES,
} from '../src/auth.js';
import { addMember } from '../src/store.js';
import { resetLimits } from '../src/ratelimit.js';
import { demoRouter } from '../src/routes.js';

// Local codes (mock SMS) unless a test opts into Twilio Verify.
config.thsmsApiKey = '';
config.twilioVerifySid = '';
config.recaptchaApiKey = '';
const saved = { env: process.env.NODE_ENV, sid: config.twilioAccountSid, token: config.twilioAuthToken };
const realFetch = global.fetch;
afterEach(() => {
  resetLimits();
  process.env.NODE_ENV = saved.env;
  config.twilioVerifySid = '';
  config.twilioAccountSid = saved.sid;
  config.twilioAuthToken = saved.token;
  global.fetch = realFetch;
});

let n = 0;
const phone = () => { n += 1; return `+668100088${String(n).padStart(2, '0')}`; };

describe('purpose scoping', () => {
  it('a code is only valid for the purpose it was sent for', () => {
    const p = phone();
    requestOtp(p, 'protect');
    const code = peekOtpForMockSms(p, 'protect');
    assert.equal(verifyOtp(p, code).ok, false, 'protect code cannot log in');
    assert.equal(verifyOtp(p, code, 'watcher').ok, false);
    assert.equal(verifyOtp(p, code, 'protect').ok, true);
  });

  it('a login code cannot confirm consent flows', () => {
    const p = phone();
    requestOtp(p);
    const code = peekOtpForMockSms(p);
    assert.equal(verifyOtp(p, code, 'protect').ok, false);
    assert.equal(verifyOtp(p, code, 'seat').ok, false);
    assert.equal(verifyOtp(p, code).ok, true, 'default purpose is login');
  });

  it('purposes are a closed set', () => {
    assert.deepEqual([...OTP_PURPOSES].sort(), ['login', 'protect', 'seat', 'watcher', 'withdraw']);
    assert.throws(() => requestOtp(phone(), 'admin'));
    assert.throws(() => verifyOtp(phone(), '123456', 'admin'));
  });

  it('the per-phone SMS cap is shared across purposes', () => {
    const p = phone();
    for (const purpose of ['login', 'protect', 'watcher', 'seat', 'login']) assert.ok(requestOtp(p, purpose).ok);
    assert.equal(requestOtp(p, 'protect').ok, false);
  });
});

describe('sendOtp() — the one shared sender', () => {
  it('returns the dev code locally and checkOtp honours the purpose', async () => {
    const p = phone();
    const sent = await sendOtp(p, 'watcher', { ip: '10.0.0.1' });
    assert.equal(sent.ok, true);
    assert.equal(sent.mode, 'mock');
    assert.match(sent.devCode, /^\d{6}$/);
    assert.equal((await checkOtp(p, sent.devCode, 'login')).ok, false);
    assert.equal((await checkOtp(p, sent.devCode, 'watcher')).ok, true);
  });

  it('refuses mock SMS in production (no code in the browser)', async () => {
    process.env.NODE_ENV = 'production';
    const r = await sendOtp(phone(), 'protect', { ip: '10.0.0.2' });
    assert.deepEqual(r, { ok: false, status: 503, error: 'sms-unavailable' });
  });

  it('caps sends per IP (SMS pumping across many numbers)', async () => {
    let last;
    for (let i = 0; i < 11; i += 1) last = await sendOtp(phone(), 'login', { ip: '10.0.0.3' });
    assert.equal(last.ok, false);
    assert.equal(last.status, 429);
    assert.equal((await sendOtp(phone(), 'login', { ip: '10.0.0.4' })).ok, true, 'other IPs unaffected');
  });

  it('Twilio Verify: one pending purpose per phone, checked before Twilio', async () => {
    config.twilioVerifySid = 'VAtest';
    config.twilioAccountSid = 'ACtest';
    config.twilioAuthToken = 'token';
    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      return String(url).includes('VerificationCheck')
        ? { ok: true, json: async () => ({ status: 'approved' }) }
        : { ok: true, json: async () => ({}) };
    };
    const p = phone();
    assert.equal((await sendOtp(p, 'protect', { ip: '10.0.0.5' })).ok, true);
    // Twilio would resend the SAME pending code: a login request must not start.
    const login = await sendOtp(p, 'login', { ip: '10.0.0.5' });
    assert.equal(login.ok, false);
    assert.equal(login.error, 'otp-pending');
    const before = calls.length;
    assert.equal((await checkOtp(p, '123456', 'login')).ok, false);
    assert.equal(calls.length, before, 'wrong purpose never reaches Twilio');
    assert.equal((await checkOtp(p, '123456', 'protect')).ok, true);
  });
});

describe('routes use the scoped helpers', () => {
  let server; let base;
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', demoRouter(() => {}));
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { await new Promise((resolve) => server.close(resolve)); });
  const post = async (p, body) => {
    const r = await realFetch(`${base}${p}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  it('a consent code (protect) cannot log in through /auth/verify-otp', async () => {
    const p = phone();
    addMember({ ownerPhone: p, aiNumber: '+66210008899' });
    requestOtp(p, 'protect');
    const code = peekOtpForMockSms(p, 'protect');
    const r = await post('/api/auth/verify-otp', { phone: p, code });
    assert.equal(r.status, 400);
    assert.equal(r.body.token, undefined);
  });

  it('login still works end to end', async () => {
    const p = phone();
    const sent = await post('/api/auth/request-otp', { phone: p });
    assert.equal(sent.status, 200);
    const r = await post('/api/auth/verify-otp', { phone: p, code: sent.body.devCode });
    assert.equal(r.status, 200);
    assert.ok(r.body.token);
  });
});

describe('purpose-specific SMS text', () => {
  it('a server-built message(code) replaces the default OTP text; strings are ignored', async () => {
    config.thsmsApiKey = 'thsms-test-key';
    const bodies = [];
    global.fetch = async (url, opts) => {
      if (String(url).startsWith('https://thsms.com')) bodies.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({}) };
    };
    try {
      const p1 = phone();
      assert.equal((await sendOtp(p1, 'protect', { ip: '10.0.1.1', message: (code) => `consent ${code} - not a login code` })).ok, true);
      assert.match(bodies[0].message, /^consent \d{6} - not a login code$/);
      assert.equal(bodies[0].message.includes(peekOtpForMockSms(p1, 'protect')), true);
      const p2 = phone();
      await sendOtp(p2, 'watcher', { ip: '10.0.1.1', message: 'attacker text' });
      assert.match(bodies[1].message, /OTP/, 'non-function message falls back to the default text');
      const p3 = phone();
      await sendOtp(p3, 'login', { ip: '10.0.1.1' });
      assert.match(bodies[2].message, /OTP/);
    } finally {
      config.thsmsApiKey = '';
    }
  });
});

describe("'withdraw' is its own purpose", () => {
  it('a withdraw code can never grant consent (protect) and vice versa', () => {
    const p = phone();
    requestOtp(p, 'withdraw');
    const w = peekOtpForMockSms(p, 'withdraw');
    assert.equal(verifyOtp(p, w, 'protect').ok, false, 'withdraw code cannot confirm protection');
    assert.equal(verifyOtp(p, w, 'withdraw').ok, true);
    requestOtp(p, 'protect');
    const c = peekOtpForMockSms(p, 'protect');
    assert.equal(verifyOtp(p, c, 'withdraw').ok, false, 'consent code cannot withdraw');
  });

  it('Twilio Verify: a withdraw request while protect is pending is refused', async () => {
    config.twilioVerifySid = 'VAtest';
    config.twilioAccountSid = 'ACtest';
    config.twilioAuthToken = 'token';
    global.fetch = async () => ({ ok: true, json: async () => ({}) });
    const p = phone();
    assert.equal((await sendOtp(p, 'protect', { ip: '10.0.2.1' })).ok, true);
    const w = await sendOtp(p, 'withdraw', { ip: '10.0.2.1' });
    assert.equal(w.ok, false);
    assert.equal(w.error, 'otp-pending');
  });
});
