// THSMS OTP adapter: mode priority, V2 request shape, sender handling,
// error paths, and the zero-cost account check. All network mocked.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import {
  smsMode, sendOtpSms, toLocalMsisdn, otpMessage, thsmsAccount,
} from '../src/sms.js';

const saved = { key: config.thsmsApiKey, sender: config.thsmsSender, sid: config.twilioVerifySid };
afterEach(() => {
  config.thsmsApiKey = saved.key;
  config.thsmsSender = saved.sender;
  config.twilioVerifySid = saved.sid;
});

describe('smsMode priority', () => {
  it('prefers thsms, then twilio-verify, then mock', () => {
    config.thsmsApiKey = '';
    config.twilioVerifySid = '';
    assert.equal(smsMode(), 'mock');
    config.twilioVerifySid = 'VA_fake';
    assert.equal(smsMode(), 'twilio-verify');
    config.thsmsApiKey = 'fake-token';
    assert.equal(smsMode(), 'thsms');
  });
});

describe('thsms payload', () => {
  it('converts E.164 to local msisdn and keeps the message to one segment', () => {
    assert.equal(toLocalMsisdn('+66812345678'), '0812345678');
    assert.equal(toLocalMsisdn('0812345678'), '0812345678');
    assert.equal(toLocalMsisdn('+12025550134'), '12025550134');
    const msg = otpMessage('123456');
    assert.match(msg, /123456/);
    assert.ok([...msg].length <= 70);
  });

  it('posts the V2 shape with Bearer auth and never leaks devCode', async () => {
    config.thsmsApiKey = 'tok_test_1';
    config.thsmsSender = '';
    let seen = null;
    const fetchImpl = async (url, opts) => {
      seen = { url, opts, body: JSON.parse(opts.body) };
      return { ok: true, json: async () => ({}) };
    };
    const r = await sendOtpSms('+66812345678', '123456', { fetchImpl });
    assert.deepEqual(r, { ok: true, mode: 'thsms' });
    assert.equal(seen.url, 'https://thsms.com/api/send-sms');
    assert.equal(seen.opts.method, 'POST');
    assert.equal(seen.opts.headers.Authorization, 'Bearer tok_test_1');
    assert.deepEqual(seen.body.msisdn, ['0812345678']);
    assert.match(seen.body.message, /123456/);
    assert.equal('sender' in seen.body, false);
  });

  it('includes sender only when configured', async () => {
    config.thsmsApiKey = 'tok_test_2';
    config.thsmsSender = 'NOTICE';
    let body = null;
    const fetchImpl = async (url, opts) => {
      body = JSON.parse(opts.body);
      return { ok: true, json: async () => ({}) };
    };
    await sendOtpSms('+66812345678', '1', { fetchImpl });
    assert.equal(body.sender, 'NOTICE');
  });

  it('maps API and transport failures to sms-failed details', async () => {
    config.thsmsApiKey = 'tok_test_3';
    const bad = await sendOtpSms('+66812345678', '1', {
      fetchImpl: async () => ({ ok: false, status: 401 }),
    });
    assert.deepEqual(bad, { ok: false, mode: 'thsms', detail: 'http-401' });
    const down = await sendOtpSms('+66812345678', '1', {
      fetchImpl: async () => { throw new Error('dns'); },
    });
    assert.deepEqual(down, { ok: false, mode: 'thsms', detail: 'transport-error' });
  });

  it('falls back to mock with devCode when nothing is configured', async () => {
    config.thsmsApiKey = '';
    config.twilioVerifySid = '';
    const r = await sendOtpSms('+66812345678', '654321', { fetchImpl: async () => { throw new Error('must not call network'); } });
    assert.equal(r.mode, 'mock');
    assert.equal(r.devCode, '654321');
  });
});

describe('thsmsAccount', () => {
  it('checks the key without spending credit', async () => {
    let seen = null;
    const fetchImpl = async (url, opts) => {
      seen = { url, opts };
      return { ok: true, json: async () => ({ credit: 100 }) };
    };
    const r = await thsmsAccount({ fetchImpl, apiKey: 'tok_test_4' });
    assert.equal(r.ok, true);
    assert.equal(r.data.credit, 100);
    assert.equal(seen.url, 'https://thsms.com/api/me');
    assert.equal(seen.opts.headers.Authorization, 'Bearer tok_test_4');
  });

  it('reports unconfigured, http, and transport failures without throwing', async () => {
    assert.deepEqual(
      await thsmsAccount({ fetchImpl: async () => ({}), apiKey: '' }),
      { ok: false, detail: 'thsms-unconfigured' },
    );
    assert.deepEqual(
      await thsmsAccount({ fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }), apiKey: 'x' }),
      { ok: false, detail: 'http-401' },
    );
    assert.deepEqual(
      await thsmsAccount({ fetchImpl: async () => { throw new Error('dns'); }, apiKey: 'x' }),
      { ok: false, detail: 'transport-error' },
    );
  });
});
