// Phone calls must settle exactly once, whoever ends them: the AI's closing
// line, Twilio's status callback when the caller hangs up, or the stale
// sweep. Settling bills minutes (no house-cap bypass by hanging up), alerts
// the owner when the caller spoke, and frees the record for retention.
// Quota: the plan quota is soft (keep screening); only the hard house cap
// rejects, with one ##002# SMS per protected phone per period.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { addMember, addTurn, getCallBySid, quotaSummary } from '../src/store.js';
import {
  voiceIncoming, voiceTurn, voiceStatus, closeStaleCalls, settleCall, voiceDeps, HOUSE_CAP_SMS, STALE_CALL_MS,
} from '../src/twilio/voice.js';

const tick = () => new Promise((resolve) => { setTimeout(resolve, 20); });
let seq = 0;
const sid = () => `CA${String(++seq).padStart(32, '0')}`;

function fake({ body = {}, query = {} } = {}) {
  const req = { body, query, headers: { 'x-forwarded-proto': 'https' }, protocol: 'https', get: () => 'krai-a.test' };
  const res = { out: '', code: 200, type() { return this; }, status(c) { this.code = c; return this; }, send(x) { this.out = String(x); return this; } };
  return { req, res };
}

function member(n) {
  return addMember({ ownerPhone: `+668100088${String(n).padStart(2, '0')}`, aiNumber: `+662100088${String(n).padStart(2, '0')}`, plan: 'family-149' });
}

// Answer a call and say one caller line; returns the call record.
async function answeredCall(m, { speak = 'สวัสดีครับ โทรจากร้านซ่อมแอร์ จะนัดล้างแอร์ครับ', callSid = sid() } = {}) {
  const a = fake({ body: { To: m.aiNumber, From: `+6681999${String(seq).padStart(4, '0')}`, CallSid: callSid } });
  voiceIncoming(a.req, a.res);
  const call = getCallBySid(callSid);
  assert.ok(call, a.res.out);
  if (speak) {
    const t = fake({ body: { SpeechResult: speak }, query: { callId: call.id } });
    await voiceTurn(t.req, t.res);
  }
  return call;
}

async function status(callSid, CallStatus, CallDuration) {
  const s = fake({ body: { CallSid: callSid, CallStatus, CallDuration: String(CallDuration) } });
  await voiceStatus(s.req, s.res);
  return s.res;
}

describe('phone call settlement', () => {
  const saved = {
    mode: config.identifyMode, allow: config.forwardAllowlist, notify: config.notifyAdapters,
    cap: config.maxMinutesPerHousePerMonth, deps: { ...voiceDeps }, log: console.log,
  };
  let logs; let sms; let payer;
  before(() => {
    config.identifyMode = 'A'; config.forwardAllowlist = []; config.notifyAdapters = ['console'];
    voiceDeps.sendSms = async (phone, text) => { sms.push({ phone, text }); return { ok: true }; };
    voiceDeps.notifyPayer = async (m, text) => { payer.push({ m: m.id, text }); return { ok: true }; };
  });
  beforeEach(() => {
    logs = []; sms = []; payer = [];
    console.log = (...a) => { logs.push(a.join(' ')); };
  });
  after(() => {
    console.log = saved.log;
    Object.assign(config, { identifyMode: saved.mode, forwardAllowlist: saved.allow, notifyAdapters: saved.notify, maxMinutesPerHousePerMonth: saved.cap });
    Object.assign(voiceDeps, saved.deps);
  });

  it('caller hang-up: status callback ends the call, bills Twilio minutes and alerts the owner', async () => {
    const m = member(1);
    const before = quotaSummary(m).used;
    const call = await answeredCall(m);
    assert.equal(call.endedAt, null);
    const r = await status(call.callSid, 'completed', 95);
    assert.equal(r.code, 200);
    assert.ok(call.endedAt);
    assert.equal(call.endReason, 'caller-hangup');
    assert.equal(call.minutesBilled, 2);
    assert.equal(quotaSummary(m).used - before, 2);
    assert.ok(logs.some((l) => l.includes('[notify:console')), 'owner alert sent');
  });

  it('status callback retries never bill or alert twice', async () => {
    const m = member(2);
    const call = await answeredCall(m);
    await status(call.callSid, 'completed', 30);
    const used = quotaSummary(m).used;
    const alerts = logs.filter((l) => l.includes('[notify:console')).length;
    assert.ok(alerts >= 1);
    await status(call.callSid, 'completed', 30);
    await status(call.callSid, 'completed', 300);
    assert.equal(quotaSummary(m).used, used);
    assert.equal(logs.filter((l) => l.includes('[notify:console')).length, alerts);
  });

  it('concurrent callbacks settle once', async () => {
    const m = member(10);
    const call = await answeredCall(m);
    const used = quotaSummary(m).used;
    const results = await Promise.all([settleCall(call, { minutes: 1 }), settleCall(call, { minutes: 1 }), settleCall(call, { minutes: 1 })]);
    assert.deepEqual(results.filter(Boolean).length, 1);
    assert.equal(quotaSummary(m).used - used, 1);
  });

  it('the settle claim never lands on the call record (a mid-settle snapshot restores settleable)', async () => {
    const m = member(12);
    const call = await answeredCall(m);
    const pending = settleCall(call, { minutes: 1 });
    assert.equal('settling' in call, false); // nothing for a snapshot to persist
    await pending;
    const restored = await answeredCall(m);
    restored.settling = true; // a record from an older snapshot
    assert.equal(await settleCall(restored, { minutes: 1 }), true);
  });

  it('hang-up after speaking but before a verdict: the caller\'s words are judged before alerting', async () => {
    const m = member(11);
    const call = await answeredCall(m, { speak: '' });
    addTurn(call.id, 'caller', 'แจ้งรหัส OTP มาเดี๋ยวนี้ ไม่งั้นบัญชีถูกอายัด'); // judge never ran for this line
    assert.equal(call.verdict, null);
    await status(call.callSid, 'completed', 50);
    assert.ok(call.endedAt);
    assert.notEqual(call.verdict.engine, 'none');
    assert.equal(call.verdict.verdict, 'SCAM');
    assert.equal(logs.filter((l) => l.includes('[notify:console')).length >= 1, true);
  });

  it('AI-ended call: the later callback only tops up to Twilio\'s billed minutes, once', async () => {
    const m = member(3);
    const call = await answeredCall(m, { speak: '' });
    const t = fake({ body: { SpeechResult: 'โอนเงินมาเดี๋ยวนี้ แล้วบอกรหัส OTP ด้วย' }, query: { callId: call.id } });
    await voiceTurn(t.req, t.res);
    assert.match(t.res.out, /<Hangup\/>/);
    assert.equal(call.endReason, 'ai');
    const used = quotaSummary(m).used;
    await status(call.callSid, 'completed', 150); // 3 billed minutes vs 1 on our clock
    assert.equal(quotaSummary(m).used - used, 2);
    await status(call.callSid, 'completed', 150);
    assert.equal(quotaSummary(m).used - used, 2);
  });

  it('caller hangs up before speaking: closed and billed, no owner alert', async () => {
    const m = member(4);
    const call = await answeredCall(m, { speak: '' });
    await status(call.callSid, 'completed', 8);
    assert.ok(call.endedAt);
    assert.equal(call.verdict.verdict, 'UNSURE');
    assert.equal(call.verdict.reasonEn, 'The caller hung up before speaking.');
    assert.ok(!logs.some((l) => l.includes('[notify:console')));
  });

  it('non-completed terminal statuses bill nothing; unknown sids are ignored', async () => {
    const m = member(5);
    const call = await answeredCall(m, { speak: '' });
    const used = quotaSummary(m).used;
    await status(call.callSid, 'failed', 0);
    assert.ok(call.endedAt);
    assert.equal(quotaSummary(m).used, used);
    const r = await status(sid(), 'completed', 60);
    assert.equal(r.code, 200);
  });

  it('a late /voice/turn on a settled call does not judge or bill again', async () => {
    const m = member(6);
    const call = await answeredCall(m);
    await status(call.callSid, 'completed', 40);
    const used = quotaSummary(m).used;
    const turns = call.turns.length;
    const t = fake({ body: { SpeechResult: 'ฮัลโหล' }, query: { callId: call.id } });
    await voiceTurn(t.req, t.res);
    assert.match(t.res.out, /<Hangup\/>/);
    assert.equal(call.turns.length, turns);
    assert.equal(quotaSummary(m).used, used);
  });

  it('stale sweep settles calls quiet for 15 min, billed to their last activity', async () => {
    const m = member(7);
    const stale = await answeredCall(m);
    const fresh = await answeredCall(m);
    const t0 = Date.now() - 40 * 60000;
    stale.startedAt = new Date(t0).toISOString();
    stale.turns.forEach((t, i) => { t.at = new Date(t0 + (i + 1) * 60000).toISOString(); });
    const closed = await closeStaleCalls(Date.now(), STALE_CALL_MS);
    assert.ok(closed >= 1);
    assert.equal(stale.endReason, 'stale');
    assert.equal(stale.minutesBilled, stale.turns.length);
    assert.equal(fresh.endedAt, null);
    assert.equal(await settleCall(stale), false); // exactly once
  });

  it('plan quota is soft: over plan quota but under the house cap the call is still screened', async () => {
    const m = member(8);
    m.minutesUsed = quotaSummary(m).quota + 5;
    const a = fake({ body: { To: m.aiNumber, From: '+66819990808', CallSid: sid() } });
    voiceIncoming(a.req, a.res);
    assert.match(a.res.out, /<Gather/);
  });

  it('hard house cap: rejects unanswered and texts each protected phone ##002# once per period', async () => {
    const m = member(9);
    m.protected = [{ phone: '+66810008809', label: 'self' }, { phone: '+66810008899', label: 'mother' }];
    config.maxMinutesPerHousePerMonth = 1;
    m.minutesUsed = 1;
    try {
      for (let i = 0; i < 2; i += 1) {
        const a = fake({ body: { To: m.aiNumber, From: `+6681999090${i}`, CallSid: sid() } });
        voiceIncoming(a.req, a.res);
        assert.match(a.res.out, /<Reject/);
        assert.doesNotMatch(a.res.out, /<Say|<Play|<Gather/);
        await tick();
      }
      assert.deepEqual(sms.map((x) => x.phone).sort(), ['+66810008809', '+66810008899']);
      assert.ok(sms.every((x) => x.text === HOUSE_CAP_SMS && x.text.includes('##002#')));
      assert.equal(payer.length, 1);
    } finally {
      config.maxMinutesPerHousePerMonth = saved.cap;
    }
  });

  it('production logs never carry full phone numbers', async () => {
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const a = fake({ body: { To: '+66219999999', From: '+66812345678', CallSid: sid() } });
      voiceIncoming(a.req, a.res);
      assert.ok(logs.length > 0);
      assert.ok(logs.every((l) => !l.includes('+66812345678') && !l.includes('+66219999999')), logs.join('\n'));
    } finally {
      process.env.NODE_ENV = env;
    }
  });
});
