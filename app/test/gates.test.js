// Pre-answer gates: Gate 1 (forwarder allowlist) + Gate 2 (caller reputation).
// Rejects must be <Reject/> (unanswered = $0), never Say+Hangup (billed).
// Gate 2 is per-household: a SCAM flag from one member never affects another
// (PDPA: no cross-user blacklist).
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { addMember, getMemberByOwner, countReject, setReputation, getReputation, clearReputation } from '../src/store.js';
import { voiceIncoming, voiceTurn } from '../src/twilio/voice.js';

const AI = '+6621000999'; // dedicated test number (never the demo seed)
const OWNER = '+6681000999';
addMember({ ownerPhone: OWNER, aiNumber: AI });
const MID = getMemberByOwner(OWNER).id;

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

const savedAllowlist = [...config.forwardAllowlist];
afterEach(() => { config.forwardAllowlist = [...savedAllowlist]; });

describe('gate 1: forwarder allowlist', () => {
  it('empty allowlist = permissive (direct dial gathers)', () => {
    config.forwardAllowlist = [];
    const r = res();
    voiceIncoming(req({ To: AI, From: '+6681100001', ForwardedFrom: '' }), r);
    assert.match(r.payload, /<Gather/);
  });

  it('allowlisted forwarder passes', () => {
    config.forwardAllowlist = [OWNER];
    const r = res();
    voiceIncoming(req({ To: AI, From: '+6681100002', ForwardedFrom: OWNER }), r);
    assert.match(r.payload, /<Gather/);
  });

  it('non-allowlisted forwarder gets <Reject/> ($0)', () => {
    config.forwardAllowlist = [OWNER];
    const r = res();
    voiceIncoming(req({ To: AI, From: '+6681100003', ForwardedFrom: '+66999999999' }), r);
    assert.match(r.payload, /<Reject/);
    assert.doesNotMatch(r.payload, /<Say/);
  });

  it('missing ForwardedFrom with allowlist set gets <Reject/>', () => {
    config.forwardAllowlist = [OWNER];
    const r = res();
    voiceIncoming(req({ To: AI, From: '+6681100004', ForwardedFrom: '' }), r);
    assert.match(r.payload, /<Reject/);
  });
});

describe('gate 2: caller reputation', () => {
  it('known SCAM caller gets <Reject/> without answering', () => {
    const from = '+6681200001';
    setReputation(MID, from, { verdict: 'SCAM', confidence: 0.95, signals: ['urgency'] }, 60);
    const r = res();
    voiceIncoming(req({ To: AI, From: from, ForwardedFrom: '' }), r);
    assert.match(r.payload, /<Reject/);
    assert.doesNotMatch(r.payload, /<Gather/);
    clearReputation(MID, from);
  });

  it('low-confidence SCAM still screens (below threshold gathers)', () => {
    const from = '+6681200002';
    setReputation(MID, from, { verdict: 'SCAM', confidence: 0.5, signals: [] }, 60);
    const r = res();
    voiceIncoming(req({ To: AI, From: from, ForwardedFrom: '' }), r);
    assert.match(r.payload, /<Gather/);
    clearReputation(MID, from);
  });

  it('expired reputation is ignored', () => {
    const from = '+6681200003';
    setReputation(MID, from, { verdict: 'SCAM', confidence: 0.95, signals: [] }, -1); // already expired
    assert.equal(getReputation(MID, from), null);
    const r = res();
    voiceIncoming(req({ To: AI, From: from, ForwardedFrom: '' }), r);
    assert.match(r.payload, /<Gather/);
  });

  it('LEGIT verdict clears a prior SCAM flag', () => {
    const from = '+6681200004';
    setReputation(MID, from, { verdict: 'SCAM', confidence: 0.95, signals: [] }, 60);
    setReputation(MID, from, { verdict: 'LEGIT', confidence: 0.9, signals: [] }, 60);
    const r = res();
    voiceIncoming(req({ To: AI, From: from, ForwardedFrom: '' }), r);
    assert.match(r.payload, /<Gather/);
    clearReputation(MID, from);
  });

  it('over-daily-cap caller gets <Reject/> (not billed Say+Hangup)', () => {
    const from = '+6681200005';
    for (let i = 0; i < 20; i++) countReject(from);
    const r = res();
    voiceIncoming(req({ To: AI, From: from, ForwardedFrom: '' }), r);
    assert.match(r.payload, /<Reject/);
    assert.doesNotMatch(r.payload, /<Say/);
  });

  it('full loop: SCAM verdict records reputation, repeat call is $0 rejected', async () => {
    const from = '+6681200006';
    const r1 = res();
    voiceIncoming(req({ To: AI, From: from, ForwardedFrom: '' }), r1);
    const callId = /callId=([^"&]+)/.exec(r1.payload)[1];
    const t1 = res();
    await voiceTurn(req({ SpeechResult: 'สวัสดีครับ มีเรื่องสอบถาม' }, { callId }), t1);
    assert.match(t1.payload, /<Gather/);
    const t2 = res();
    await voiceTurn(req({ SpeechResult: 'รบกวนบอก otp ด้วยครับ' }, { callId }), t2);
    assert.match(t2.payload, /<Hangup/);
    assert.equal(getReputation(MID, from)?.verdict, 'SCAM');
    const r2 = res();
    voiceIncoming(req({ To: AI, From: from, ForwardedFrom: '' }), r2);
    assert.match(r2.payload, /<Reject/);
    clearReputation(MID, from);
  });
});
