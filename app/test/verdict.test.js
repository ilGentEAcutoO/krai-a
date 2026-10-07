// Verdict authority tests: hard rules fire without AI, confidence gate
// demotes thin-evidence SCAM/LEGIT to UNSURE, whitelist never blind-trusts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { judge } from '../src/verdict.js';

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
    assert.equal(v.engine, 'hard-rule');
    assert.equal(v.action, 'END_SCAM');
  });

  it('fires instant SCAM on app-install + link demand', async () => {
    const call = mkCall(['โหลดแอปตามลิงก์ที่ผมส่งให้ก่อนนะครับ แล้วแจ้งรหัสยืนยัน']);
    const v = await judge({ call, member, isWhitelistedCaller: false });
    assert.equal(v.verdict, 'SCAM');
    assert.equal(v.action, 'END_SCAM');
  });

  it('detects full police script as SCAM via rules engine', async () => {
    const call = mkCall([
      'ผมร้อยเวรจาก สภ.เมือง คุณมีหมายเรียกคดีฟอกเงินนะครับ',
      'เรื่องนี้ห้ามบอกใครนะครับ แล้วโอนเงินมาตรวจสอบที่บัญชีกลาง',
    ]);
    const v = await judge({ call, member, isWhitelistedCaller: false });
    assert.equal(v.verdict, 'SCAM');
    assert.equal(v.engine, 'rules');
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
});
