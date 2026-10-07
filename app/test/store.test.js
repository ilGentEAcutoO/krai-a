// Member-gate tests: mode A resolves by To, mode B by ForwardedFrom,
// strangers are rejected before any AI cost.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addMember, findMember } from '../src/store.js';

addMember({ ownerPhone: '+66810000001', aiNumber: '+6621000142' });

describe('member gate', () => {
  it('mode A: resolves household by dialled AI number', () => {
    const { member, reason } = findMember({ to: '+6621000142', forwardedFrom: '', mode: 'A' });
    assert.equal(reason, 'ok');
    assert.equal(member.ownerPhone, '+66810000001');
  });

  it('mode A: rejects unknown numbers', () => {
    const { member, reason } = findMember({ to: '+66999999999', forwardedFrom: '', mode: 'A' });
    assert.equal(member, null);
    assert.equal(reason, 'unknown-number');
  });

  it('mode B: resolves household by ForwardedFrom', () => {
    const { member, reason } = findMember({ to: '+6621000000', forwardedFrom: '+66810000001', mode: 'B' });
    assert.equal(reason, 'ok');
    assert.ok(member);
  });

  it('mode B: rejects direct dials with no ForwardedFrom', () => {
    const { member, reason } = findMember({ to: '+6621000000', forwardedFrom: '', mode: 'B' });
    assert.equal(member, null);
    assert.equal(reason, 'missing-forwarded-from');
  });
});
