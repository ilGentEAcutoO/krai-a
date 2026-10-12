// PDPA tab-3 compliance: recording notice, per-household reputation (no
// cross-user blacklist), suspicion wording, owner-only alerts, evidence
// export, erasure + retention windows.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import {
  addMember, getMemberByOwner, createCall, getCall, addTurn, setVerdict, endCall,
  deleteCall, purgeCalls, setReputation, getReputation, clearReputation,
} from '../src/store.js';
import { voiceIncoming, voiceTurn } from '../src/twilio/voice.js';
import { buildMessage, buildFlexMessage, notifyOwner } from '../src/notify/index.js';
import { buildEvidenceBundle, privacyNoticeTh } from '../src/evidence.js';

// Legacy per-household-number flow (identify by To): pin mode A so the
// suite doesn't depend on IDENTIFY_MODE in .env (B is the default now).
config.identifyMode = 'A';

const AI_A = '+6621000881'; const OWNER_A = '+6681000881';
const AI_B = '+6621000882'; const OWNER_B = '+6681000882';
addMember({ ownerPhone: OWNER_A, aiNumber: AI_A });
addMember({ ownerPhone: OWNER_B, aiNumber: AI_B });
const MID_A = getMemberByOwner(OWNER_A).id;
const MID_B = getMemberByOwner(OWNER_B).id;

function req(body, query = {}) {
  return { body, query, headers: {}, protocol: 'https', get: () => 'test.local' };
}
function res() {
  const r = { statusCode: 200, ctype: '', payload: '' };
  r.status = (c) => { r.statusCode = c; return r; };
  r.type = (t) => { r.ctype = t; return r; };
  r.send = (p) => { r.payload = String(p); return r; };
  return r;
}

const savedAdapters = [...config.notifyAdapters];
afterEach(() => { config.notifyAdapters = [...savedAdapters]; });

describe('recording notice', () => {
  // The notice is spoken either as <Say> text or as the pre-rendered clip
  // whose prompts.json text is exactly config.recordNotice.
  const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'voice-audio', 'prompts.json');
  const recordClip = () => {
    const { prompts = {} } = fs.existsSync(PROMPTS) ? JSON.parse(fs.readFileSync(PROMPTS, 'utf8')) : {};
    return Object.values(prompts).find((p) => p.text === config.recordNotice)?.file || null;
  };
  const announces = (xml) => xml.includes(config.recordNotice) || (recordClip() !== null && xml.includes(recordClip()));

  it('first answer announces recording once; later turns do not repeat', async () => {
    const r = res();
    voiceIncoming(req({ To: AI_A, From: '+6681300001', ForwardedFrom: '' }), r);
    assert.ok(announces(r.payload), r.payload);
    const callId = /callId=([^"&]+)/.exec(r.payload)[1];
    const t = res();
    await voiceTurn(req({ SpeechResult: 'สวัสดีครับ' }, { callId }), t);
    assert.ok(!announces(t.payload), t.payload);
  });
});

describe('per-household reputation (no cross-user blacklist)', () => {
  it("household A's SCAM flag does not reject household B", () => {
    const from = '+6681300002';
    setReputation(MID_A, from, { verdict: 'SCAM', confidence: 0.95, signals: ['urgency'] }, 60);
    const rb = res();
    voiceIncoming(req({ To: AI_B, From: from, ForwardedFrom: '' }), rb);
    assert.match(rb.payload, /<Gather/);
    const ra = res();
    voiceIncoming(req({ To: AI_A, From: from, ForwardedFrom: '' }), ra);
    assert.match(ra.payload, /<Reject/);
    assert.equal(getReputation(MID_B, from), null);
    clearReputation(MID_A, from);
  });

  it('appeal clears the flag immediately', () => {
    const from = '+6681300003';
    setReputation(MID_A, from, { verdict: 'SCAM', confidence: 0.95, signals: [] }, 60);
    assert.equal(clearReputation(MID_A, from), true);
    const r = res();
    voiceIncoming(req({ To: AI_A, From: from, ForwardedFrom: '' }), r);
    assert.match(r.payload, /<Gather/);
  });
});

describe('owner alert wording + recipients', () => {
  const call = { callerPhone: '+6681300004', turns: [{ role: 'caller', text: 'x' }], minutesBilled: 1 };
  const verdict = { verdict: 'SCAM', confidence: 0.95, engine: 'hard-rule', reason: 'r', reasonEn: 're' };

  it('uses suspicion wording, never a definitive label', () => {
    const { label } = buildMessage({ call, member: { familyWatchers: [] }, verdict });
    assert.equal(label, 'สายต้องสงสัย (ตัดสายแล้ว)');
  });

  it('notifies exactly one recipient (owner only)', async () => {
    config.notifyAdapters = ['console'];
    const { results } = await notifyOwner({
      call,
      member: { ownerPhone: OWNER_A, lineUserId: '', familyWatchers: ['+66819999999'] },
      verdict,
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].adapter, 'console');
    assert.equal(results[0].ok, true);
  });
});

describe('evidence export + erasure + retention', () => {
  it('export bundle verifies with its sha256', () => {
    const call = createCall({ memberId: MID_A, callerPhone: '+6681300005', aiNumber: AI_A, source: 'twilio' });
    addTurn(call.id, 'caller', 'โอนเงินด่วน');
    setVerdict(call.id, {
      verdict: 'SCAM', confidence: 0.95, engine: 'hard-rule', reason: 'r',
      reasonEn: 're', judgedAt: new Date().toISOString(), action: 'END_SCAM',
    });
    endCall(call.id);
    const b = buildEvidenceBundle(getCall(call.id));
    assert.equal(b.version, 1);
    assert.equal(b.call.callerPhone, '+6681300005');
    const { sha256, ...rest } = b;
    assert.equal(sha256, createHash('sha256').update(JSON.stringify(rest)).digest('hex'));
    deleteCall(call.id);
  });

  it('deleteCall erases the record', () => {
    const call = createCall({ memberId: MID_A, callerPhone: '+6681300006', aiNumber: AI_A, source: 'demo' });
    assert.equal(deleteCall(call.id), true);
    assert.equal(getCall(call.id), null);
    assert.equal(deleteCall('call_nope'), false);
  });

  it('purgeCalls deletes old LEGIT, keeps SCAM within window', () => {
    const old = Date.now() - 30 * 86400000;
    const legit = createCall({ memberId: MID_A, callerPhone: '+6681300007', aiNumber: AI_A, source: 'demo' });
    setVerdict(legit.id, { verdict: 'LEGIT', confidence: 0.9 });
    endCall(legit.id);
    legit.startedAt = new Date(old).toISOString();
    legit.endedAt = new Date(old).toISOString();
    const scam = createCall({ memberId: MID_A, callerPhone: '+6681300008', aiNumber: AI_A, source: 'demo' });
    setVerdict(scam.id, { verdict: 'SCAM', confidence: 0.95 });
    endCall(scam.id);
    scam.startedAt = new Date(old).toISOString();
    scam.endedAt = new Date(old).toISOString();
    const live = createCall({ memberId: MID_A, callerPhone: '+6681300009', aiNumber: AI_A, source: 'demo' });
    const n = purgeCalls({ LEGIT: 7, UNSURE: 90, SCAM: 365 });
    assert.equal(getCall(legit.id), null);
    assert.ok(getCall(scam.id));
    assert.ok(getCall(live.id)); // in-progress never purged
    assert.ok(n >= 1);
    deleteCall(scam.id);
    deleteCall(live.id);
  });

  it('privacy notice is accurate: transcripts not audio, watchers, AI processors, withdrawal', () => {
    const t = privacyNoticeTh();
    assert.doesNotMatch(t, /เสียง\/ข้อความ|คลิปเสียง|บันทึกเสียง/); // no audio is stored
    assert.match(t, /บทสนทนา/);
    assert.match(t, /ผู้ดูแล/); // family watchers receive alerts
    assert.match(t, /Gemini/);
    assert.match(t, /Jev/);
    assert.match(t, /withdraw/);
    assert.match(t, /แฮช/); // erased accounts keep only a one-way hash (trial re-use)
    assert.match(t, /12 เดือน/);
  });

  it('privacy notice discloses basis + retention windows', () => {
    const t = privacyNoticeTh();
    assert.match(t, /legitimate interests/);
    assert.ok(t.includes(String(config.retentionLegitDays)));
    assert.ok(t.includes(String(config.retentionScamDays)));
  });
});

describe('LINE flex alert', () => {
  const call = { callerPhone: '+6681300010', turns: [{ role: 'caller', text: 'x' }], minutesBilled: 2 };
  const member = { ownerPhone: OWNER_A, lineUserId: '', familyWatchers: [] };

  it('builds a bubble with verdict color + caller + reason', () => {
    const verdict = { verdict: 'SCAM', confidence: 0.95, engine: 'hard-rule', reason: 'r', reasonEn: 're' };
    const b = buildFlexMessage({ call, member, verdict });
    assert.equal(b.type, 'bubble');
    assert.equal(b.header.contents[0].color, '#E5484D');
    assert.match(b.header.contents[0].text, /สายต้องสงสัย/);
    assert.match(JSON.stringify(b.body.contents), /081300010/); // shown like the app, not raw E.164
    const legit = buildFlexMessage({ call, member, verdict: { ...verdict, verdict: 'LEGIT' } });
    assert.equal(legit.header.contents[0].color, '#0E9D80');
  });

  it('footer button appears only when public URL is set', () => {
    const verdict = { verdict: 'UNSURE', confidence: 0.5, engine: 'rules', reason: 'r' };
    const saved = config.publicBaseUrl;
    config.publicBaseUrl = '';
    assert.ok(!buildFlexMessage({ call, member, verdict }).footer.contents.some((c) => c.type === 'button'));
    config.publicBaseUrl = 'https://demo.example.com';
    const btn = buildFlexMessage({ call, member, verdict }).footer.contents.find((c) => c.type === 'button');
    assert.equal(btn.action.uri, 'https://demo.example.com/dashboard.html');
    config.publicBaseUrl = saved;
  });

  it('line adapter pushes flex with text altText', async () => {
    const verdict = { verdict: 'SCAM', confidence: 0.95, engine: 'hard-rule', reason: 'r', reasonEn: 're' };
    config.notifyAdapters = ['line'];
    const savedToken = config.lineChannelAccessToken;
    config.lineChannelAccessToken = 'test-token';
    const realFetch = global.fetch;
    let got = null;
    global.fetch = async (url, opts) => { got = { url, body: JSON.parse(opts.body) }; return { ok: true }; };
    try {
      // Only a LINE id the owner linked is pushed (no operator fallback).
      const { results } = await notifyOwner({ call, member: { ...member, lineUserId: 'Uowner_a' }, verdict });
      assert.equal(results[0].ok, true);
      const msg = got.body.messages[0];
      assert.equal(msg.type, 'flex');
      assert.equal(msg.contents.type, 'bubble');
      assert.match(msg.altText, /สายต้องสงสัย/);
    } finally {
      global.fetch = realFetch;
      config.lineChannelAccessToken = savedToken;
    }
  });
});
