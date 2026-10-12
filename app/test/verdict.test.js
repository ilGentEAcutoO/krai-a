// Verdict authority tests: hard rules fire without AI, the judge wrapper keeps
// the legacy verdict shape routes/twilio rely on, whitelist never blind-trusts.
// Under `node --test` the judge is offline (no network), so the AI path here
// is the deterministic rules fallback; src/judge is covered with mocked
// engines in judge.test.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { judge, shouldEndNow, auditDecision } from '../src/verdict.js';
import { closingLine } from '../src/ai.js';

const member = { id: 'm_1', whitelisted: [], familyWatchers: [] };
const mkCall = (callerLines) => ({
  id: 't1',
  turns: callerLines.flatMap((text) => [
    { role: 'assistant', text: 'สายนี้มีการบันทึกเพื่อความปลอดภัยค่ะ' },
    { role: 'caller', text },
  ]),
});

describe('judge()', () => {
  it('fires instant SCAM on explicit OTP demand (no AI cost)', async () => {
    const call = mkCall(['ผมจากธนาคารครับ รบกวนแจ้งรหัส OTP ที่ส่งไปให้หน่อยครับ']);
    const v = await judge({ call, member, isWhitelistedCaller: false });
    assert.equal(v.verdict, 'SCAM');
    assert.equal(v.engine, 'rule');
    assert.equal(v.action, 'END_SCAM');
  });

  it('fires instant SCAM on app-install + link demand', async () => {
    const call = mkCall(['โหลดแอปตามลิงก์ที่ผมส่งให้ก่อนนะครับ แล้วแจ้งรหัสยืนยัน']);
    const v = await judge({ call, member, isWhitelistedCaller: false });
    assert.equal(v.verdict, 'SCAM');
    assert.equal(v.action, 'END_SCAM');
  });

  it('detects full police script as SCAM via the offline rules fallback', async () => {
    const call = mkCall([
      'ผมร้อยเวรจาก สภ.เมือง คุณมีหมายเรียกคดีฟอกเงินนะครับ',
      'เรื่องนี้ห้ามบอกใครนะครับ แล้วโอนเงินมาตรวจสอบที่บัญชีกลาง',
    ]);
    const v = await judge({ call, member, isWhitelistedCaller: false });
    assert.equal(v.verdict, 'SCAM');
    assert.equal(v.engine, 'rules-fallback');
    assert.ok(v.pressureSignals.length >= 2);
  });

  it('passes a normal hospital call as LEGIT', async () => {
    const call = mkCall([
      'โทรจากโรงพยาบาลสมิติเวช เรื่องนัดตรวจสุขภาพวันพฤหัสค่ะ',
      'โทรกลับเบอร์ 02-100-2003 ได้เลยค่ะ',
    ]);
    const v = await judge({ call, member, isWhitelistedCaller: false });
    assert.equal(v.verdict, 'LEGIT');
    assert.equal(v.action, 'END_LEGIT');
  });

  it('distrusts whitelisted numbers on money requests (verify mode)', async () => {
    const call = mkCall(['แม่ นี่ลูกเอง โอนเงินให้หน่อยด่วนเลย']);
    const v = await judge({ call, member, isWhitelistedCaller: true });
    assert.equal(v.action, 'VERIFY_SAFEWORD');
  });

  it('stays UNSURE on vague survey with partial signals', async () => {
    const call = mkCall(['โทรจากศูนย์วิจัยครับ ขอชื่อกับวันเกิดหน่อยครับ']);
    const v = await judge({ call, member, isWhitelistedCaller: false });
    assert.equal(v.verdict, 'UNSURE');
    assert.equal(v.action, 'END_UNSURE');
  });

  it('returns the contract fields alongside the legacy ones', async () => {
    const v = await judge({ call: mkCall(['โทรจากศูนย์วิจัยครับ']), member, isWhitelistedCaller: false });
    assert.equal(typeof v.reasonTh, 'string');
    assert.equal(v.reason, v.reasonTh);
    assert.equal(typeof v.signals.authority, 'number');
    assert.ok(Array.isArray(v.pressureSignals));
    assert.ok(['continue', 'hangup', 'take-message'].includes(v.next));
    assert.equal(typeof v.closingLine, 'string');
  });
});

describe('closingLine()', () => {
  it('leaves an UNSURE call for the owner to decide', () => {
    assert.match(closingLine('UNSURE'), /ตัดสิน/);
  });
});

describe('shouldEndNow() uses the nextAction policy', () => {
  it('ends a LEGIT call once the callback number is given', () => {
    const verdict = { verdict: 'LEGIT', confidence: 0.9, signals: { callbackGiven: 0.95 } };
    assert.equal(shouldEndNow({ verdict, turnCount: 2 }), true);
  });
  it('keeps an early UNSURE call going', () => {
    assert.equal(shouldEndNow({ verdict: { verdict: 'UNSURE', confidence: 0.5 }, turnCount: 1 }), false);
  });
});

describe('auditDecision()', () => {
  it('keeps caller-quoting reason text out of the logs (PDPA)', () => {
    const lines = [];
    const orig = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try {
      auditDecision({ id: 'c1', memberId: 'm1' }, {
        verdict: 'SCAM', confidence: 0.95, engine: 'jev', pressureSignals: ['otpRequest'],
        reason: 'ผู้โทรชื่อสมชาย เบอร์ 081-234-5678 ขอรหัส OTP', reasonTh: 'ผู้โทรชื่อสมชาย', reasonEn: 'Caller Somchai 081-234-5678',
      });
    } finally {
      console.log = orig;
    }
    const out = lines.join(' | ');
    assert.match(out, /SCAM/);
    assert.match(out, /otpRequest/);
    assert.doesNotMatch(out, /สมชาย|Somchai|081-234-5678/);
  });
});
