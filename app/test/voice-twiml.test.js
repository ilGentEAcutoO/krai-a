// Real phone voice: TwiML may only use allowlisted Thai voices (Polly has no
// Thai voice — Polly.Tiamat silently failed), fixed lines <Play> pre-rendered
// clips by absolute URL only while their text still matches, and the
// no-speech redirect URL must keep callId intact.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { addMember, getCall } from '../src/store.js';
import { voiceIncoming, voiceTurn, ALLOWED_VOICES, PHONE_LINES } from '../src/twilio/voice.js';
import { personaReply } from '../src/ai.js';

// Legacy per-household-number flow (identify by To): pin mode A so the
// suite doesn't depend on IDENTIFY_MODE in .env (B is the default now).
config.identifyMode = 'A';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const M = addMember({ ownerPhone: '+66810007701', aiNumber: '+66210007701', plan: 'family-149', counted: false });

function fakeReqRes({ body = {}, query = {} } = {}) {
  const req = { body, query, headers: { 'x-forwarded-proto': 'https' }, protocol: 'https', get: () => 'krai-a.test' };
  const res = { out: '', type() { return this; }, send(x) { this.out = String(x); return this; }, status() { return this; } };
  return { req, res };
}

function assertVoices(xml) {
  const voices = [...xml.matchAll(/voice="([^"]+)"/g)].map((m) => m[1]);
  for (const v of voices) assert.ok(ALLOWED_VOICES.has(v), `voice not allowlisted: ${v}`);
  assert.doesNotMatch(xml, /Polly\./);
  for (const m of xml.matchAll(/<Say ([^>]*)>/g)) assert.match(m[1], /language="th-TH"/);
  for (const m of xml.matchAll(/<Play>([^<]+)<\/Play>/g)) {
    assert.match(m[1], /^https:\/\//, 'Play URL must be absolute');
    const rel = new URL(m[1].replace(/&amp;/g, '&')).pathname;
    assert.ok(fs.existsSync(path.join(PUBLIC, rel)), `missing clip ${rel}`);
  }
}

describe('Twilio TwiML voice', () => {
  // Offline: no Gemini, no LINE push, permissive gate.
  const saved = { key: config.geminiApiKey, base: config.publicBaseUrl, allow: config.forwardAllowlist, notify: config.notifyAdapters };
  before(() => { config.geminiApiKey = ''; config.publicBaseUrl = ''; config.forwardAllowlist = []; config.notifyAdapters = ['console']; });
  after(() => Object.assign(config, { geminiApiKey: saved.key, publicBaseUrl: saved.base, forwardAllowlist: saved.allow, notifyAdapters: saved.notify }));

  it('greeting uses only allowlisted voices or pre-rendered clips', () => {
    const { req, res } = fakeReqRes({ body: { To: M.aiNumber, From: '+66819997701' } });
    voiceIncoming(req, res);
    assert.match(res.out, /<Gather [^>]*input="speech"/);
    assertVoices(res.out);
  });

  it('no-speech redirect keeps callId and appends empty=1 as a separate param', () => {
    const { req, res } = fakeReqRes({ body: { To: M.aiNumber, From: '+66819997702' } });
    voiceIncoming(req, res);
    const redirect = /<Redirect>([^<]+)<\/Redirect>/.exec(res.out)[1].replace(/&amp;/g, '&');
    const u = new URL(redirect);
    assert.match(u.searchParams.get('callId'), /^call_[0-9a-f]{32}$/);
    assert.equal(u.searchParams.get('empty'), '1');
  });

  it('silent first turn closes politely without judging', async () => {
    const { req, res } = fakeReqRes({ body: { To: M.aiNumber, From: '+66819997703' } });
    voiceIncoming(req, res);
    const callId = new URL(/<Redirect>([^<]+)<\/Redirect>/.exec(res.out)[1].replace(/&amp;/g, '&')).searchParams.get('callId');
    const t = fakeReqRes({ body: {}, query: { callId, empty: '1' } });
    await voiceTurn(t.req, t.res);
    assert.match(t.res.out, /<Hangup\/>/);
    assertVoices(t.res.out);
    assert.ok(getCall(callId).endedAt);
    assert.equal(getCall(callId).verdict.engine, 'none'); // settled with a canned UNSURE, never judged
  });

  it('dynamic replies and closings use allowlisted voices', async () => {
    const { req, res } = fakeReqRes({ body: { To: M.aiNumber, From: '+66819997704' } });
    voiceIncoming(req, res);
    const callId = new URL(/<Redirect>([^<]+)<\/Redirect>/.exec(res.out)[1].replace(/&amp;/g, '&')).searchParams.get('callId');
    const t1 = fakeReqRes({ body: { SpeechResult: 'สวัสดีครับ โทรจากร้านซ่อมแอร์ จะนัดเข้าไปล้างแอร์ครับ' }, query: { callId } });
    await voiceTurn(t1.req, t1.res);
    assertVoices(t1.res.out);
    const t2 = fakeReqRes({ body: { SpeechResult: 'โอนเงินมาเดี๋ยวนี้ แล้วบอกรหัส OTP ด้วย' }, query: { callId } });
    await voiceTurn(t2.req, t2.res);
    assert.match(t2.res.out, /<Hangup\/>/);
    assertVoices(t2.res.out);
  });

  it('first caller line gets the first persona reply (0-based turn index)', async () => {
    const { req, res } = fakeReqRes({ body: { To: M.aiNumber, From: '+66819997705' } });
    voiceIncoming(req, res);
    const callId = new URL(/<Redirect>([^<]+)<\/Redirect>/.exec(res.out)[1].replace(/&amp;/g, '&')).searchParams.get('callId');
    const t = fakeReqRes({ body: { SpeechResult: 'สวัสดีครับ' }, query: { callId } });
    await voiceTurn(t.req, t.res);
    const call = getCall(callId);
    const expected = await personaReply(call.turns.slice(0, -1).map((x) => `${x.role}: ${x.text}`).join('\n'), 0, { turnsLeft: config.maxTurnsPerCall - 1 });
    assert.equal(call.turns.at(-1).text, expected.text);
  });

  it('a household over its hard monthly cap is rejected unanswered ($0)', () => {
    const saved = config.maxMinutesPerHousePerMonth;
    config.maxMinutesPerHousePerMonth = 0;
    try {
      const { req, res } = fakeReqRes({ body: { To: M.aiNumber, From: '+66819997706' } });
      voiceIncoming(req, res);
      assert.match(res.out, /<Reject/);
      assert.doesNotMatch(res.out, /<Say|<Play/);
    } finally {
      config.maxMinutesPerHousePerMonth = saved;
    }
  });

  it('a pre-rendered clip plays only while its text matches', () => {
    const file = path.join(PUBLIC, 'voice-audio', 'prompts.json');
    if (!fs.existsSync(file)) return; // clips not rendered yet: <Say> path covered above
    const { prompts } = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(prompts.noSpeech?.text, PHONE_LINES.noSpeech);
    assert.equal(prompts.gather?.text, PHONE_LINES.gather);
    for (const p of Object.values(prompts)) assert.ok(fs.existsSync(path.join(PUBLIC, p.file)), p.file);
  });
});
