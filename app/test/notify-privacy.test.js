// Alert privacy (PDPA): a real member's call alerts (caller number, reason)
// go only to LINE accounts that member or their watchers linked themselves —
// never to the operator's LINE_DEFAULT_TO. Unlinked owners get one SMS nudge
// to link LINE (no caller data in it). Only the operator's own demo
// household may use LINE_DEFAULT_TO. Copy says "บทสนทนา" (no recordings).
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { addMember, createCall, addTurn, consumeMinutes, addWatcher } from '../src/store.js';
import { notifyOwner, maybeNotifyQuotaLow, buildMessage } from '../src/notify/index.js';
import { linkWatcherLine } from '../src/household.js';
import { resetLimits } from '../src/ratelimit.js';

const OPERATOR = 'Uoperator000000000000secret';
const saved = {
  adapters: [...config.notifyAdapters], lineTo: config.lineDefaultTo, token: config.lineChannelAccessToken,
  thsms: config.thsmsApiKey, base: config.publicBaseUrl, env: process.env.NODE_ENV,
};
const realFetch = global.fetch;
let pushes; let sms;

function trap() {
  pushes = [];
  sms = [];
  config.notifyAdapters = ['console', 'line'];
  config.lineDefaultTo = OPERATOR;
  config.lineChannelAccessToken = 'test-token';
  config.thsmsApiKey = 'thsms-test-key';
  config.publicBaseUrl = 'https://krai-a.com';
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://api.line.me')) {
      pushes.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({}) };
    }
    if (u.startsWith('https://thsms.com')) {
      sms.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({}) };
    }
    throw new Error(`unexpected network call ${u}`);
  };
}
afterEach(() => {
  global.fetch = realFetch;
  config.notifyAdapters = [...saved.adapters];
  config.lineDefaultTo = saved.lineTo;
  config.lineChannelAccessToken = saved.token;
  config.thsmsApiKey = saved.thsms;
  config.publicBaseUrl = saved.base;
  process.env.NODE_ENV = saved.env;
  resetLimits();
});

let n = 0;
const member = (extra = {}) => {
  n += 1;
  return addMember({ ownerPhone: `+668100077${String(n).padStart(2, '0')}`, aiNumber: `+662100077${String(n).padStart(2, '0')}`, ...extra });
};
function scamCall(m) {
  const c = createCall({ memberId: m.id, callerPhone: '+66819990555', aiNumber: m.aiNumber, source: 'twilio' });
  addTurn(c.id, 'caller', 'โอนเงินมาด่วน');
  return c;
}
const verdict = { verdict: 'SCAM', confidence: 0.95, reason: 'ขอโอนเงินด่วน', reasonEn: 'Urgent transfer demand', engine: 'jev' };
const blob = (x) => JSON.stringify(x);

describe('real members: no operator fallback', () => {
  it('an unlinked owner gets no LINE push and the operator never sees the call', async () => {
    trap();
    const m = member();
    const r = await notifyOwner({ call: scamCall(m), member: m, verdict });
    assert.deepEqual(pushes, []);
    assert.ok(!blob(r.results).includes(OPERATOR));
  });

  it('an unlinked owner gets ONE SMS nudge to link LINE, without caller data', async () => {
    trap();
    const m = member();
    await notifyOwner({ call: scamCall(m), member: m, verdict });
    await notifyOwner({ call: scamCall(m), member: m, verdict });
    assert.equal(sms.length, 1, 'one-time nudge');
    assert.deepEqual(sms[0].msisdn, [m.ownerPhone.replace('+66', '0')]);
    assert.match(sms[0].message, /LINE/);
    assert.doesNotMatch(sms[0].message, /0819990555|819990555|โอนเงิน/);
    assert.ok(m.lineNudgedAt);
  });

  it('a linked owner and linked watchers are pushed; the operator never is', async () => {
    trap();
    const m = member({ lineUserId: 'Uowner77' });
    addWatcher(m.id, '+66810007799');
    linkWatcherLine('+66810007799', 'Uwatcher77');
    await notifyOwner({ call: scamCall(m), member: m, verdict });
    assert.deepEqual(pushes.map((p) => p.to).sort(), ['Uowner77', 'Uwatcher77']);
    assert.deepEqual(sms, []);
  });

  it('quota-low alerts never fall back to the operator LINE either', async () => {
    trap();
    const m = member({ plan: 'solo-99' });
    consumeMinutes(m, 55); // > 80% of 60
    const r = await maybeNotifyQuotaLow(m);
    assert.equal(r.warned, true);
    assert.deepEqual(pushes, []);
  });
});

describe("the operator's own demo household", () => {
  it('may still alert LINE_DEFAULT_TO (phone-demo flow)', async () => {
    trap();
    const seed = addMember({ ownerPhone: config.seedMemberPhone, aiNumber: '+66210007700', counted: false });
    await notifyOwner({ call: scamCall(seed), member: seed, verdict });
    assert.deepEqual(pushes.map((p) => p.to), [OPERATOR]);
    assert.deepEqual(sms, []);
  });
});

describe('copy + logs', () => {
  it('says บทสนทนา, never คลิปเสียง (no recordings exist)', () => {
    const m = member();
    const text = buildMessage({ call: scamCall(m), member: m, verdict }).text;
    assert.match(text, /บทสนทนา/);
    assert.doesNotMatch(text, /คลิปเสียง/);
  });

  it('the console adapter keeps caller data out of production logs', async () => {
    trap();
    config.notifyAdapters = ['console'];
    process.env.NODE_ENV = 'production';
    const m = member({ lineUserId: 'Uowner88' });
    const lines = [];
    const realLog = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try {
      await notifyOwner({ call: scamCall(m), member: m, verdict });
    } finally {
      console.log = realLog;
    }
    assert.ok(lines.length >= 1);
    assert.doesNotMatch(lines.join('\n'), /819990555|ขอโอนเงินด่วน|Uowner88/);
  });
});
