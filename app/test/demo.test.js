// Lean demo loop (offline rules mode): web-session call -> verdict -> alert
// -> evidence export, with audit trail. No auth, no keys, no network.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  addMember, getMemberByOwner, createCall, getCall, addTurn,
  setVerdict, endCall, deleteCall,
} from '../src/store.js';
import { judge, auditDecision } from '../src/verdict.js';
import { notifyOwner } from '../src/notify/index.js';
import { buildEvidenceBundle } from '../src/evidence.js';

addMember({ ownerPhone: '+66800000001', aiNumber: '+6620000001' });
const MID = getMemberByOwner('+66800000001').id;

describe('demo loop', () => {
  it('scam call ends with verdict + console alert + verifiable export', async () => {
    const call = createCall({ memberId: MID, callerPhone: '+6681311111', aiNumber: '+6620000001', source: 'demo' });
    addTurn(call.id, 'assistant', 'greeting');
    addTurn(call.id, 'caller', 'สวัสดีครับ ผมโทรจากธนาคาร มีเรื่องด่วน');
    addTurn(call.id, 'caller', 'รบกวนบอก otp ด้วยครับ');
    const verdict = await judge({ call: getCall(call.id), member: null, isWhitelistedCaller: false });
    assert.equal(verdict.verdict, 'SCAM');
    setVerdict(call.id, verdict);
    auditDecision(call, verdict);
    endCall(call.id);
    const notify = await notifyOwner({ call: getCall(call.id), member: { ownerPhone: '+66800000001', familyWatchers: [] }, verdict });
    assert.equal(notify.results.length, 1);
    assert.equal(notify.results[0].adapter, 'console');
    assert.match(notify.message.text, /สายต้องสงสัย/);
    const b = buildEvidenceBundle(getCall(call.id));
    const { sha256, ...rest } = b;
    assert.equal(sha256, createHash('sha256').update(JSON.stringify(rest)).digest('hex'));
    assert.equal(deleteCall(call.id), true);
  });

  it('legit call passes without errors', async () => {
    const call = createCall({ memberId: MID, callerPhone: '+6681322222', aiNumber: '+6620000001', source: 'demo' });
    addTurn(call.id, 'caller', 'สวัสดีค่ะ โทรจากโรงพยาบาล นัดหมายพรุ่งนี้ค่ะ');
    const verdict = await judge({ call: getCall(call.id), member: null, isWhitelistedCaller: false });
    assert.ok(['LEGIT', 'UNSURE'].includes(verdict.verdict));
    deleteCall(call.id);
  });
});
