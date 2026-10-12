// reCAPTCHA gate (TASK-005): captcha guards ONLY the endpoints that spend AI
// live (demo call start, /api/analyze, live session via captchaGate). A low
// score must not hard-lock a judge: one low-trust pass per IP per hour, then
// a friendly error the UI can show (with the static scenario demo fallback).
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { config } from '../src/config.js';
import { addMember } from '../src/store.js';
import { resetLimits } from '../src/ratelimit.js';
import { demoRouter } from '../src/routes.js';
import { captchaGate } from '../src/recaptcha.js';

config.geminiApiKey = '';
config.demoNumber = '';
addMember({ ownerPhone: config.seedMemberPhone, aiNumber: '+66210009301', plan: 'family-149', counted: false });

const KEY = 'test-api-key-long-enough';
const savedKey = config.recaptchaApiKey;
const realFetch = global.fetch;
let server; let base;
let googleCalls = 0;

before(async () => {
  const app = express();
  app.use(express.json());
  app.post('/live/session', captchaGate({ action: 'live_session', scope: 'live' }), (req, res) => res.json({ ok: true, lowTrust: !!req.captcha?.lowTrust }));
  app.use('/api', demoRouter(() => {}));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  config.recaptchaApiKey = savedKey;
  await new Promise((resolve) => server.close(resolve));
});
afterEach(() => { resetLimits(); global.fetch = realFetch; googleCalls = 0; });

// Google assessment stub: token "good" scores 0.9, "low" 0.1, "bad" invalid.
function stubGoogle() {
  config.recaptchaApiKey = KEY;
  global.fetch = async (url, opts) => {
    if (!String(url).startsWith('https://recaptchaenterprise.googleapis.com')) return realFetch(url, opts);
    googleCalls += 1;
    const { event } = JSON.parse(opts.body);
    const valid = event.token !== 'bad';
    const score = event.token === 'low' ? 0.1 : 0.9;
    return {
      ok: true, status: 200,
      json: async () => ({ tokenProperties: { valid, action: event.expectedAction }, riskAnalysis: { score } }),
    };
  };
}

const post = async (p, body, headers = {}) => {
  const r = await realFetch(`${base}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const get = async (p) => {
  const r = await realFetch(`${base}${p}`, { signal: AbortSignal.timeout(5000) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const assertFriendly = (body, error) => {
  assert.equal(body.error, error);
  assert.ok(body.friendly?.th?.length > 5, 'Thai message');
  assert.ok(body.friendly?.en?.length > 5, 'English message');
  assert.equal(body.fallback, 'scenarios');
};

describe('captcha gates live endpoints only', () => {
  it('demo call start: missing token → 400 friendly, good token → 200', async () => {
    stubGoogle();
    const miss = await post('/api/demo/call', {});
    assert.equal(miss.status, 400);
    assertFriendly(miss.body, 'captcha-required');
    const ok = await post('/api/demo/call', { recaptchaToken: 'good' });
    assert.equal(ok.status, 200);
  });

  it('/api/analyze now requires captcha too', async () => {
    stubGoogle();
    const miss = await post('/api/analyze', { text: 'โอนเงินด่วน' });
    assert.equal(miss.status, 400);
    assertFriendly(miss.body, 'captcha-required');
    const ok = await post('/api/analyze', { text: 'โอนเงินด่วน', recaptchaToken: 'good' });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.verdict.verdict);
  });

  it('invalid token → 403 friendly (fails closed)', async () => {
    stubGoogle();
    const r = await post('/api/demo/call', { recaptchaToken: 'bad' });
    assert.equal(r.status, 403);
    assertFriendly(r.body, 'captcha-failed');
  });

  it('mid-call turn/end never need a token (no hard-lock during a call)', async () => {
    stubGoogle();
    const s = await post('/api/demo/call', { recaptchaToken: 'good' });
    const calls = googleCalls;
    const t = await post('/api/demo/turn', { callId: s.body.call.id, text: 'สวัสดีค่ะ' });
    assert.equal(t.status, 200);
    const e = await post('/api/demo/end', { callId: s.body.call.id });
    assert.equal(e.status, 200);
    assert.equal(googleCalls, calls, 'no extra Google assessments');
  });

  it('read-only endpoints never touch captcha', async () => {
    stubGoogle();
    for (const p of ['/api/status', '/api/stats', '/api/demo/scripts', '/api/calls', '/api/plans']) {
      assert.equal((await get(p)).status, 200, p);
    }
    assert.equal(googleCalls, 0);
  });
});

describe('a low score never hard-locks a judge', () => {
  it('first low-score start per IP passes as low-trust, the next gets a friendly 403', async () => {
    stubGoogle();
    const first = await post('/api/demo/call', { recaptchaToken: 'low' });
    assert.equal(first.status, 200);
    const second = await post('/api/demo/call', { recaptchaToken: 'low' });
    assert.equal(second.status, 403);
    assertFriendly(second.body, 'captcha-score');
    assert.equal(second.body.retryable, true);
  });

  it('captchaGate is reusable by the live session route (shared low-trust policy)', async () => {
    stubGoogle();
    assert.deepEqual((await post('/live/session', { captchaToken: 'good' })).body, { ok: true, lowTrust: false });
    assert.deepEqual((await post('/live/session', { captchaToken: 'low' })).body, { ok: true, lowTrust: true });
    const again = await post('/live/session', { captchaToken: 'low' });
    assert.equal(again.status, 403);
    assertFriendly(again.body, 'captcha-score');
  });

  it('gate is a no-op when captcha is not configured (dev)', async () => {
    config.recaptchaApiKey = '';
    assert.equal((await post('/live/session', {})).status, 200);
    assert.equal((await post('/api/demo/call', {})).status, 200);
  });
});

describe('reCAPTCHA API key handling', () => {
  it('sends the key in the x-goog-api-key header, never in the URL', async () => {
    const { verifyCaptcha } = await import('../src/recaptcha.js');
    config.recaptchaApiKey = KEY;
    let seen;
    await verifyCaptcha('tok', {
      action: 'demo_call',
      fetchImpl: async (url, opts) => {
        seen = { url: String(url), headers: opts.headers };
        return { ok: true, status: 200, json: async () => ({ tokenProperties: { valid: true, action: 'demo_call' }, riskAnalysis: { score: 0.9 } }) };
      },
    });
    assert.ok(!seen.url.includes(KEY), 'key not in URL (URLs end up in logs)');
    assert.doesNotMatch(seen.url, /[?&]key=/);
    assert.equal(seen.headers['x-goog-api-key'], KEY);
  });
});
