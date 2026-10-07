// Verdict authority: the ONLY place that decides call outcomes.
// Hard rules run first (instant, no AI cost), then the AI classifier with a
// confidence gate. The persona (voice) can never order a transfer or hangup —
// only this module's `action` is executed by the telephony layer.
// Actions: CONTINUE | END_SCAM | END_LEGIT | END_UNSURE | VERIFY_SAFEWORD
import { classify, closingLine } from './ai.js';
import { config } from './config.js';

// Instant-red: explicit scam demands. Instant-green never exists — even
// whitelisted callers are judged by their REQUEST, not their number.
const INSTANT_SCAM = [
  /(โอนเงิน|โอนมา).*(เดี๋ยวนี้|ด่วน|ทันที|ภายใน)/,
  /(บอก|แจ้ง).*(otp|รหัสยืนยัน|รหัส 6 หลัก)/i,
  /(โหลด|ติดตั้ง|ลง).*(แอป|app).*(ตามลิงก์|ที่ส่งให้)/i,
  /(ห้ามวางสาย|อย่าวางสาย).*(โอน|กด|ทำตาม)/,
];

const VERIFY_TRIGGERS = [
  /(โอนเงิน|ยืมเงิน|ขอเงิน|โอนมา)/,
  /(otp|รหัสยืนยัน|รหัสผ่าน|เลขหลังบัตร)/i,
  /(รีโมท|teamviewer|anydesk)/i,
];

function transcriptText(turns) {
  return turns.map((t) => `${t.role === 'caller' ? 'Caller' : 'Assistant'}: ${t.text}`).join('\n');
}

export async function judge({ call, member, isWhitelistedCaller }) {
  const text = transcriptText(call.turns);

  // Rule 1: request check beats number trust — whitelisted number asking for
  // money/OTP/remote access enters verification mode (safe word + callback),
  // even when the demand looks explicitly scammy (it may be impersonation).
  if (isWhitelistedCaller && VERIFY_TRIGGERS.some((re) => re.test(text))) {
    return {
      verdict: 'UNSURE', confidence: 0.7, claimedIdentity: 'known contact (unverified request)',
      requestedAction: 'sensitive request from known number', pressureSignals: [],
      matchesKnownScam: false, reason: 'เบอร์คนรู้จักแต่ขอเรื่องเงิน/OTP — ต้องยืนยันตัวตนก่อน',
      reasonEn: 'Known number with a sensitive request — verification required.',
      engine: 'hard-rule', action: 'VERIFY_SAFEWORD',
      actionTh: 'ขอ safe word + โทรกลับเบอร์จริงก่อนทำอะไรต่อ',
    };
  }

  // Rule 2: instant scam — no AI cost, immediate red.
  if (INSTANT_SCAM.some((re) => re.test(text))) {
    return finalize({
      verdict: 'SCAM', confidence: 0.95, claimedIdentity: 'suspected impersonator',
      requestedAction: 'explicit scam demand', pressureSignals: ['urgency'],
      matchesKnownScam: true, reason: 'เจอคำสั่งโอน/OTP/ลงแอปแบบชัดถ้อยชัดคำ',
      reasonEn: 'Explicit transfer/OTP/app-install demand detected.', engine: 'hard-rule',
    });
  }

  // Rule 3: AI classifier + confidence gate.
  const callerTexts = call.turns.filter((t) => t.role === 'caller').map((t) => t.text);
  const v = await classify(text, callerTexts);
  return finalize(v);
}

function finalize(v) {
  // Confidence gate: only high-confidence SCAM/LEGIT pass; else UNSURE.
  let verdict = v.verdict;
  if ((verdict === 'SCAM' || verdict === 'LEGIT') && Number(v.confidence) < config.verdictThreshold) {
    verdict = 'UNSURE';
  }
  const action = verdict === 'SCAM' ? 'END_SCAM' : verdict === 'LEGIT' ? 'END_LEGIT' : 'END_UNSURE';
  return {
    ...v,
    verdict,
    action,
    actionTh:
      verdict === 'SCAM'
        ? 'วางสายสุภาพ + แจ้งเตือนแดงพร้อมคลิปเสียง'
        : verdict === 'LEGIT'
          ? 'ฝากข้อความ + แจ้งเตือนเขียว'
          : 'ฝากข้อความอย่างเดียว + แจ้งเตือนเหลืองให้เจ้าของตัดสิน',
    closingLine: closingLine(verdict),
    judgedAt: new Date().toISOString(),
  };
}

// Per-turn light check: should we keep talking or end now?
// Ends early on high-confidence SCAM (save cost), or at max turns.
export function shouldEndNow({ verdict, turnCount }) {
  if (verdict && verdict.verdict === 'SCAM' && verdict.confidence >= 0.9 && turnCount >= 2) return true;
  if (turnCount >= config.maxTurnsPerCall) return true;
  return false;
}

// Audit trail: one structured line per finalized decision (transcript lives
// on the call record; this line proves what was decided and why).
export function auditDecision(call, verdict) {
  console.log('[audit]', JSON.stringify({
    call: call?.id, member: call?.memberId,
    verdict: verdict?.verdict, conf: verdict?.confidence,
    engine: verdict?.engine, reason: verdict?.reason,
  }));
}
