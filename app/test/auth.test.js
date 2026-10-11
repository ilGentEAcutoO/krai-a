// Auth + member self-service tests: OTP lifecycle, sessions, whitelist,
// watchers, forwarding flag. Module-level (no HTTP).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePhone, requestOtp, verifyOtp, peekOtpForMockSms,
  createSession, getSession, destroySession,
} from '../src/auth.js';
import { checkOtpLive, smsMode } from '../src/sms.js';
import { config } from '../src/config.js';
import {
  addMember, getMemberById, getMemberByOwner, addWhitelist, removeWhitelist,
  addWatcher, removeWatcher, setForwardingConfirmed,
} from '../src/store.js';
import { assignNumber } from '../src/numbers.js';

describe('phone normalization', () => {
  it('converts 08x to +66', () => assert.equal(normalizePhone('081-234-5678'), '+66812345678'));
  it('keeps +66 as-is', () => assert.equal(normalizePhone('+66812345678'), '+66812345678'));
  it('rejects garbage', () => assert.equal(normalizePhone('123'), null));
});

describe('otp lifecycle', () => {
  it('issues and verifies a code once', () => {
    assert.ok(requestOtp('+66810000111').ok);
    const code = peekOtpForMockSms('+66810000111');
    assert.match(code, /^\d{6}$/);
    assert.ok(verifyOtp('+66810000111', code).ok);
    assert.equal(verifyOtp('+66810000111', code).ok, false); // single use
  });
  it('rejects wrong codes with attempts left', () => {
    requestOtp('+66810000222');
    const r = verifyOtp('+66810000222', '000000');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'wrong-code');
    assert.ok(r.attemptsLeft >= 0);
  });
  it('rate-limits requests per phone', () => {
    for (let i = 0; i < 5; i++) requestOtp('+66810000333');
    assert.equal(requestOtp('+66810000333').ok, false);
  });
});

describe('sessions', () => {
  it('creates, reads, destroys', () => {
    const t = createSession('m_x');
    assert.equal(getSession(t).memberId, 'm_x');
    destroySession(t);
    assert.equal(getSession(t), null);
  });
  it('rejects unknown tokens', () => assert.equal(getSession('nope'), null));
});

describe('member self-service', () => {
  it('assigns numbers from pool and manages profile', async () => {
    const n1 = await assignNumber();
    assert.ok(n1.ok);
    const m = addMember({ ownerPhone: '+66810000444', aiNumber: n1.number });
    assert.equal(getMemberByOwner('+66810000444').id, m.id);
    assert.equal(getMemberById(m.id).aiNumber, n1.number);
    assert.equal(m.forwardingConfirmed, false);
    setForwardingConfirmed(m.id, true);
    assert.equal(getMemberById(m.id).forwardingConfirmed, true);
    addWhitelist(m.id, { phone: '+66810000445', label: 'mom', safeWord: 'mango' });
    addWhitelist(m.id, { phone: '+66810000445', label: 'dup', safeWord: '' });
    assert.equal(getMemberById(m.id).whitelisted.length, 1); // deduped
    removeWhitelist(m.id, '+66810000445');
    assert.equal(getMemberById(m.id).whitelisted.length, 0);
    addWatcher(m.id, '+66810000446');
    assert.deepEqual(getMemberById(m.id).familyWatchers, ['+66810000446']);
    removeWatcher(m.id, '+66810000446');
    assert.deepEqual(getMemberById(m.id).familyWatchers, []);
  });
});

describe('twilio verify live check', () => {
  const saved = {
    sid: config.twilioVerifySid,
    ac: config.twilioAccountSid,
    token: config.twilioAuthToken,
    thsms: config.thsmsApiKey,
  };
  const realFetch = global.fetch;
  const useLive = () => {
    config.twilioVerifySid = 'VA00000000' + '000000000000000000000000';
    config.twilioAccountSid = 'AC00000000' + '000000000000000000000000';
    config.twilioAuthToken = 'test-token';
    config.thsmsApiKey = ''; // isolate: thsms outranks twilio in smsMode()
  };
  const restore = () => {
    config.twilioVerifySid = saved.sid;
    config.twilioAccountSid = saved.ac;
    config.twilioAuthToken = saved.token;
    config.thsmsApiKey = saved.thsms;
    global.fetch = realFetch;
  };

  it('approves via VerificationCheck API', async () => {
    useLive();
    let url = '';
    global.fetch = async (u) => { url = u; return { ok: true, json: async () => ({ status: 'approved' }) }; };
    try {
      assert.equal(smsMode(), 'twilio-verify');
      assert.ok((await checkOtpLive('+66810000999', '123456')).ok);
      assert.match(url, /VerificationCheck/);
    } finally { restore(); }
  });

  it('denied or failed checks fail closed', async () => {
    useLive();
    global.fetch = async () => ({ ok: true, json: async () => ({ status: 'pending' }) });
    try {
      assert.equal((await checkOtpLive('+66810000999', '000000')).error, 'wrong-code');
    } finally { restore(); }
    useLive();
    global.fetch = async () => { throw new Error('down'); };
    try {
      assert.equal((await checkOtpLive('+66810000999', '123456')).error, 'verify-unavailable');
    } finally { restore(); }
  });
});
