// Demo isolation (TASK-004): one visitor's demo call is never ended by
// another visitor, the demo household is picked by SEED_MEMBER_PHONE, demo
// alerts are returned for on-screen display only (no real LINE push), and
// every call type ends gracefully with a closing line + final alert.
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { config } from '../src/config.js';
import { addMember, createCall, addTurn, getCall } from '../src/store.js';
import { resetLimits } from '../src/ratelimit.js';
import { demoRouter } from '../src/routes.js';
import { createJudge } from '../src/judge/index.js';
import { getScript } from '../src/demoScripts.js';

// Deterministic + offline: no Gemini/Jev, no captcha, no SMS.
config.aiOffline = true;
config.geminiApiKey = '';
config.recaptchaApiKey = '';
config.demoNumber = '';

// A decoy member is added FIRST: the demo must not pick listMembers()[0].
const DECOY = addMember({ ownerPhone: '+66810009201', aiNumber: '+66210009201' });
const SEED = addMember({ ownerPhone: config.seedMemberPhone, aiNumber: '+66210009202', plan: 'family-149', counted: false });

let server; let base;
const saved = {
  adapters: [...config.notifyAdapters], lineTo: config.lineDefaultTo, lineToken: config.lineChannelAccessToken,
};
const realFetch = global.fetch;
let lineCalls = [];

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', demoRouter(() => {}));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); });
afterEach(() => {
  resetLimits();
  global.fetch = realFetch;
  lineCalls = [];
  config.notifyAdapters = [...saved.adapters];
  config.lineDefaultTo = saved.lineTo;
  config.lineChannelAccessToken = saved.lineToken;
});

const req = async (method, p, body, cookie) => {
  const r = await realFetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000), // a crashed async handler never responds
  });
  const setCookie = r.headers.get('set-cookie') || '';
  return { status: r.status, body: await r.json().catch(() => null), setCookie, cookie: setCookie.split(';')[0] };
};
const start = (cookie, body = {}) => req('POST', '/api/demo/call', body, cookie);
const turn = (callId, text, cookie) => req('POST', '/api/demo/turn', { callId, text }, cookie);

// Record (and swallow) every LINE push attempt.
function trapLine() {
  config.notifyAdapters = ['console', 'line'];
  config.lineDefaultTo = 'Uowner0123456789secret';
  config.lineChannelAccessToken = 'test-token';
  global.fetch = async (url, opts) => {
    if (String(url).startsWith('https://api.line.me')) {
      lineCalls.push(String(url));
      return { ok: true, json: async () => ({}) };
    }
    return realFetch(url, opts);
  };
}

describe('demo calls are isolated per visitor', () => {
  it('issues an HttpOnly visitor cookie on the first demo call', async () => {
    const r = await start();
    assert.equal(r.status, 200);
    assert.match(r.setCookie, /ka_demo=[0-9a-f]{32}/);
    assert.match(r.setCookie, /HttpOnly/i);
    assert.match(r.setCookie, /SameSite=Lax/i);
    assert.match(r.setCookie, /Path=\/api/i);
  });

  it("visitor B starting a call never ends visitor A's open call", async () => {
    const a = await start();
    const b = await start();
    assert.notEqual(a.cookie, b.cookie);
    assert.equal(b.body.replaced, false);
    assert.equal(getCall(a.body.call.id).endedAt, null);
    assert.equal(getCall(b.body.call.id).endedAt, null);
  });

  it('the same visitor starting again replaces only its own open call', async () => {
    const a1 = await start();
    const b = await start();
    const a2 = await start(a1.cookie);
    assert.equal(a2.body.replaced, true);
    assert.equal(a2.setCookie, '', 'known visitor keeps its cookie');
    assert.ok(getCall(a1.body.call.id).endedAt, "A's old call ended");
    assert.equal(getCall(a1.body.call.id).verdict.verdict, 'UNSURE');
    assert.equal(getCall(a2.body.call.id).endedAt, null);
    assert.equal(getCall(b.body.call.id).endedAt, null, "B's call untouched");
  });

  it('a malformed visitor cookie is replaced, never trusted', async () => {
    const b = await start();
    const r = await start('ka_demo=../../etc');
    assert.match(r.setCookie, /ka_demo=[0-9a-f]{32}/);
    assert.equal(r.body.replaced, false);
    assert.equal(getCall(b.body.call.id).endedAt, null);
  });

  it('idle demo calls of any visitor are swept when a new call starts', async () => {
    const stale = createCall({ memberId: SEED.id, callerPhone: '+66819990077', aiNumber: SEED.aiNumber, source: 'demo' });
    addTurn(stale.id, 'assistant', 'hello');
    const old = new Date(Date.now() - (config.demoIdleMinutes + 1) * 60000).toISOString();
    stale.startedAt = old;
    stale.turns[0].at = old;
    await start();
    assert.ok(getCall(stale.id).endedAt, 'idle call ended');
    assert.equal(getCall(stale.id).verdict.engine, 'none', 'canned verdict, no AI spend');
  });

  it('public payloads never expose the visitor key or cookie', async () => {
    const a = await start();
    const id = a.body.call.id;
    const value = a.cookie.split('=')[1];
    const list = await req('GET', `/api/calls?ids=${id}`);
    const one = await req('GET', `/api/calls/${id}`);
    const t = await turn(id, 'สวัสดีค่ะ', a.cookie);
    const blob = JSON.stringify([a.body, list.body, one.body, t.body]);
    assert.doesNotMatch(blob, /visitor/i);
    assert.ok(!blob.includes(value));
  });
});

describe('demo household = SEED_MEMBER_PHONE', () => {
  it('demo calls belong to the seed member, not the first member', async () => {
    const r = await start();
    assert.equal(r.body.call.memberId, SEED.id);
    assert.notEqual(r.body.call.memberId, DECOY.id);
  });

  it('/api/status advertises the seed number', async () => {
    const r = await req('GET', '/api/status');
    assert.equal(r.body.demoNumber, SEED.aiNumber);
  });
});

describe('demo alerts are on-screen only (no real LINE push)', () => {
  it('verdict end returns the alert payload without pushing LINE', async () => {
    trapLine();
    const a = await start();
    let r;
    for (const line of ['ผมโทรจากธนาคาร รบกวนแจ้งรหัส OTP ที่ส่งไปด่วนเลยครับ', 'บอกรหัส otp มาเดี๋ยวนี้ ห้ามวางสาย']) {
      r = await turn(a.body.call.id, line, a.cookie);
      if (r.body.ended) break;
    }
    assert.equal(r.body.ended, true);
    assert.equal(r.body.verdict.verdict, 'SCAM');
    assert.equal(r.body.endReason, 'scam');
    assert.ok(r.body.notify.message.text.length > 10);
    assert.equal(r.body.notify.flex.type, 'bubble');
    assert.equal(r.body.notify.delivered, false);
    assert.deepEqual(lineCalls, []);
    assert.doesNotMatch(JSON.stringify(r.body), /Uowner0123456789secret/);
  });

  it('hangup end returns the alert payload without pushing LINE', async () => {
    trapLine();
    const a = await start();
    const r = await req('POST', '/api/demo/end', { callId: a.body.call.id }, a.cookie);
    assert.equal(r.body.ended, true);
    assert.ok(r.body.notify.message.text);
    assert.equal(r.body.notify.delivered, false);
    assert.deepEqual(lineCalls, []);
  });

  it('demo calls never burn seed quota or fire the quota-low LINE alert', async () => {
    trapLine();
    SEED.minutesUsed = 49; // one minute left of 50 → "low" if demo burned quota
    SEED.quotaWarnedPeriod = '';
    const a = await start();
    await req('POST', '/api/demo/end', { callId: a.body.call.id }, a.cookie);
    assert.equal(SEED.minutesUsed, 49);
    assert.equal(SEED.quotaWarnedPeriod, '');
    assert.deepEqual(lineCalls, []);
    SEED.minutesUsed = 0;
  });
});

describe('demo turn loop', () => {
  it('speaks the first canned reply on the first caller turn', async () => {
    const a = await start();
    const r = await turn(a.body.call.id, 'สวัสดีค่ะ', a.cookie);
    assert.equal(r.body.ended, false);
    const offline = createJudge({ config: { aiOffline: true, maxTurnsPerCall: config.maxTurnsPerCall } });
    const first = await offline.personaReply({
      turns: [{ role: 'ai', text: 'hello' }, { role: 'caller', text: 'สวัสดีค่ะ' }], verdict: 'UNSURE', action: 'continue',
    });
    assert.equal(r.body.reply, first.text);
  });

  it('caps caller text length and rejects non-string text', async () => {
    const a = await start();
    const bad = await turn(a.body.call.id, { $gt: '' }, a.cookie);
    assert.equal(bad.status, 400);
    await turn(a.body.call.id, 'ก'.repeat(5000), a.cookie);
    const callerTurn = getCall(a.body.call.id).turns.find((t) => t.role === 'caller');
    assert.ok(callerTurn.text.length <= 500);
  });

  it('a LEGIT caller ends politely: closing line + final alert, no max-turn loop', async () => {
    const script = getScript('legit-hospital');
    const a = await start(undefined, { scriptId: script.id });
    let r;
    for (const line of script.lines) {
      r = await turn(a.body.call.id, line, a.cookie);
      if (r.body.ended) break;
    }
    assert.equal(r.body.ended, true, 'call concluded within the script');
    assert.equal(r.body.verdict.verdict, 'LEGIT');
    assert.equal(r.body.endReason, 'message-taken');
    const last = r.body.call.turns.at(-1);
    assert.equal(last.role, 'assistant');
    assert.ok(last.text.length > 5, 'closing line spoken');
    assert.ok(r.body.notify.message.text, 'final alert payload');
  });

  it('an UNSURE caller wraps up instead of looping to max turns', async () => {
    const vague = getScript('unsure-survey').lines[0]; // stays UNSURE offline
    const a = await start();
    let r;
    let n = 0;
    while (n < config.maxTurnsPerCall) {
      n += 1;
      r = await turn(a.body.call.id, vague, a.cookie);
      if (r.body.ended) break;
    }
    assert.equal(r.body.ended, true, 'call concluded');
    assert.ok(n < config.maxTurnsPerCall, `wrapped up early (turn ${n})`);
    assert.equal(r.body.verdict.verdict, 'UNSURE');
    assert.equal(r.body.endReason, 'message-taken');
    assert.equal(r.body.call.turns.at(-1).role, 'assistant');
    assert.ok(r.body.notify.message.text);
  });
});
