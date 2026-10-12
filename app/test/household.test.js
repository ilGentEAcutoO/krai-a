// Central-number households (IDENTIFY_MODE=B): one shared AI number per
// country, protected people verified by OTP on their own phone, and the
// pre-answer gate that only lets forwarded calls from registered protected
// numbers (or a protected person calling in) through. Everything else is
// rejected unanswered ($0).
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { addMember, cancelMember, reactivateMember, listMembers, addWatcher, addWhitelist, PLANS } from '../src/store.js';
import { centralStatus, forwardingCodes, toLocalNumber } from '../src/numbers.js';
import {
  toE164, parseDiversion, protectedOf, findProtected, requestProtected, confirmProtected,
  addSelfProtected, removeProtected, resolveIncoming, markForwardingVerified, provisionMember,
  joinWaitlist, linkWatcherLine, alertRecipients, publicHousehold, pruneProtected, PROTECT_TTL_MS,
  allowAnswer, ANSWER_CAPS, withdrawProtected,
} from '../src/household.js';

const savedCentral = process.env.CENTRAL_NUMBER_TH;
afterEach(() => {
  if (savedCentral === undefined) delete process.env.CENTRAL_NUMBER_TH;
  else process.env.CENTRAL_NUMBER_TH = savedCentral;
});

let seq = 0;
const phone = () => { seq += 1; return `+6689${String(700000 + seq).padStart(7, '0')}`; };
// Plan ids/limits come from the PLANS table (pricing changes without test edits).
const FAMILY = Object.keys(PLANS).find((id) => id.startsWith('family'));
const SOLO = Object.keys(PLANS).find((id) => PLANS[id].numbers === 1);
const household = (plan = FAMILY) => {
  const m = addMember({ ownerPhone: phone(), aiNumber: '', plan });
  m.protected = [];
  return m;
};
const protect = (m, p, label = 'mother') => {
  const r = requestProtected(m, { phone: p, label });
  assert.equal(r.ok, true, r.error);
  return confirmProtected(m, p);
};

describe('phone normalisation', () => {
  it('normalises Thai formats to E.164', () => {
    assert.equal(toE164('0812345678'), '+66812345678');
    assert.equal(toE164('081-234-5678'), '+66812345678');
    assert.equal(toE164('+66812345678'), '+66812345678');
    assert.equal(toE164('66812345678'), '+66812345678');
    assert.equal(toE164('sip:+66812345678@carrier.example'), '+66812345678');
    assert.equal(toE164(''), null);
    assert.equal(toE164('anonymous'), null);
  });

  it('parses a SIP Diversion header', () => {
    assert.equal(parseDiversion('<sip:+66812345678@pbx.example>;reason=unconditional'), '+66812345678');
    assert.equal(parseDiversion('<tel:0812345678>;reason=no-answer'), '+66812345678');
    assert.equal(parseDiversion(''), null);
  });

  it('formats numbers the Thai way (local display)', () => {
    assert.equal(toLocalNumber('+66812345678'), '0812345678');
    assert.equal(toLocalNumber('+6621000142'), '021000142');
  });
});

describe('central number', () => {
  it('no central number configured = waitlist (no code handed out)', () => {
    delete process.env.CENTRAL_NUMBER_TH;
    const c = centralStatus('TH');
    assert.equal(c.state, 'waitlist');
    assert.equal(c.number, '');
  });

  it('a configured Thai number is live', () => {
    process.env.CENTRAL_NUMBER_TH = '+6621000142';
    assert.deepEqual(
      { state: centralStatus('TH').state, number: centralStatus('TH').number },
      { state: 'live', number: '+6621000142' },
    );
  });

  it('a non-Thai number for TH is refused (forwarding abroad bills the owner IDD)', () => {
    process.env.CENTRAL_NUMBER_TH = '+14155550100';
    assert.equal(centralStatus('TH').state, 'waitlist');
  });

  it('other countries are coming soon until their number exists', () => {
    assert.equal(centralStatus('VN').state, 'coming-soon');
  });

  it('builds forwarding codes in local format (all / no-answer / busy / cancel)', () => {
    const f = forwardingCodes('+6621000142');
    assert.equal(f.all, '**21*021000142#');
    assert.equal(f.allTel, 'tel:**21*021000142%23');
    assert.equal(f.noAnswer, '**61*021000142#');
    assert.equal(f.busy, '**67*021000142#');
    assert.equal(f.cancel, '##002#');
    assert.equal(f.cancelTel, 'tel:%23%23002%23');
  });
});

describe('provisioning (signup)', () => {
  it('mode B + no central number: account works, interest recorded, no code', async () => {
    delete process.env.CENTRAL_NUMBER_TH;
    const r = await provisionMember({ ownerPhone: phone(), plan: SOLO, mode: 'B' });
    assert.equal(r.ok, true);
    assert.equal(r.member.aiNumber, '');
    assert.deepEqual(r.member.protected, []);
    assert.equal(r.member.waitlist.country, 'TH');
    assert.equal(r.central.state, 'waitlist');
  });

  it('mode B households sharing the central number never overwrite each other', async () => {
    process.env.CENTRAL_NUMBER_TH = '+6621000142';
    const a = await provisionMember({ ownerPhone: phone(), mode: 'B' });
    const b = await provisionMember({ ownerPhone: phone(), mode: 'B' });
    assert.equal(a.member.aiNumber, '+6621000142');
    assert.equal(a.member.waitlist, null);
    const ids = listMembers().map((m) => m.id);
    assert.ok(ids.includes(a.member.id) && ids.includes(b.member.id));
  });

  it('the free trial runs on the Family plan, with limits from the plan table', async () => {
    const r = await provisionMember({ ownerPhone: phone(), plan: SOLO, mode: 'B' });
    assert.ok(r.member.plan.startsWith('family'));
    assert.equal(publicHousehold(r.member).protectedMax, PLANS[r.member.plan].numbers);
    const hh = publicHousehold(r.member);
    assert.equal(hh.watchersMax, PLANS[r.member.plan].watchers); // null = unlimited
    assert.equal(hh.watchersUnlimited, PLANS[r.member.plan].watchers === null);
  });

  it('records the notify channel for the waitlist', () => {
    const m = household();
    joinWaitlist(m, { channel: 'line' });
    assert.equal(m.waitlist.channel, 'line');
    joinWaitlist(m, { channel: 'fax' });
    assert.equal(m.waitlist.channel, 'sms');
  });
});

describe('protected people', () => {
  it('legacy members protect their own phone', () => {
    const m = addMember({ ownerPhone: phone(), aiNumber: '' });
    assert.equal(protectedOf(m)[0].phone, m.ownerPhone);
    assert.equal(protectedOf(m)[0].label, 'self');
    assert.equal(protectedOf(m)[0].forwardingVerifiedAt, null);
  });

  it('adds a person only after the OTP on their phone (pending until then)', () => {
    const m = household();
    const mom = phone();
    const r = requestProtected(m, { phone: mom, label: 'mother' });
    assert.equal(r.ok, true);
    assert.equal(protectedOf(m).length, 0);
    assert.equal(m.pendingProtected.length, 1);
    const list = confirmProtected(m, mom);
    assert.equal(list.length, 1);
    assert.equal(list[0].label, 'mother');
    assert.ok(list[0].verifiedAt);
    assert.equal(m.pendingProtected.length, 0);
  });

  it('caps protected people at the plan seat count', () => {
    const m = household(SOLO);
    protect(m, phone());
    const r = requestProtected(m, { phone: phone(), label: 'father' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'plan-limit');
    assert.equal(r.max, PLANS[SOLO].numbers);
  });

  it('a phone can be protected by one household only', () => {
    const a = household();
    const b = household();
    const mom = phone();
    protect(a, mom);
    assert.equal(requestProtected(b, { phone: mom, label: 'mother' }).error, 'protected-elsewhere');
    assert.equal(requestProtected(a, { phone: mom, label: 'mother' }).error, 'already-protected');
  });

  it('protects the account phone itself without another OTP', () => {
    const m = household();
    const list = addSelfProtected(m);
    assert.equal(list[0].phone, m.ownerPhone);
    assert.equal(list[0].label, 'self');
  });

  it('removes a protected person and frees the seat', () => {
    const m = household(SOLO);
    const mom = phone();
    protect(m, mom);
    removeProtected(m, mom);
    assert.equal(protectedOf(m).length, 0);
    assert.equal(findProtected(mom), null);
  });

  it('drops pending requests after the OTP window', () => {
    const m = household();
    requestProtected(m, { phone: phone(), label: 'child' });
    pruneProtected(m, Date.now() + PROTECT_TTL_MS + 1000);
    assert.equal(m.pendingProtected.length, 0);
  });
});

describe('gate: who gets answered (mode B)', () => {
  it('gate answers a call forwarded from a protected number', () => {
    const m = household();
    const mom = phone();
    protect(m, mom);
    const g = resolveIncoming({ to: '+6621000142', from: '+66811110001', forwardedFrom: mom, mode: 'B' });
    assert.equal(g.member?.id, m.id);
    assert.equal(g.via, 'forwarded');
    assert.equal(g.protectedPhone, mom);
  });

  it('gate reads the forwarder from a SIP Diversion header too', () => {
    const m = household();
    const dad = phone();
    protect(m, dad, 'father');
    const g = resolveIncoming({ from: '+66811110002', diversion: `<sip:${dad}@pbx>;reason=no-answer`, mode: 'B' });
    assert.equal(g.member?.id, m.id);
  });

  it('gate rejects a call forwarded from an unregistered number', () => {
    const g = resolveIncoming({ from: '+66811110003', forwardedFrom: '+66899999999', mode: 'B' });
    assert.equal(g.member, null);
    assert.equal(g.reason, 'not-protected');
  });

  it('gate rejects a forward from a phone still pending OTP', () => {
    const m = household();
    const kid = phone();
    requestProtected(m, { phone: kid, label: 'child' });
    assert.equal(resolveIncoming({ from: '+66811110004', forwardedFrom: kid, mode: 'B' }).member, null);
  });

  it('gate answers a protected person calling the central number directly', () => {
    const m = household();
    const mom = phone();
    protect(m, mom);
    const g = resolveIncoming({ from: mom, forwardedFrom: '', mode: 'B' });
    assert.equal(g.member?.id, m.id);
    assert.equal(g.via, 'member-call');
  });

  it('gate rejects a direct call from a stranger', () => {
    const g = resolveIncoming({ from: '+66811110005', forwardedFrom: '', mode: 'B' });
    assert.equal(g.member, null);
    assert.equal(g.reason, 'not-forwarded');
  });

  it('gate rejects forwards for a cancelled household', () => {
    const m = household();
    const mom = phone();
    protect(m, mom);
    cancelMember(m.id);
    const g = resolveIncoming({ from: '+66811110006', forwardedFrom: mom, mode: 'B' });
    assert.equal(g.member, null);
    assert.equal(g.reason, 'inactive');
    reactivateMember(m.id);
  });

  it('first real forwarded call stamps forwardingVerifiedAt once', () => {
    const m = household();
    const mom = phone();
    protect(m, mom);
    assert.equal(markForwardingVerified(m, mom, '2026-10-12T10:00:00.000Z'), true);
    assert.equal(markForwardingVerified(m, mom, '2026-10-13T10:00:00.000Z'), false);
    assert.equal(protectedOf(m)[0].forwardingVerifiedAt, '2026-10-12T10:00:00.000Z');
    assert.equal(m.forwardingVerifiedAt, '2026-10-12T10:00:00.000Z');
    assert.equal(m.forwardingConfirmed, true);
  });
});

describe('alerts and privacy', () => {
  it('watchers who linked LINE get alerts; unlinked watchers do not', () => {
    const m = household();
    m.lineUserId = 'Uowner';
    const w1 = phone();
    const w2 = phone();
    addWatcher(m.id, w1);
    addWatcher(m.id, w2);
    assert.equal(linkWatcherLine(w1, 'Uwatcher1'), 1);
    assert.deepEqual(alertRecipients(m, ''), ['Uowner', 'Uwatcher1']);
  });

  it('a removed watcher stops getting alerts', () => {
    const m = household();
    m.lineUserId = 'Uowner2';
    const w = phone();
    addWatcher(m.id, w);
    linkWatcherLine(w, 'Uwatcher2');
    m.familyWatchers = [];
    assert.deepEqual(alertRecipients(m, ''), ['Uowner2']);
  });

  it('safe words never leave the server in plaintext', () => {
    const m = household();
    addWhitelist(m.id, { phone: phone(), label: 'aunt', safeWord: 'mango' });
    const pub = publicHousehold(m);
    assert.equal(JSON.stringify(pub).includes('mango'), false);
    assert.equal(pub.whitelisted[0].hasSafeWord, true);
  });
});

describe('answer caps (spoofed caller ID / flood drain)', () => {
  it('caps calls answered as "a protected person calling in" per phone per day', () => {
    const m = household();
    const mom = phone();
    protect(m, mom);
    const now = Date.parse('2026-10-12T03:00:00Z');
    for (let i = 0; i < ANSWER_CAPS.memberCallPerDay; i += 1) {
      assert.equal(allowAnswer(m, { from: mom, protectedPhone: mom, via: 'member-call' }, now).ok, true);
    }
    const over = allowAnswer(m, { from: mom, protectedPhone: mom, via: 'member-call' }, now);
    assert.equal(over.ok, false);
    assert.equal(over.reason, 'member-call-cap');
    assert.equal(allowAnswer(m, { from: mom, protectedPhone: mom, via: 'member-call' }, now + 86400000).ok, true); // next day
  });

  it('caps answered forwards from one caller to one protected phone per day', () => {
    const m = household();
    const mom = phone();
    protect(m, mom);
    const now = Date.parse('2026-10-12T05:00:00Z');
    const caller = '+66811112222';
    for (let i = 0; i < ANSWER_CAPS.perCallerPerDay; i += 1) {
      assert.equal(allowAnswer(m, { from: caller, protectedPhone: mom, via: 'forwarded' }, now).ok, true);
    }
    assert.equal(allowAnswer(m, { from: caller, protectedPhone: mom, via: 'forwarded' }, now).reason, 'caller-cap');
    assert.equal(allowAnswer(m, { from: '+66811113333', protectedPhone: mom, via: 'forwarded' }, now).ok, true); // other callers unaffected
  });
});

describe('consent withdrawal', () => {
  it('removes the phone from its household and reports who to tell', () => {
    const m = household();
    const mom = phone();
    protect(m, mom);
    const r = withdrawProtected(mom);
    assert.equal(r.withdrawn, true);
    assert.equal(r.member.id, m.id);
    assert.equal(findProtected(mom), null);
  });

  it('also drops a pending (not yet consented) request', () => {
    const m = household();
    const kid = phone();
    requestProtected(m, { phone: kid, label: 'child' });
    assert.equal(withdrawProtected(kid).withdrawn, true);
    assert.equal(m.pendingProtected.length, 0);
  });

  it('records the withdrawal so the payer sees who left (no code, just label + when)', () => {
    const m = household();
    const mom = phone();
    protect(m, mom);
    withdrawProtected(mom);
    const w = publicHousehold(m).withdrawn;
    assert.equal(w.length, 1);
    assert.equal(w[0].label, 'mother');
    assert.equal(w[0].phone, mom);
    assert.ok(w[0].at);
  });

  it('is a no-op for a phone nobody protects', () => {
    assert.equal(withdrawProtected('+66899990000').withdrawn, false);
  });
});
