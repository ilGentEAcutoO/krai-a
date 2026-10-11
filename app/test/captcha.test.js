// Bot gates: sliding-window rate limiter + reCAPTCHA v3 server verify.
// Missing CAPTCHA token fails closed when configured (bots must solve);
// Google outage fails open (demo availability over strictness).
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { take, resetLimits } from '../src/ratelimit.js';
import { verifyCaptcha, captchaRequired } from '../src/recaptcha.js';

const savedKey = config.recaptchaApiKey;
const savedScore = config.recaptchaMinScore;
afterEach(() => { config.recaptchaApiKey = savedKey; config.recaptchaMinScore = savedScore; resetLimits(); });

describe('take()', () => {
  it('allows up to max, then denies with retryAfterSec', () => {
    assert.equal(take('k1', 2, 60000, 1000).ok, true);
    assert.equal(take('k1', 2, 60000, 2000).ok, true);
    const d = take('k1', 2, 60000, 3000);
    assert.equal(d.ok, false);
    assert.ok(d.retryAfterSec >= 58 && d.retryAfterSec <= 60);
  });

  it('slides the window (old hits expire)', () => {
    assert.equal(take('k2', 1, 60000, 1000).ok, true);
    assert.equal(take('k2', 1, 60000, 2000).ok, false);
    assert.equal(take('k2', 1, 60000, 61001).ok, true);
  });

  it('isolates keys', () => {
    assert.equal(take('a', 1, 60000, 1000).ok, true);
    assert.equal(take('b', 1, 60000, 1000).ok, true);
    assert.equal(take('a', 1, 60000, 1000).ok, false);
  });
});

describe('verifyCaptcha()', () => {
  const stub = (data, { ok = true, status = 200 } = {}) => async () => ({ ok, status, json: async () => data });
  const KEY = 'test-api-key-long-enough';
  const assess = (score, action = 'demo_call') => ({
    tokenProperties: { valid: true, action }, riskAnalysis: { score },
  });

  it('is disabled without an API key (dev default)', async () => {
    config.recaptchaApiKey = '';
    assert.equal(captchaRequired(), false);
    assert.deepEqual(await verifyCaptcha('', {}), { ok: true, skipped: true });
  });

  it('fails closed on missing token when configured', async () => {
    config.recaptchaApiKey = KEY;
    assert.equal(captchaRequired(), true);
    assert.deepEqual(await verifyCaptcha('', {}), { ok: false, error: 'captcha-required' });
  });

  it('accepts a high-score token for the right action', async () => {
    config.recaptchaApiKey = KEY;
    const v = await verifyCaptcha('tok', { action: 'demo_call', fetchImpl: stub(assess(0.9)) });
    assert.deepEqual(v, { ok: true, score: 0.9 });
  });

  it('rejects invalid token, low score, and wrong action', async () => {
    config.recaptchaApiKey = KEY;
    assert.equal((await verifyCaptcha('t', {
      fetchImpl: stub({ tokenProperties: { valid: false, invalidReason: 'MALFORMED' } }),
    })).error, 'captcha-failed');
    assert.equal((await verifyCaptcha('t', { fetchImpl: stub(assess(0.1)) })).error, 'captcha-score');
    assert.equal((await verifyCaptcha('t', {
      action: 'demo_call', fetchImpl: stub(assess(0.9, 'other')),
    })).error, 'captcha-action');
  });

  it('fails closed on 4xx, open on 5xx and network outage', async () => {
    config.recaptchaApiKey = KEY;
    assert.equal((await verifyCaptcha('t', { fetchImpl: stub({}, { ok: false, status: 400 }) })).error, 'captcha-failed');
    assert.deepEqual(await verifyCaptcha('t', { fetchImpl: stub({}, { ok: false, status: 503 }) }), { ok: true, failed: true });
    assert.deepEqual(await verifyCaptcha('t', { fetchImpl: async () => { throw new Error('down'); } }), { ok: true, failed: true });
  });
});
