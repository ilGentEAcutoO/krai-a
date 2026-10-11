// Talk budget: one call may burn at most 20% of the plan's monthly quota
// (฿20/10min → 2min, ฿100/50min → 10min). Budget-cut calls still conclude
// with the just-judged verdict — never hang up without a summary.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { addMember, getMemberByOwner, getCall } from '../src/store.js';
import { shouldEndNow, talkBudgetMinutes } from '../src/verdict.js';
import { personaReply } from '../src/ai.js';
import { voiceIncoming, voiceTurn } from '../src/twilio/voice.js';

const savedFraction = config.talkBudgetFraction;
const savedKey = config.geminiApiKey;
afterEach(() => { config.talkBudgetFraction = savedFraction; config.geminiApiKey = savedKey; });

describe('talkBudgetMinutes()', () => {
  it('maps plans to 20% of quota (2 / 10 / 10)', () => {
    assert.equal(talkBudgetMinutes({ plan: 'starter-20' }), 2);
    assert.equal(talkBudgetMinutes({ plan: 'plus-100' }), 10);
    assert.equal(talkBudgetMinutes({ plan: 'family-149' }), 10);
  });

  it('fails closed to the smallest plan for unknown members', () => {
    assert.equal(talkBudgetMinutes(null), 2);
    assert.equal(talkBudgetMinutes({ plan: 'nope' }), 2);
  });

  it('returns Infinity when the fraction is 0 (disabled)', () => {
    config.talkBudgetFraction = 0;
    assert.equal(talkBudgetMinutes({ plan: 'starter-20' }), Infinity);
  });
});

describe('shouldEndNow() budget rule', () => {
  const unsure = { verdict: 'UNSURE', confidence: 0.5 };
  it('ends when elapsed time reaches the budget', () => {
    assert.equal(shouldEndNow({ verdict: unsure, turnCount: 1, elapsedMs: 120000, budgetMinutes: 2 }), true);
    assert.equal(shouldEndNow({ verdict: unsure, turnCount: 1, elapsedMs: 119999, budgetMinutes: 2 }), false);
  });

  it('keeps old behavior when budget args are absent', () => {
    assert.equal(shouldEndNow({ verdict: unsure, turnCount: config.maxTurnsPerCall }), true);
    assert.equal(shouldEndNow({ verdict: unsure, turnCount: 1 }), false);
    assert.equal(shouldEndNow({ verdict: { verdict: 'SCAM', confidence: 0.95 }, turnCount: 2 }), true);
  });
});

describe('personaReply() wrap-up mode', () => {
  it('asks only for a callback number on the last stretch (rules)', async () => {
    config.geminiApiKey = ''; // force deterministic rules mode
    const r = await personaReply('caller: สวัสดีครับ', 9, { turnsLeft: 1 });
    assert.equal(r.engine, 'rules');
    assert.match(r.text, /เบอร์ติดต่อกลับ/);
  });

  it('asks name+org+callback together on the first fallback', async () => {
    config.geminiApiKey = '';
    const r = await personaReply('caller: สวัสดีครับ', 0, { turnsLeft: 12 });
    assert.match(r.text, /ชื่อ.*หน่วยงาน.*เบอร์ติดต่อกลับ/);
  });
});

describe('real phone loop: budget cut still concludes', () => {
  const AI = '+6621000988'; // dedicated test number (never the demo seed)
  const OWNER = '+6681000988';
  addMember({ ownerPhone: OWNER, aiNumber: AI }); // starter-20 → 2min budget

  const req = (body, query = {}) => ({ body, query, headers: {}, protocol: 'https', get: () => 'test.local' });
  const res = () => {
    const r = { statusCode: 200, ctype: '', payload: '' };
    r.status = (c) => { r.statusCode = c; return r; };
    r.type = (t) => { r.ctype = t; return r; };
    r.send = (p) => { r.payload = String(p); return r; };
    return r;
  };
  const startCall = () => {
    const r = res();
    voiceIncoming(req({ To: AI, From: '+6681300001', ForwardedFrom: '' }), r);
    return /callId=([^"&]+)/.exec(r.payload)[1];
  };

  it('fresh call continues gathering', async () => {
    const callId = startCall();
    const t = res();
    await voiceTurn(req({ SpeechResult: 'สวัสดีครับ มีเรื่องสอบถาม' }, { callId }), t);
    assert.match(t.payload, /<Gather/);
  });

  it('over-budget call hangs up with a closing line (verdict kept)', async () => {
    const callId = startCall();
    getCall(callId).startedAt = new Date(Date.now() - 3 * 60000).toISOString(); // 3min > 2min budget
    const t = res();
    await voiceTurn(req({ SpeechResult: 'สวัสดีครับ มีเรื่องสอบถาม' }, { callId }), t);
    assert.match(t.payload, /<Hangup/);
    assert.doesNotMatch(t.payload, /<Gather/);
    const call = getCall(callId);
    assert.ok(call.endedAt);
    assert.ok(['SCAM', 'LEGIT', 'UNSURE'].includes(call.verdict?.verdict));
  });
});
