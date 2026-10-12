// Persona voice for the call loop (routes.js demo + Twilio adapter).
// Verdicts live in src/judge (Jev judges, Gemini escalates); this module keeps
// the legacy call-loop API: openingLine, closingLine, and personaReply over a
// transcript string. Live mode delegates to the judge persona (Gemini writes,
// Jev guards); otherwise deterministic canned lines report engine 'rules'.
import { isLiveAI } from './config.js';
import { personaReply as judgePersona, openingLine as judgeOpening } from './judge/index.js';

const FALLBACK_REPLIES = [
  'ขอทราบชื่อและหน่วยงานของท่าน พร้อมเบอร์ติดต่อกลับได้ไหมคะ',
  'เดี๋ยวขอเวลาตรวจสอบข้อมูลก่อนนะคะ รบกวนแจ้งเลขหนังสือหรือเบอร์ติดต่อกลับไว้ค่ะ',
  'รับเรื่องไว้แล้วค่ะ เดี๋ยวจะติดต่อกลับตามเบอร์ที่แจ้งไว้นะคะ',
];

// No recording claim here: the phone path prepends config.recordNotice.
export function openingLine(lang = 'th') {
  return judgeOpening(lang);
}

// "caller: ..." / "assistant: ..." lines (routes/twilio format) -> turns.
function toTurns(transcript) {
  if (Array.isArray(transcript)) return transcript;
  return String(transcript || '').split('\n').map((line) => {
    const m = /^\s*(caller|assistant|ai)\s*:\s*(.*)$/i.exec(line);
    return m ? { role: m[1].toLowerCase() === 'caller' ? 'caller' : 'ai', text: m[2] } : null;
  }).filter(Boolean);
}

export async function personaReply(transcript, turnIndex, opts = {}) {
  // Last stretch of the budget: stop investigating, just secure a callback.
  const wrapUp = opts.turnsLeft != null && opts.turnsLeft <= 2;
  if (isLiveAI()) {
    const r = await judgePersona({
      turns: toTurns(transcript), verdict: opts.verdict || 'UNSURE', lang: opts.lang || 'th', action: 'continue', wrapUp,
    });
    if (r.engine === 'gemini') return { text: r.text, engine: 'gemini' };
  }
  if (wrapUp) return { text: 'ขอเบอร์ติดต่อกลับไว้หน่อยได้ไหมคะ เดี๋ยวจะรีบติดต่อกลับค่ะ', engine: 'rules' };
  return { text: FALLBACK_REPLIES[Math.min(turnIndex, FALLBACK_REPLIES.length - 1)], engine: 'rules' };
}

// Closing lines per final verdict (persona voice, never accusatory on the call).
export function closingLine(verdict) {
  if (verdict === 'SCAM') return 'ขอเวลาตรวจสอบข้อมูลก่อนนะคะ ขอบคุณที่ติดต่อมาค่ะ';
  if (verdict === 'LEGIT') return 'รับเรื่องไว้แล้วค่ะ จะแจ้งเจ้าของเบอร์ให้ติดต่อกลับนะคะ ขอบคุณค่ะ';
  return 'รับเรื่องไว้แล้วค่ะ เดี๋ยวแจ้งเจ้าของเบอร์ให้ตัดสินนะคะ ขอบคุณค่ะ';
}
