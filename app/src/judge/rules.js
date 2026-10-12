// Deterministic layer of the judge.
// 1) Hard rules: explicit scam DEMANDS (OTP, app install via link, transfer
//    right now, don't-hang-up + transfer). A hit is only a CANDIDATE while Jev
//    is up: the direction ("give me your OTP" vs "we'll send you one") is a
//    Jev judgment, confirmed by the matching noul in the same request. The
//    regex alone decides only when Jev is unavailable.
// 2) Rules fallback: the keyword scorer used ONLY when Jev and Gemini are both
//    unavailable, so a call still gets a verdict. Never the primary judge.
// Both read caller lines only: the receptionist's own words never count.
import { zeroSignals } from './policy.js';

// A line that warns AGAINST the act ("ไม่ต้องบอกรหัส OTP", "never share the
// code") is how real banks talk — it must not trip the rule. Negation is
// matched right next to the act, so "ห้ามบอกใคร ... แจ้ง OTP" still fires;
// anything suppressed here still goes to Jev, never straight to LEGIT.
const NOT_OTP = /(ไม่|อย่า|ห้าม)\s*(ต้อง|ควร)?\s*(บอก|แจ้ง|ให้|เปิดเผย|ขอ)\s*(รหัส|otp|โอทีพี)|ไม่มีนโยบาย.{0,12}(ขอ|ถาม)|(never|don't|do not)\s+(share|give|tell).{0,20}(otp|code|pin)/i;
const NOT_APP = /(ไม่|อย่า|ห้าม)\s*(ต้อง|ควร)?\s*(โหลด|ติดตั้ง|ลง|กด)|(never|don't|do not)\s+(install|click|open)/i;
const NOT_TRANSFER = /(ไม่|อย่า|ห้าม)\s*(ต้อง|ควร)?\s*โอน|(never|don't|do not)\s+transfer/i;

// Demand direction only: "tell ME the code" fires, "we will send you a code"
// and "the system will SMS a code" don't (those go to Jev).
const OTP = '(otp|โอทีพี|รหัสยืนยัน|รหัส\\s*(6|หก)\\s*หลัก|รหัสผ่าน)';
const OTP_DEMAND = new RegExp(
  `(รบกวน|ช่วย|ขอให้|กรุณา|ต้อง)\\s*(บอก|แจ้ง|อ่าน).{0,30}${OTP}`
  + `|(บอก|แจ้ง|อ่าน).{0,30}${OTP}.{0,40}(มา|ให้\\s*(ผม|ดิฉัน|เรา|หนู|ฉัน|พี่|เจ้าหน้าที่)|หน่อย)`
  + '|\\b(tell|give|read)\\s+(me|us)\\b.{0,30}\\b(otp|verification code|one-time code|code|pin)\\b'
  + "|\\b(what'?s|what is|read out)\\s+the\\b.{0,20}\\b(otp|code|pin)\\b",
  'i',
);

const HARD_RULES = [
  { id: 'otp', re: OTP_DEMAND, not: NOT_OTP, confirm: 'otpRequest', signals: { otpRequest: 1 } },
  { id: 'app', re: /(โหลด|ติดตั้ง|ลง).{0,20}(แอป|app).{0,30}(ตามลิงก์|ลิงก์|ที่ส่งให้)|install\b.{0,30}\bapp\b.{0,30}\blink\b/i, not: NOT_APP, confirm: 'appInstall', signals: { appInstall: 1 } },
  { id: 'transfer-now', re: /(โอนเงิน|โอนมา).{0,30}(เดี๋ยวนี้|ด่วน|ทันที)|transfer\b.{0,30}\b(right now|immediately)\b/i, not: NOT_TRANSFER, confirm: 'moneyTransfer', signals: { moneyTransfer: 1, urgency: 1 } },
  { id: 'secrecy-transfer', re: /(ห้ามวางสาย|อย่าวางสาย).{0,60}(โอน|กด|ทำตาม)|(don't|do not) hang up\b.{0,60}\b(transfer|press|follow)/i, not: null, confirm: 'moneyTransfer', signals: { secrecy: 1, moneyTransfer: 1 } },
];

export function hardRule(callerLines) {
  for (const line of callerLines) {
    for (const rule of HARD_RULES) {
      if (rule.re.test(line) && !(rule.not && rule.not.test(line))) {
        return { id: rule.id, confirm: rule.confirm, signals: { ...zeroSignals(), ...rule.signals } };
      }
    }
  }
  return null;
}

// Persona backstop, used ONLY when the Jev output guard could not run: never
// speak an invented line problem or a made-up name for the receptionist.
const OFF_SCRIPT = /(สัญญาณ|ไม่ได้ยิน|ได้ยินไม่ชัด|เสียงขาด|เสียงไม่ชัด|สายหลุด|สายตัด|ระบบขัดข้อง|ไกรอ|bad signal|can'?t hear|cannot hear|breaking up|call (dropped|dropping)|system error)/i;
export const offScript = (text) => OFF_SCRIPT.test(String(text || ''));

// ---- Rules fallback (AI unavailable) ----
const SCAM_PATTERNS = [
  { re: /(ตำรวจ|สภ\.?|ร้อยเวร|ผู้กอง|สารวัตร|dsi|ปปง|ป\.?ป\.?ง|police)/i, w: 0.25, signal: 'authority' },
  { re: /(ธนาคาร|แบงก์|bank|บัญชีม้า|อายัด|ระงับบัญชี)/i, w: 0.2, signal: 'authority' },
  { re: /(พัสดุ|ไปรษณีย์|ขนส่ง|kerry|flash|dhl|ตกค้าง|มีของผิดกฎหมาย|courier|parcel)/i, w: 0.2, signal: 'authority' },
  { re: /(โอนเงิน|โอนมา|โอนด่วน|โอนเข้าบัญชี|เลขบัญชี|พร้อมเพย์|transfer)/i, w: 0.3, signal: 'moneyTransfer' },
  { re: /(otp|โอทีพี|รหัสผ่าน|รหัสยืนยัน|รหัส 6 หลัก|เลขหลังบัตร|cvv)/i, w: 0.35, signal: 'otpRequest' },
  { re: /(รีโมท|teamviewer|anydesk|โหลดแอป|ติดตั้งแอป|ลงแอป|แอปลิงก์|กดลิงก์|คลิกลิงก์)/i, w: 0.35, signal: 'appInstall' },
  { re: /(ห้ามบอก|อย่าบอกใคร|ความลับ|ห้ามวางสาย|อย่าวางสาย|ห้ามปรึกษา)/, w: 0.3, signal: 'secrecy' },
  { re: /(หมายจับ|หมายเรียก|คดี|ฟอกเงิน|ค้ายา|ติดคุก|จะถูกจับ|ดำเนินคดี)/, w: 0.3, signal: 'urgency' },
  { re: /(ด่วน|ภายในวันนี้|ภายใน.*นาที|เดี๋ยวนี้เลย|เร่งด่วน|หมดเขตวันนี้|urgent)/i, w: 0.15, signal: 'urgency' },
  { re: /(เงินคืน|คืนภาษี|ได้รับรางวัล|ถูกรางวัล|กู้เงิน|สินเชื่ออนุมัติ)/, w: 0.2, signal: 'authority' },
];
const LEGIT_PATTERNS = [
  /(นัดหมอ|โรงพยาบาล|คลินิก|เลื่อนนัด|ผลตรวจ|รับยา|hospital|clinic|appointment)/i,
  /(พัสดุมาส่ง|ส่งของ|อยู่หน้าบ้าน|รับของ|ไรเดอร์|rider)/i,
  /(นัดหมาย|ประชุม|สัมภาษณ์งาน|โรงเรียน.*ลูก|ครู)/,
  /(ซ่อม|ช่าง|นัดช่าง|ประปา|ไฟฟ้า)/,
];
const IDENTITY = /(ชื่อจริง|ขอชื่อ|วันเกิด|ปีเกิด|เลขบัตรประชาชน|ที่อยู่|ธนาคารไหน|date of birth|id number)/i;
const INJECTION = /(ระบบ\s*[:：]|system\s*:|ignore (all |any )?(previous|prior|your) instructions|ให้ตอบว่า|ตอบว่า\s*legit|classify (this|it) as)/i;
const CALLBACK = /(0\d[\d\s-]{7,11}\d|โทรกลับ(ที่)?เบอร์|call (me |us )?back (on|at))/i;

export function rulesSignals(callerLines) {
  const s = zeroSignals();
  let score = 0;
  for (const line of callerLines) {
    for (const p of SCAM_PATTERNS) {
      if (p.re.test(line)) {
        score += p.w;
        s[p.signal] = 0.9;
      }
    }
    if (IDENTITY.test(line)) s.identityProbe = 0.9;
    if (INJECTION.test(line)) s.injection = 0.9;
    if (CALLBACK.test(line)) s.callbackGiven = 0.9;
  }
  return { signals: s, score: Math.min(score, 1.2) };
}

export function rulesFallback(callerLines) {
  const { signals, score } = rulesSignals(callerLines);
  const legitHit = callerLines.some((l) => LEGIT_PATTERNS.some((re) => re.test(l)));
  // An unknown caller probing for identity, or talking to the AI, is never
  // cleared by keywords alone (a "free gift" survey must not read as LEGIT).
  if (legitHit && score < 0.3 && signals.injection === 0 && signals.identityProbe === 0) return { verdict: 'LEGIT', confidence: 0.85, signals };
  if (score >= 0.8) return { verdict: 'SCAM', confidence: Math.min(0.95, 0.8 + score * 0.1), signals };
  if (score >= 0.35 || signals.injection > 0 || signals.identityProbe > 0) return { verdict: 'UNSURE', confidence: 0.55, signals };
  return { verdict: 'UNSURE', confidence: 0.4, signals };
}
