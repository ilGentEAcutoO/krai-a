// Voice webhook under the central-number model (IDENTIFY_MODE=B): the
// pre-answer gate must <Reject/> (unanswered, $0) every call that is not
// forwarded from a registered protected number — never Say+Hangup, which
// answers the call and bills it. A forwarded call from a protected phone is
// screened and stamps forwardingVerifiedAt on that phone.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { addMember, cancelMember, reactivateMember, PLANS } from '../src/store.js';
// Plan ids/limits come from the PLANS table (pricing changes without test edits).
const FAMILY = Object.keys(PLANS).find((id) => id.startsWith('family'));
const SOLO = Object.keys(PLANS).find((id) => PLANS[id].numbers === 1);
import { requestProtected, confirmProtected, protectedOf, ANSWER_CAPS } from '../src/household.js';
import { voiceIncoming } from '../src/twilio/voice.js';

const CENTRAL = '+6621000777';
const OWNER = '+66892220001';
const MOM = '+66892220002';
const DAD = '+66892220003';
const m = addMember({ ownerPhone: OWNER, aiNumber: CENTRAL, plan: FAMILY });
m.protected = [];
requestProtected(m, { phone: MOM, label: 'mother' });
confirmProtected(m, MOM);

function req(body) {
  return { body, query: {}, headers: {}, protocol: 'https', get: () => 'test.local' };
}
function res() {
  const r = { statusCode: 200, ctype: '', payload: '' };
  r.status = (c) => { r.statusCode = c; return r; };
  r.type = (t) => { r.ctype = t; return r; };
  r.send = (p) => { r.payload = String(p); return r; };
  return r;
}

const saved = { mode: config.identifyMode, allow: [...config.forwardAllowlist] };
before(() => { config.identifyMode = 'B'; config.forwardAllowlist = []; });
after(() => { config.identifyMode = saved.mode; config.forwardAllowlist = saved.allow; });

describe('central number gate (voice webhook, mode B)', () => {
  it('rejects unanswered when the forwarder is not a protected number', () => {
    const r = res();
    voiceIncoming(req({ To: CENTRAL, From: '+66811230001', ForwardedFrom: '+66899990001' }), r);
    assert.match(r.payload, /<Reject/);
    assert.doesNotMatch(r.payload, /<Say/);
  });

  it('rejects unanswered when a stranger dials the central number directly', () => {
    const r = res();
    voiceIncoming(req({ To: CENTRAL, From: '+66811230002', ForwardedFrom: '' }), r);
    assert.match(r.payload, /<Reject/);
    assert.doesNotMatch(r.payload, /<Say/);
  });

  it('rejects a forward from a phone that never passed OTP', () => {
    requestProtected(m, { phone: DAD, label: 'father' }); // pending only
    const r = res();
    voiceIncoming(req({ To: CENTRAL, From: '+66811230003', ForwardedFrom: DAD }), r);
    assert.match(r.payload, /<Reject/);
  });

  it('screens a call forwarded from a protected phone and stamps forwardingVerifiedAt', () => {
    assert.equal(protectedOf(m).find((e) => e.phone === MOM).forwardingVerifiedAt, null);
    const r = res();
    voiceIncoming(req({ To: CENTRAL, From: '+66811230004', ForwardedFrom: '0892220002' }), r);
    assert.match(r.payload, /<Gather/);
    assert.ok(protectedOf(m).find((e) => e.phone === MOM).forwardingVerifiedAt);
    assert.ok(m.forwardingVerifiedAt);
  });

  it('screens a protected person calling in, without claiming forwarding works', () => {
    const fresh = addMember({ ownerPhone: '+66892220011', aiNumber: CENTRAL, plan: SOLO });
    fresh.protected = [];
    requestProtected(fresh, { phone: '+66892220012', label: 'mother' });
    confirmProtected(fresh, '+66892220012');
    const r = res();
    voiceIncoming(req({ To: CENTRAL, From: '+66892220012', ForwardedFrom: '' }), r);
    assert.match(r.payload, /<Gather/);
    assert.equal(protectedOf(fresh)[0].forwardingVerifiedAt, null);
  });

  it('answers a spoofed "protected person calling in" at most the daily cap, then rejects ($0)', async () => {
    const h = addMember({ ownerPhone: '+66892220021', aiNumber: CENTRAL, plan: SOLO });
    h.protected = [];
    requestProtected(h, { phone: '+66892220022', label: 'mother' });
    confirmProtected(h, '+66892220022');
    for (let i = 0; i < ANSWER_CAPS.memberCallPerDay; i += 1) {
      const ok = res();
      await voiceIncoming(req({ To: CENTRAL, From: '+66892220022', ForwardedFrom: '' }), ok);
      assert.match(ok.payload, /<Gather/);
    }
    const over = res();
    await voiceIncoming(req({ To: CENTRAL, From: '+66892220022', ForwardedFrom: '' }), over);
    assert.match(over.payload, /<Reject/);
    assert.doesNotMatch(over.payload, /<Say|<Play/);
  });

  it('caps answered forwards from one caller to one protected phone per day', async () => {
    const h = addMember({ ownerPhone: '+66892220031', aiNumber: CENTRAL, plan: SOLO });
    h.protected = [];
    requestProtected(h, { phone: '+66892220032', label: 'father' });
    confirmProtected(h, '+66892220032');
    const flood = '+66811239999';
    for (let i = 0; i < ANSWER_CAPS.perCallerPerDay; i += 1) {
      const ok = res();
      await voiceIncoming(req({ To: CENTRAL, From: flood, ForwardedFrom: '+66892220032' }), ok);
      assert.match(ok.payload, /<Gather/);
    }
    const over = res();
    await voiceIncoming(req({ To: CENTRAL, From: flood, ForwardedFrom: '+66892220032' }), over);
    assert.match(over.payload, /<Reject/);
    const other = res();
    await voiceIncoming(req({ To: CENTRAL, From: '+66811238888', ForwardedFrom: '+66892220032' }), other);
    assert.match(other.payload, /<Gather/); // other callers still get through
  });

  it('rejects unanswered when the household cancelled', () => {
    cancelMember(m.id);
    const r = res();
    voiceIncoming(req({ To: CENTRAL, From: '+66811230005', ForwardedFrom: MOM }), r);
    assert.match(r.payload, /<Reject/);
    assert.doesNotMatch(r.payload, /<Say/);
    reactivateMember(m.id);
  });
});
