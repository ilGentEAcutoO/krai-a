// Soft plan quota: screening never stops at quota. The payer gets one
// warning at 80% and one at 100% per billing period (LINE if linked, else
// SMS; never caller data), and minutes/calls beyond the quota are counted
// per period for later billing.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { addMember, createCall, consumeMinutes, quotaSummary, quotaPeriodKey, quotaTotal, PLANS } from '../src/store.js';
import { maybeNotifyQuotaLow } from '../src/notify/index.js';
import { resetLimits } from '../src/ratelimit.js';

const saved = {
  adapters: [...config.notifyAdapters], token: config.lineChannelAccessToken, thsms: config.thsmsApiKey, lineTo: config.lineDefaultTo,
};
const realFetch = global.fetch;
let pushes; let sms;
function trap() {
  pushes = [];
  sms = [];
  config.notifyAdapters = ['console', 'line'];
  config.lineChannelAccessToken = 'test-token';
  config.lineDefaultTo = 'Uoperator0000';
  config.thsmsApiKey = 'thsms-test-key';
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://api.line.me')) { pushes.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; }
    if (u.startsWith('https://thsms.com')) { sms.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; }
    throw new Error(`unexpected network call ${u}`);
  };
}
afterEach(() => {
  global.fetch = realFetch;
  Object.assign(config, { notifyAdapters: [...saved.adapters], lineChannelAccessToken: saved.token, thsmsApiKey: saved.thsms, lineDefaultTo: saved.lineTo });
  resetLimits();
});

let n = 0;
const member = (extra = {}) => {
  n += 1;
  return addMember({ ownerPhone: `+668100066${String(n).padStart(2, '0')}`, aiNumber: `+662100066${String(n).padStart(2, '0')}`, plan: 'solo-99', ...extra });
};
const MIN = PLANS['solo-99'].quota; // 60
const CALLS = PLANS['solo-99'].calls; // 30
const pct = (p) => Math.round((MIN * p) / 100);
const texts = () => [...pushes.map((p) => p.messages[0].altText), ...sms.map((s) => s.message)];

describe('80% and 100% warnings, once each per period', () => {
  it('a linked payer gets one LINE at 80% and one at 100%', async () => {
    trap();
    const m = member({ lineUserId: 'Upayer01' });
    consumeMinutes(m, pct(70));
    assert.equal((await maybeNotifyQuotaLow(m)).warned, false);
    consumeMinutes(m, pct(80) - pct(70));
    assert.equal((await maybeNotifyQuotaLow(m)).warned, true);
    assert.equal((await maybeNotifyQuotaLow(m)).warned, false, '80% only once');
    consumeMinutes(m, MIN - pct(80));
    assert.equal((await maybeNotifyQuotaLow(m)).warned, true);
    assert.equal((await maybeNotifyQuotaLow(m)).warned, false, '100% only once');
    assert.equal(pushes.length, 2);
    assert.deepEqual(pushes.map((p) => p.to), ['Upayer01', 'Upayer01']);
    assert.match(texts()[0], /80%/);
    assert.match(texts()[1], /ครบ/);
    assert.deepEqual(sms, []);
  });

  it('an unlinked payer gets the warnings by SMS; never the operator LINE', async () => {
    trap();
    const m = member();
    consumeMinutes(m, MIN); // straight to 100%: one alert, not two
    assert.equal((await maybeNotifyQuotaLow(m)).warned, true);
    assert.equal((await maybeNotifyQuotaLow(m)).warned, false);
    assert.deepEqual(pushes, []);
    assert.equal(sms.length, 1);
    assert.deepEqual(sms[0].msisdn, [m.ownerPhone.replace('+66', '0')]);
    assert.match(sms[0].message, /ไม่ตัดการป้องกัน|รับสายให้ต่อ/);
  });

  it('calls count too, and alerts never carry caller data', async () => {
    trap();
    const m = member({ lineUserId: 'Upayer03' });
    for (let i = 0; i < CALLS; i += 1) createCall({ memberId: m.id, callerPhone: `+6681999${String(i).padStart(4, '0')}`, aiNumber: m.aiNumber, source: 'twilio' });
    assert.equal((await maybeNotifyQuotaLow(m)).warned, true, 'all calls used = 100%');
    assert.doesNotMatch(JSON.stringify([pushes, sms]), /819990/);
  });

  it('a new period re-arms both warnings', async () => {
    trap();
    const m = member({ lineUserId: 'Upayer04' });
    consumeMinutes(m, MIN);
    await maybeNotifyQuotaLow(m);
    m.quotaAlerts.period = '2000-01'; // last month's stamps
    assert.equal((await maybeNotifyQuotaLow(m)).warned, true);
  });
});

describe('overage is counted, screening never stops', () => {
  it('minutes and calls beyond the quota are recorded per period', () => {
    const m = member();
    for (let i = 0; i < CALLS + 2; i += 1) createCall({ memberId: m.id, callerPhone: `+6681991${String(i).padStart(4, '0')}`, aiNumber: m.aiNumber, source: 'twilio' });
    consumeMinutes(m, MIN + 3);
    const q = quotaSummary(m);
    assert.equal(q.overageMinutes, MIN + 3 - quotaTotal(m));
    assert.equal(q.overageCalls, 2);
    assert.deepEqual(m.overage[quotaPeriodKey()], { minutes: 3, calls: 2 });
    assert.equal(q.remaining, 0, 'remaining floors at 0 — nothing is blocked');
  });
});
