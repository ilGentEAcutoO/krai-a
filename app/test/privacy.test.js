// PDPA tab-3 compliance: recording notice, per-household reputation (no
// cross-user blacklist), suspicion wording, owner-only alerts, evidence
// export, erasure + retention windows.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { config } from '../src/config.js';
import {
  addMember, getMemberByOwner, createCall, getCall, addTurn, setVerdict, endCall,
  deleteCall, purgeCalls, setReputation, getReputation, clearReputation,
} from '../src/store.js';
import { voiceIncoming, voiceTurn } from '../src/twilio/voice.js';
import { buildMessage, notifyOwner } from '../src/notify/index.js';
import { buildEvidenceBundle, privacyNoticeTh } from '../src/evidence.js';

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
  it('first answer announces recording once; later turns do not repeat', async () => {
    const r = res();
    voiceIncoming(req({ To: AI_A, From: '+6681300001', ForwardedFrom: '' }), r);
    assert.match(r.payload, /บันทึกเสียง/);
    const callId = /callId=([^"&]+)/.exec(r.payload)[1];
    const t = res();
    await voiceTurn(req({ SpeechResult: 'สวัสดีครับ' }, { callId }), t);
    assert.doesNotMatch(t.payload, /บันทึกเสียง/);
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

  it('privacy notice discloses basis + retention windows', () => {
    const t = privacyNoticeTh();
    assert.match(t, /legitimate interests/);
    assert.ok(t.includes(String(config.retentionLegitDays)));
    assert.ok(t.includes(String(config.retentionScamDays)));
  });
});
