// Gemini wrapper with transparent RULES fallback.
// Live mode: calls Gemini generateContent (REST, no SDK) for verdict + reply.
// Mock mode (no API key): deterministic Thai rule-based classifier so the
// demo runs offline. Every response reports `engine: 'gemini' | 'rules'`.
import { config } from './config.js';

const API = 'https://generativelanguage.googleapis.com/v1beta/models';

async function geminiGenerate(system, user, { json = false, maxTokens = 512 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), config.geminiTimeoutMs);
  try {
    const res = await fetch(
      `${API}/${config.geminiModel}:generateContent?key=${config.geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ parts: [{ text: user }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: maxTokens,
            ...(json ? { responseMimeType: 'application/json' } : {}),
          },
        }),
      },
    );
    if (!res.ok) throw new Error(`gemini-http-${res.status}`);
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  } finally {
    clearTimeout(t);
  }
}

export const live = () => config.geminiApiKey.length > 10;

// ---- Verdict classification ----
const VERDICT_SYSTEM = `You are a Thai phone-scam analyst. Given a call transcript between an AI receptionist (assistant) and an unknown caller, classify the caller.
Return JSON only: {"verdict":"SCAM"|"LEGIT"|"UNSURE","confidence":0.0-1.0,"claimedIdentity":"...","requestedAction":"...","pressureSignals":["threat"|"urgency"|"secrecy"|"authority"],"matchesKnownScam":true|false,"reason":"one Thai sentence","reasonEn":"one English sentence"}
Rules: SCAM needs clear scam-script evidence (impersonating police/bank/parcel + demanding transfer/OTP/remote app/install + pressure). LEGIT needs a normal benign request with zero pressure. Otherwise UNSURE. Never accuse on thin evidence.`;

// Rule-based fallback: Thai keyword signals, weighted. Calibrated so that
// obvious scams score >= 0.8 and normal messages stay LEGIT/UNSURE.
const SCAM_PATTERNS = [
  { re: /(ตำรวจ|สภ\.?|ร้อยเวร|ผู้กอง|สารวัตร|dsi|ปปง|ป\.?ป\.?ง)/, w: 0.25, signal: 'authority' },
  { re: /(ธนาคาร|แบงก์|bank|บัญชีม้า|อายัด|ระงับบัญชี)/, w: 0.2, signal: 'authority' },
  { re: /(พัสดุ|ไปรษณีย์|ขนส่ง|kerry|flash|dhl|ตกค้าง|มีของผิดกฎหมาย)/, w: 0.2, signal: 'authority' },
  { re: /(โอนเงิน|โอนมา|โอนด่วน|โอนเข้าบัญชี|เลขบัญชี|พร้อมเพย์)/, w: 0.3, signal: 'urgency' },
  { re: /(otp|รหัสผ่าน|รหัสยืนยัน|รหัส 6 หลัก|เลขหลังบัตร|cvv)/i, w: 0.35, signal: 'urgency' },
  { re: /(รีโมท|teamviewer|anydesk|โหลดแอป|ติดตั้งแอป|ลงแอป|แอปลิงก์|กดลิงก์|คลิกลิงก์)/i, w: 0.35, signal: 'urgency' },
  { re: /(ห้ามบอก|อย่าบอกใคร|ความลับ|ห้ามวางสาย|อย่าวางสาย|ห้ามปรึกษา)/, w: 0.3, signal: 'secrecy' },
  { re: /(หมายจับ|หมายเรียก|คดี|ฟอกเงิน|ค้ายา|ติดคุก|จะถูกจับ|ดำเนินคดี)/, w: 0.3, signal: 'threat' },
  { re: /(ด่วน|ภายในวันนี้|ภายใน.*นาที|เดี๋ยวนี้เลย|เร่งด่วน|หมดเขตวันนี้)/, w: 0.15, signal: 'urgency' },
  { re: /(เงินคืน|คืนภาษี|ได้รับรางวัล|ถูกรางวัล|กู้เงิน|สินเชื่ออนุมัติ)/, w: 0.2, signal: 'authority' },
];

const LEGIT_PATTERNS = [
  /(นัดหมอ|โรงพยาบาล|คลินิก|เลื่อนนัด|ผลตรวจ|รับยา)/,
  /(พัสดุมาส่ง|ส่งของ|อยู่หน้าบ้าน|รับของ| Kerry|flash.*ส่ง)/i,
  /(นัดหมาย|ประชุม|สัมภาษณ์งาน|โรงเรียน.*ลูก|ครู)/,
  /(ซ่อม|ช่าง|นัดช่าง|ประปา|ไฟฟ้า)/,
];

function rulesVerdict(transcriptText, callerTexts) {
  // Score each caller turn separately and accumulate (capped): an escalating
  // script must grow more suspicious every turn. Assistant lines are excluded
  // so the persona can never incriminate the caller.
  let score = 0;
  const signals = new Set();
  for (const line of callerTexts.length ? callerTexts : [transcriptText]) {
    for (const p of SCAM_PATTERNS) {
      if (p.re.test(line)) {
        score += p.w;
        signals.add(p.signal);
      }
    }
  }
  score = Math.min(score, 1.2);
  const legitHit = LEGIT_PATTERNS.some((re) => re.test(transcriptText));
  if (legitHit && score < 0.3) {
    return {
      verdict: 'LEGIT', confidence: 0.85, claimedIdentity: 'unverified caller',
      requestedAction: 'normal request', pressureSignals: [], matchesKnownScam: false,
      reason: 'เรื่องปกติ ไม่มีสัญญาณกดดันหรือขอโอนเงิน', reasonEn: 'Normal benign request, no pressure or transfer demand.',
    };
  }
  if (score >= 0.8) {
    return {
      verdict: 'SCAM', confidence: Math.min(0.95, 0.8 + score * 0.1),
      claimedIdentity: 'suspected impersonator', requestedAction: 'demands transfer/OTP/app install',
      pressureSignals: [...signals], matchesKnownScam: true,
      reason: 'สคริปต์มิจฉาชีพชัดเจน: อ้างอำนาจ + เร่ง + ขอโอน/OTP/ลงแอป',
      reasonEn: 'Clear scam script: authority claim + pressure + transfer/OTP/app demand.',
    };
  }
  if (score >= 0.35) {
    return {
      verdict: 'UNSURE', confidence: 0.55, claimedIdentity: 'unclear',
      requestedAction: 'unclear request', pressureSignals: [...signals], matchesKnownScam: false,
      reason: 'มีบางสัญญาณน่าสงสัย แต่หลักฐานยังไม่พอฟันธง', reasonEn: 'Some suspicious signals, not enough evidence to conclude.',
    };
  }
  return {
    verdict: 'UNSURE', confidence: 0.4, claimedIdentity: 'unknown',
    requestedAction: 'unknown', pressureSignals: [], matchesKnownScam: false,
    reason: 'ข้อมูลยังน้อยเกินไป ขอฟังต่อก่อน', reasonEn: 'Too little information yet, keep listening.',
  };
}

export async function classify(transcriptText, callerTexts = []) {
  if (live()) {
    try {
      const raw = await geminiGenerate(VERDICT_SYSTEM, transcriptText.slice(-4000), { json: true });
      const v = JSON.parse(raw.replace(/```json|```/g, '').trim());
      if (v && ['SCAM', 'LEGIT', 'UNSURE'].includes(v.verdict)) {
        return { ...v, confidence: Number(v.confidence) || 0.5, engine: 'gemini' };
      }
    } catch {
      // fall through to rules
    }
  }
  return { ...rulesVerdict(transcriptText, callerTexts), engine: 'rules' };
}

// ---- Persona reply (kept separate from verdict authority) ----
const PERSONA_SYSTEM = `You are "Krai-a", a polite Thai AI receptionist answering a forwarded call. Rules: speak Thai, 1-2 short sentences. Open every call with the recording notice. Ask for name, organization, and callback number. Never accuse the caller of scamming. If they demand transfer/OTP/app install, deflect: say you need time to verify. Reply with the spoken sentence only, no quotes.`;

const OPENING = 'สายนี้มีการบันทึกเพื่อความปลอดภัยค่ะ ไม่ทราบว่าติดต่อจากที่ไหน และมีธุระอะไรคะ';
const FALLBACK_REPLIES = [
  'ขอทราบชื่อและหน่วยงานของท่าน พร้อมเบอร์ติดต่อกลับได้ไหมคะ',
  'เดี๋ยวขอเวลาตรวจสอบข้อมูลก่อนนะคะ รบกวนแจ้งเลขหนังสือหรือเบอร์ติดต่อกลับไว้ค่ะ',
  'รับเรื่องไว้แล้วค่ะ เดี๋ยวจะติดต่อกลับตามเบอร์ที่แจ้งไว้นะคะ',
];

export function openingLine() {
  return OPENING;
}

export async function personaReply(transcriptText, turnIndex) {
  if (live()) {
    try {
      const reply = await geminiGenerate(PERSONA_SYSTEM, `Transcript so far:\n${transcriptText.slice(-3000)}\n\nNext assistant line:`, { maxTokens: 200 });
      const clean = reply.trim().replace(/^["'“”]+|["'“”]+$/g, '');
      if (clean) return { text: clean, engine: 'gemini' };
    } catch {
      // fall through
    }
  }
  return { text: FALLBACK_REPLIES[Math.min(turnIndex, FALLBACK_REPLIES.length - 1)], engine: 'rules' };
}

// Closing lines per final verdict (persona voice, never accusatory on the call).
export function closingLine(verdict) {
  if (verdict === 'SCAM') return 'ขอเวลาตรวจสอบข้อมูลก่อนนะคะ ขอบคุณที่ติดต่อมาค่ะ';
  if (verdict === 'LEGIT') return 'รับเรื่องไว้แล้วค่ะ เดี๋ยวจะติดต่อกลับนะคะ ขอบคุณค่ะ';
  return 'เดี๋ยวขอตรวจสอบแล้วติดต่อกลับนะคะ ขอบคุณค่ะ';
}
