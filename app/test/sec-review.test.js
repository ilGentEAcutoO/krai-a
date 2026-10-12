// sec-review (TASK-016) findings in sec-demo files: abandoned Twilio calls,
// seat periods, persisted Stripe idempotency, auto-topup single-flight,
// security headers, erasure + auto-purge, and the LOW fixes.
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { config } from '../src/config.js';
import {
  addMember, getMemberById, getMemberByOwner, findMember, createCall, getCall, getCallBySid, addTurn,
  endCall, purgeCalls, seatCap, quotaTotal, ADDON_SEAT, serializeStore, restoreStore,
  setReputation, getReputation, callsByMember, setAutoTopup, consumeMinutes, cancelMember, planOf,
} from '../src/store.js';
import {
  fulfillCheckoutSession, maybeAutoTopup, latestSavedCard, __resetFulfilled,
} from '../src/billing.js';
import { billingRouter } from '../src/billingRoutes.js';
import {
  createSession, getSession, serializeAuth, restoreAuth, sendOtp, requestOtp,
} from '../src/auth.js';
import { take, resetLimits } from '../src/ratelimit.js';
import { demoRouter } from '../src/routes.js';
import { securityHeaders } from '../src/securityHeaders.js';
import { buildMessage } from '../src/notify/index.js';
import { sendOtpSms } from '../src/sms.js';
import { purgeInactiveMembers, ERASE_AFTER_DAYS } from '../src/jobs.js';

const DAY = 86400000;
const HOUR = 3600000;
config.thsmsApiKey = '';
config.twilioVerifySid = '';
config.recaptchaApiKey = '';
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; resetLimits(); });

let n = 0;
const member = (extra = {}) => {
  n += 1;
  return addMember({ ownerPhone: `+668100044${String(n).padStart(2, '0')}`, aiNumber: `+662100044${String(n).padStart(2, '0')}`, ...extra });
};

let server; let base;
before(async () => {
  const app = express();
  app.use(securityHeaders());
  app.use(express.json());
  app.use('/api', demoRouter(() => {}));
  app.use('/api/billing', billingRouter());
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); });
const http = async (method, p, body, token) => {
  const r = await realFetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) };
};

describe('HIGH: abandoned Twilio calls', () => {
  it('calls carry the Twilio CallSid and can be found by it', () => {
    const m = member();
    const c = createCall({ memberId: m.id, callerPhone: '+66811110001', aiNumber: m.aiNumber, source: 'twilio', callSid: 'CA_abc123' });
    assert.equal(getCallBySid('CA_abc123').id, c.id);
    assert.equal(getCallBySid('CA_nope'), null);
    assert.equal(getCallBySid(''), null);
  });

  it('never-ended calls older than 24 h are purged; recent open calls are kept', () => {
    const m = member();
    const stale = createCall({ memberId: m.id, callerPhone: '+66811110002', aiNumber: m.aiNumber, source: 'twilio' });
    addTurn(stale.id, 'caller', 'abandoned transcript');
    stale.startedAt = new Date(Date.now() - 25 * HOUR).toISOString();
    const live = createCall({ memberId: m.id, callerPhone: '+66811110003', aiNumber: m.aiNumber, source: 'twilio' });
    purgeCalls();
    assert.equal(getCall(stale.id), null);
    assert.ok(getCall(live.id));
  });
});

describe('MED: seats are paid periods, not forever', () => {
  it('a seat adds quota for 30 days, then stops counting', () => {
    __resetFulfilled();
    const m = member({ plan: 'family-199' });
    const base = { cap: seatCap(m), quota: quotaTotal(m) };
    const r = fulfillCheckoutSession({ id: 'cs_seat_sr1', payment_status: 'paid', metadata: { memberId: m.id, kind: 'seat' } });
    assert.equal(r.granted, true);
    assert.equal(seatCap(m), base.cap + 1);
    assert.equal(quotaTotal(m), base.quota + ADDON_SEAT.quota);
    assert.ok(Math.abs(Date.parse(m.seats[0].paidUntil) - (Date.now() + 30 * DAY)) < 60000);
    m.seats[0].paidUntil = new Date(Date.now() - 1000).toISOString(); // a month later
    assert.equal(seatCap(m), base.cap);
    assert.equal(quotaTotal(m), base.quota);
  });

  it('legacy permanent seatsPaid migrates to a 30-day seat on restore', () => {
    const m = member({ plan: 'family-199' });
    m.seatsPaid = 2;
    restoreStore(JSON.parse(JSON.stringify(serializeStore())));
    const back = getMemberById(m.id);
    assert.equal(back.seatsPaid, undefined);
    assert.equal(back.seats.length, 2);
    assert.equal(seatCap(back), Math.min(5, planOf(back).numbers + 2));
  });
});

describe('MED: Stripe idempotency survives a restart', () => {
  it('a redelivered session after restore grants nothing', () => {
    __resetFulfilled();
    const m = member();
    const s = { id: 'cs_restart_1', payment_status: 'paid', metadata: { memberId: m.id, kind: 'topup', pack: 'topup-small' } };
    assert.equal(fulfillCheckoutSession(s).granted, true);
    const snap = JSON.parse(JSON.stringify(serializeStore()));
    restoreStore({});
    restoreStore(snap);
    const again = fulfillCheckoutSession(s);
    assert.equal(again.granted, false);
    assert.equal(again.reason, 'duplicate');
  });

  it('the persisted id list is bounded', () => {
    __resetFulfilled();
    const m = member();
    for (let i = 0; i < 5100; i += 1) fulfillCheckoutSession({ id: `cs_bound_${i}`, payment_status: 'paid', metadata: { memberId: m.id, kind: 'topup', pack: 'topup-small' } });
    assert.ok(serializeStore().fulfilled.length <= 5000);
  });
});

describe('MED: auto-topup is single-flight and idempotent', () => {
  function cardMember() {
    const m = member({ plan: 'solo-99' });
    m.payMethod = 'card';
    m.stripeCustomerId = `cus_sr_${n}`;
    setAutoTopup(m, { enabled: true, threshold: 30, pack: 'topup-small' });
    consumeMinutes(m, 55); // 5 of 60 left: auto-topup due
    return m;
  }
  function stripe({ status = 'succeeded', delayMs = 20 } = {}) {
    const intents = [];
    const fetchImpl = async (url, opts) => {
      if (String(url).includes('/payment_methods')) return { ok: true, json: async () => ({ data: [{ id: 'pm_1' }] }) };
      intents.push({ key: opts.headers['Idempotency-Key'] });
      await new Promise((r) => setTimeout(r, delayMs));
      return { ok: true, json: async () => ({ id: `pi_${intents.length}`, status, customer: 'cus' }) };
    };
    return { intents, fetchImpl };
  }

  it('a double click creates one charge, with an Idempotency-Key', async () => {
    const m = cardMember();
    const s = stripe();
    const opts = { fetchImpl: s.fetchImpl, secretKey: 'sk_test_fake_key_123' };
    const [a, b] = await Promise.all([maybeAutoTopup(m, opts), maybeAutoTopup(m, opts)]);
    assert.equal(s.intents.length, 1);
    assert.match(s.intents[0].key, new RegExp(`^auto-${m.id}-`));
    assert.equal([a, b].filter((r) => r.reason === 'charge-in-flight').length, 1);
  });

  it('a pending (processing) PaymentIntent blocks another charge', async () => {
    const m = cardMember();
    const s = stripe({ status: 'processing', delayMs: 0 });
    const opts = { fetchImpl: s.fetchImpl, secretKey: 'sk_test_fake_key_123' };
    await maybeAutoTopup(m, opts);
    const second = await maybeAutoTopup(m, opts);
    assert.equal(second.reason, 'charge-pending');
    assert.equal(s.intents.length, 1);
  });

  it('charges are capped per member per day', async () => {
    const m = cardMember();
    const s = stripe({ status: 'requires_payment_method', delayMs: 0 });
    const opts = { fetchImpl: s.fetchImpl, secretKey: 'sk_test_fake_key_123' };
    const results = [];
    for (let i = 0; i < 6; i += 1) results.push(await maybeAutoTopup(m, opts));
    assert.ok(s.intents.length <= 3, `at most 3 attempts/day, got ${s.intents.length}`);
    assert.equal(results.at(-1).reason, 'daily-cap');
  });

  it('Stripe transport errors never throw', async () => {
    const boom = async () => { throw new Error('ECONNRESET'); };
    assert.equal((await latestSavedCard('cus_x', { fetchImpl: boom, secretKey: 'sk_test_fake_key_123' })).ok, false);
    const m = cardMember();
    const r = await maybeAutoTopup(m, { fetchImpl: boom, secretKey: 'sk_test_fake_key_123' });
    assert.equal(r.charged, false);
  });
});

describe('MED: security headers', () => {
  it('sets HSTS, a framing/object CSP and a permissions policy', async () => {
    const r = await http('GET', '/api/plans');
    assert.match(r.headers.get('strict-transport-security'), /max-age=31536000; includeSubDomains/);
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'self'/);
    assert.match(r.headers.get('permissions-policy'), /microphone=\(self\)/);
    assert.match(r.headers.get('permissions-policy'), /camera=\(\)/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });
});

describe('MED: erasure', () => {
  it('DELETE /api/me needs confirm, then erases member, calls, reputation, sessions and indexes', async () => {
    const m = member();
    const token = createSession(m.id);
    const c = createCall({ memberId: m.id, callerPhone: '+66811110009', aiNumber: m.aiNumber, source: 'twilio' });
    endCall(c.id);
    setReputation(m.id, '+66811110009', { verdict: 'SCAM', confidence: 0.95 }, 60);
    assert.equal((await http('DELETE', '/api/me', {}, token)).status, 400);
    const r = await http('DELETE', '/api/me', { confirm: true }, token);
    assert.equal(r.status, 200);
    assert.equal(getMemberById(m.id), null);
    assert.equal(getMemberByOwner(m.ownerPhone), null);
    assert.equal(findMember({ to: m.aiNumber, mode: 'A' }).member, null);
    assert.equal(getCall(c.id), null);
    assert.deepEqual(callsByMember(m.id), []);
    assert.equal(getReputation(m.id, '+66811110009'), null);
    assert.equal(getSession(token), null);
    assert.equal((await http('GET', '/api/me', undefined, token)).status, 401);
  });

  it(`auto-purges households cancelled or lapsed for ${ERASE_AFTER_DAYS}+ days; never the seed or live ones`, async () => {
    const now = Date.now();
    const cancelled = member();
    cancelMember(cancelled.id);
    cancelled.cancelledAt = new Date(now - (ERASE_AFTER_DAYS + 1) * DAY).toISOString();
    const lapsed = member();
    lapsed.lifecycleV = 1;
    lapsed.trialEndsAt = new Date(now - (ERASE_AFTER_DAYS + 10) * DAY).toISOString();
    lapsed.lifecycleSent = { cycle: lapsed.trialEndsAt, 't-0': lapsed.trialEndsAt };
    const recent = member();
    cancelMember(recent.id);
    const alive = member();
    alive.lifecycleV = 1;
    const seed = getMemberByOwner(config.seedMemberPhone) || addMember({ ownerPhone: config.seedMemberPhone, aiNumber: '+66210004499', counted: false });
    seed.active = false;
    seed.cancelledAt = new Date(now - 1000 * DAY).toISOString();
    const erased = await purgeInactiveMembers(now, { sendLine: async () => ({ ok: true }), sendSms: async () => ({ ok: true }) });
    assert.ok(erased >= 2);
    assert.equal(getMemberById(cancelled.id), null);
    assert.equal(getMemberById(lapsed.id), null);
    assert.ok(getMemberById(recent.id));
    assert.ok(getMemberById(alive.id));
    assert.ok(getMemberById(seed.id), 'seed household is never erased');
    seed.active = true;
  });
});

describe('LOW fixes', () => {
  it('alert text counts watchers instead of listing their phones', () => {
    const m = member({ familyWatchers: ['+66810005555', '+66810006666'] });
    const call = { callerPhone: '+66811110010', turns: [], minutesBilled: 1 };
    const text = buildMessage({ call, member: m, verdict: { verdict: 'SCAM', confidence: 0.9, reason: 'r' } }).text;
    assert.doesNotMatch(text, /0005555|0006666/);
    assert.match(text, /2 คน/);
  });

  it('Verify SID without Twilio credentials fails closed (no mock code)', async () => {
    const saved = { sid: config.twilioVerifySid, acc: config.twilioAccountSid, tok: config.twilioAuthToken };
    config.twilioVerifySid = 'VA_x';
    config.twilioAccountSid = '';
    config.twilioAuthToken = '';
    try {
      const r = await sendOtpSms('+66810007777', '123456');
      assert.equal(r.ok, false);
      assert.equal(r.devCode, undefined);
    } finally {
      Object.assign(config, { twilioVerifySid: saved.sid, twilioAccountSid: saved.acc, twilioAuthToken: saved.tok });
    }
  });

  it('auth snapshots hold no raw session tokens and no OTP codes; sessions still survive', () => {
    const token = createSession('m_snap');
    requestOtp('+66810008888');
    const snap = JSON.parse(JSON.stringify(serializeAuth()));
    assert.ok(!JSON.stringify(snap).includes(token), 'raw token not persisted');
    assert.equal(snap.otpCodes, undefined);
    restoreAuth({});
    restoreAuth(snap);
    assert.equal(getSession(token).memberId, 'm_snap');
  });

  it('legacy snapshots with raw tokens still restore', () => {
    const raw = 'a'.repeat(64);
    restoreAuth({ sessions: [[raw, { memberId: 'm_legacy', createdAt: Date.now(), expiresAt: Date.now() + DAY }]] });
    assert.equal(getSession(raw).memberId, 'm_legacy');
  });

  it('billing checkout never echoes Stripe error text', async () => {
    const saved = { key: config.stripeSecretKey, prices: config.stripePrices['solo-99'] };
    config.stripeSecretKey = 'sk_test_fake_key_123';
    config.stripePrices['solo-99'] = { th: 'price_x', intl: 'price_y' };
    global.fetch = async (url, opts) => (String(url).startsWith('https://api.stripe.com')
      ? { ok: false, status: 400, json: async () => ({ error: { message: 'No such customer: cus_SECRET_DETAIL' } }) }
      : realFetch(url, opts));
    try {
      const m = member();
      const r = await http('POST', '/api/billing/checkout', { kind: 'plan', plan: 'solo-99' }, createSession(m.id));
      assert.equal(r.status, 502, "reached the Stripe error path");
      assert.doesNotMatch(JSON.stringify(r.body), /SECRET_DETAIL|No such customer/);
    } finally {
      config.stripeSecretKey = saved.key;
      config.stripePrices['solo-99'] = saved.prices;
    }
  });

  it('OTP sends have a daily cap too', async () => {
    for (let i = 0; i < 1000; i += 1) take('otp:day', 1000, DAY);
    const r = await sendOtp('+66810009999', 'login', { ip: '10.9.9.9' });
    assert.equal(r.ok, false);
    assert.equal(r.status, 429);
  });
});

describe('lead follow-ups', () => {
  it('shared async wrapper routes rejections to next()', async () => {
    const { safe } = await import('../src/asyncRoute.js');
    let got = null;
    await safe(async () => { throw new Error('boom'); })({}, {}, (e) => { got = e; });
    assert.equal(got.message, 'boom');
  });

  it('erasure aliases exist for member-app', async () => {
    const store = await import('../src/store.js');
    const auth = await import('../src/auth.js');
    assert.equal(store.eraseMember, store.deleteMember);
    assert.equal(auth.destroyMemberSessions, auth.destroySessionsFor);
    assert.deepEqual(store.eraseMember('m_unknown_id'), { calls: 0 }, 'unknown id is a no-op');
  });

  it('DELETE /api/me texts each protected phone (not the owner) to cancel forwarding, once', async () => {
    const m = member();
    m.protected = [
      { phone: m.ownerPhone, label: 'self' },
      { phone: '+66810004711', label: 'mother' },
      { phone: '+66810004712', label: 'father' },
    ];
    const sent = [];
    config.thsmsApiKey = 'thsms-test-key';
    global.fetch = async (url, opts) => {
      if (String(url).startsWith('https://thsms.com')) { sent.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; }
      return realFetch(url, opts);
    };
    try {
      const r = await http('DELETE', '/api/me', { confirm: true }, createSession(m.id));
      assert.equal(r.status, 200);
      assert.deepEqual(sent.map((x) => x.msisdn[0]).sort(), ['0810004711', '0810004712']);
      assert.match(sent[0].message, /##002#/);
    } finally {
      config.thsmsApiKey = '';
    }
  });

  it('one notice 7 days before auto-erase, then erase at 90 days', async () => {
    const { lifecycleTick } = await import('../src/jobs.js');
    const now = Date.now();
    const m = member();
    cancelMember(m.id);
    m.cancelledAt = new Date(now - (ERASE_AFTER_DAYS - 6) * DAY).toISOString(); // erased in 6 days
    const out = [];
    const deps = {
      sendLine: async (to, text) => { out.push({ to, text }); return { ok: true }; },
      sendSms: async (to, text) => { out.push({ to, text }); return { ok: true }; },
    };
    const sweep = async () => 0;
    await lifecycleTick({ now, deps, sweep, save: async () => {} });
    await lifecycleTick({ now: now + HOUR, deps, sweep, save: async () => {} });
    const mine = out.filter((x) => x.to === m.ownerPhone);
    assert.equal(mine.length, 1, 'one notice');
    assert.match(mine[0].text, /7 วัน|ลบ/);
    assert.ok(getMemberById(m.id), 'not erased yet');
    await lifecycleTick({ now: now + 7 * DAY, deps, sweep, save: async () => {} });
    assert.equal(getMemberById(m.id), null, 'erased after 90 days');
  });
});

describe('full CSP', () => {
  it('locks scripts to self + reCAPTCHA + LIFF SDK, no inline script, sockets to this host', async () => {
    const r = await realFetch(`${base}/api/plans`, { signal: AbortSignal.timeout(5000) });
    const csp = r.headers.get('content-security-policy');
    const dir = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).filter((x) => x[0]).map(([k, ...v]) => [k, v]));
    assert.deepEqual(dir['default-src'], ["'self'"]);
    for (const host of ["'self'", 'https://www.google.com/recaptcha/', 'https://www.gstatic.com/recaptcha/', 'https://static.line-scdn.net']) {
      assert.ok(dir['script-src'].includes(host), `script-src has ${host}`);
    }
    assert.ok(!dir['script-src'].includes("'unsafe-inline'"), 'no inline script');
    assert.ok(!dir['script-src'].includes("'unsafe-eval'"));
    assert.ok(!dir['script-src'].includes('blob:'), 'no blob: scripts (worklet is a file)');
    assert.ok(dir['connect-src'].some((s) => /^wss:\/\/127\.0\.0\.1:\d+$/.test(s)), 'websocket to this host only');
    assert.ok(!dir['connect-src'].includes('wss:'), 'not any wss host');
    assert.ok(dir['frame-src'].includes('https://www.google.com/recaptcha/'));
    assert.ok(dir['font-src'].includes('https://fonts.gstatic.com'));
    assert.ok(dir['style-src'].includes('https://fonts.googleapis.com'));
    assert.ok(dir['media-src'].includes('blob:'), 'pre-rendered audio plays from blob URLs');
    assert.deepEqual(dir['frame-ancestors'], ["'none'"]);
    assert.deepEqual(dir['object-src'], ["'none'"]);
    assert.deepEqual(dir['form-action'], ["'self'"]);
  });

  it('public pages carry no inline <script> or on*= handlers (the CSP would block them)', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const dirPath = new URL('../public/', import.meta.url);
    for (const f of readdirSync(dirPath).filter((x) => x.endsWith('.html'))) {
      const html = readFileSync(new URL(f, dirPath), 'utf8');
      for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        const attrs = m[1];
        if (/type\s*=\s*["']application\/(ld\+)?json["']/i.test(attrs)) continue; // data, never executed
        assert.ok(/\bsrc\s*=/.test(attrs) && !m[2].trim(), `${f}: inline <script> would be blocked by CSP`);
      }
      assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i, `${f}: inline event handler would be blocked by CSP`);
    }
  });
});

describe('farewell SMS on cancel / erase (##002#)', () => {
  function trapSms() {
    const sent = [];
    config.thsmsApiKey = 'thsms-test-key';
    global.fetch = async (url, opts) => {
      if (String(url).startsWith('https://thsms.com')) { sent.push(JSON.parse(opts.body).msisdn[0]); return { ok: true, json: async () => ({}) }; }
      return realFetch(url, opts);
    };
    return sent;
  }
  it('cancel texts each protected phone once; a later erase does not text again', async () => {
    const m = member();
    m.protected = [{ phone: m.ownerPhone, label: 'self' }, { phone: '+66810004721', label: 'mother' }];
    const sent = trapSms();
    try {
      const token = createSession(m.id);
      assert.equal((await http('POST', '/api/me/cancel', {}, token)).status, 200);
      assert.equal((await http('POST', '/api/me/cancel', {}, token)).status, 200);
      assert.deepEqual(sent, ['0810004721'], 'once, never the payer');
      assert.equal((await http('DELETE', '/api/me', { confirm: true }, token)).status, 200);
      assert.deepEqual(sent, ['0810004721'], 'erase after cancel: already told');
    } finally { config.thsmsApiKey = ''; }
  });

  it('reactivate then cancel again tells them again', async () => {
    const m = member();
    m.protected = [{ phone: '+66810004722', label: 'father' }];
    const sent = trapSms();
    try {
      const token = createSession(m.id);
      await http('POST', '/api/me/cancel', {}, token);
      await http('POST', '/api/me/reactivate', {}, token);
      await http('POST', '/api/me/cancel', {}, token);
      assert.deepEqual(sent, ['0810004722', '0810004722']);
    } finally { config.thsmsApiKey = ''; }
  });
});

describe('publicMember seat count', () => {
  it('reports active seat periods', async () => {
    __resetFulfilled();
    const m = member({ plan: 'family-199' });
    fulfillCheckoutSession({ id: 'cs_seat_pm1', payment_status: 'paid', metadata: { memberId: m.id, kind: 'seat' } });
    const r = await http('GET', '/api/me', undefined, createSession(m.id));
    assert.equal(r.body.member.seatsPaid, 1);
  });
});

describe('trial tombstone (no free-trial reset via erase + re-signup)', () => {
  const signup = async (phone) => {
    const sent = await http('POST', '/api/auth/request-otp', { phone });
    return http('POST', '/api/auth/verify-otp', { phone, code: sent.body.devCode, plan: 'family-199' });
  };

  it('a phone that erased its account re-signs up with no trial', async () => {
    const { trialUsedBefore } = await import('../src/store.js');
    const phone = '+66810004801';
    const first = await signup(phone);
    assert.equal(first.status, 200);
    assert.equal(first.body.isNew, true);
    assert.notEqual(first.body.trialUsed, true);
    assert.equal((await http('DELETE', '/api/me', { confirm: true }, first.body.token)).status, 200);
    assert.equal(trialUsedBefore(phone), true);
    const again = await signup(phone);
    assert.equal(again.status, 200);
    assert.equal(again.body.isNew, true);
    assert.equal(again.body.trialUsed, true);
    assert.equal(again.body.notice, 'เบอร์นี้เคยใช้ช่วงทดลองแล้ว');
    const m = getMemberById(again.body.member.id);
    assert.equal(m.trialDenied, true);
    assert.ok(Date.parse(m.trialEndsAt) <= Date.now());
  });

  it('tombstones hold no phone number and expire after 12 months', async () => {
    const { recordTrialUsed, trialUsedBefore, pruneTombstones } = await import('../src/store.js');
    const phone = '+66810004802';
    const now = Date.now();
    recordTrialUsed(phone, new Date(now).toISOString(), now);
    const snap = JSON.stringify(serializeStore());
    assert.ok(!snap.includes('810004802'), 'only a keyed hash is stored');
    assert.equal(trialUsedBefore(phone, now + 364 * DAY), true);
    assert.equal(trialUsedBefore(phone, now + 366 * DAY), false);
    pruneTombstones(now + 366 * DAY);
    assert.equal(trialUsedBefore(phone, now), false, 'pruned');
  });

  it('tombstones survive a restart; a fresh phone still gets its trial', async () => {
    const { recordTrialUsed, trialUsedBefore } = await import('../src/store.js');
    recordTrialUsed('+66810004803');
    restoreStore(JSON.parse(JSON.stringify(serializeStore())));
    assert.equal(trialUsedBefore('+66810004803'), true);
    const fresh = await signup('+66810004804');
    assert.notEqual(fresh.body.trialUsed, true);
    assert.ok(Date.parse(getMemberById(fresh.body.member.id).trialEndsAt) > Date.now());
  });
});

describe('CSP violation reports', () => {
  it('the policy reports to /api/csp-report, which logs one short line and answers 204', async () => {
    const { contentSecurityPolicy, cspReportRoute } = await import('../src/securityHeaders.js');
    assert.match(contentSecurityPolicy('x.test'), /report-uri \/api\/csp-report/);
    const app = express();
    app.post('/api/csp-report', express.json({ type: ['application/csp-report', 'application/json'] }), cspReportRoute(take));
    const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const lines = [];
    const warn = console.warn;
    console.warn = (...a) => lines.push(a.join(' '));
    try {
      const r = await realFetch(`http://127.0.0.1:${srv.address().port}/api/csp-report`, {
        method: 'POST', headers: { 'Content-Type': 'application/csp-report' },
        body: JSON.stringify({ 'csp-report': { 'violated-directive': 'script-src-elem', 'blocked-uri': 'inline\nFAKE LOG LINE', 'document-uri': 'https://krai-a.com/demo.html' } }),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(r.status, 204);
      assert.equal(lines.length, 1);
      assert.match(lines[0], /^\[csp\] script-src-elem blocked=inline FAKE LOG LINE page=https:\/\/krai-a\.com\/demo\.html$/, 'newlines cannot forge log lines');
    } finally {
      console.warn = warn;
      await new Promise((resolve) => srv.close(resolve));
    }
  });

  it('a hostile Host header cannot inject CSP directives', async () => {
    const { contentSecurityPolicy } = await import('../src/securityHeaders.js');
    const csp = contentSecurityPolicy("evil.test; script-src 'unsafe-inline' *");
    assert.doesNotMatch(csp, /unsafe-inline' \*/);
    assert.equal(csp.split(';').filter((d) => d.trim().startsWith('script-src ')).length, 1);
  });
});
