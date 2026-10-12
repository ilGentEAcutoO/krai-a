// Verdict authority: the ONLY place that decides call outcomes.
// The member-specific rule (known number asking for money) runs here; then
// src/judge decides the turn (hard rules -> Jev -> Gemini escalation ->
// rules fallback). The persona (voice) can never order a transfer or hangup —
// only this module's `action`/`next` is executed by the telephony layer.
// Actions: END_SCAM | END_LEGIT | END_UNSURE | VERIFY_SAFEWORD
// next:    continue | hangup | take-message (see judge/policy.nextAction)
import { closingLine } from './ai.js';
import { config } from './config.js';
import { quotaTotal } from './store.js';
import { judgeTurn, nextAction, SIGNALS } from './judge/index.js';
import { zeroSignals } from './judge/policy.js';

// Whitelisted numbers are judged by their REQUEST, not their number: money /
// OTP / remote access from a known contact may be impersonation.
const VERIFY_TRIGGERS = [
  /(โอนเงิน|ยืมเงิน|ขอเงิน|โอนมา)/,
  /(otp|รหัสยืนยัน|รหัสผ่าน|เลขหลังบัตร)/i,
  /(รีโมท|teamviewer|anydesk)/i,
];

const asTurns = (call) => (call?.turns || []).map((t) => ({ role: t.role === 'caller' ? 'caller' : 'ai', text: t.text }));

export async function judge({ call, member, isWhitelistedCaller, lang = 'th' }) {
  const turns = asTurns(call);
  const callerLines = turns.filter((t) => t.role === 'caller').map((t) => t.text);

  if (isWhitelistedCaller && callerLines.some((l) => VERIFY_TRIGGERS.some((re) => re.test(l)))) {
    return {
      verdict: 'UNSURE', confidence: 0.7,
      signals: { ...zeroSignals(), moneyTransfer: 0.9 },
      reasonTh: 'เบอร์คนรู้จักแต่ขอเรื่องเงิน/OTP — ต้องยืนยันตัวตนก่อน',
      reasonEn: 'Known number with a sensitive request — verification required.',
      reason: 'เบอร์คนรู้จักแต่ขอเรื่องเงิน/OTP — ต้องยืนยันตัวตนก่อน',
      pressureSignals: [], matchesKnownScam: false,
      engine: 'rule', latencyMs: 0, action: 'VERIFY_SAFEWORD', next: 'continue',
      actionTh: 'ขอ safe word + โทรกลับเบอร์จริงก่อนทำอะไรต่อ',
      judgedAt: new Date().toISOString(),
    };
  }

  const v = await judgeTurn({ turns, lang });
  return finalize(v, callerLines.length);
}

function finalize(v, turnCount) {
  const verdict = v.verdict;
  return {
    ...v,
    // Legacy fields read by notify/evidence/UI.
    reason: v.reasonTh,
    pressureSignals: SIGNALS.filter((k) => v.signals[k] >= 0.6),
    matchesKnownScam: verdict === 'SCAM',
    action: verdict === 'SCAM' ? 'END_SCAM' : verdict === 'LEGIT' ? 'END_LEGIT' : 'END_UNSURE',
    next: nextAction(v, turnCount, { maxTurns: config.maxTurnsPerCall }),
    actionTh:
      verdict === 'SCAM'
        ? 'วางสายสุภาพ + แจ้งเตือนแดงพร้อมบทสนทนา'
        : verdict === 'LEGIT'
          ? 'ฝากข้อความ + แจ้งเตือนเขียว'
          : 'ฝากข้อความอย่างเดียว + แจ้งเตือนเหลืองให้เจ้าของตัดสิน',
    closingLine: closingLine(verdict),
    judgedAt: new Date().toISOString(),
  };
}

// Talk budget: cap one call at a fraction (config) of the member's monthly
// quota — ฿20/10min → 2min, ฿100/50min → 10min, ฿149/50min → 10min.
// Pooled quota (plan + seats + topups), so a topup buys longer calls too.
// Unknown member fails closed to the smallest plan. Infinity = disabled.
export function talkBudgetMinutes(member) {
  const quota = quotaTotal(member) || 0;
  const f = Number(config.talkBudgetFraction) || 0;
  if (!quota || f <= 0) return Infinity;
  return Math.max(1, Math.ceil(quota * f));
}

// Per-turn check: keep talking or end now? The policy (nextAction) ends a
// confident SCAM, a LEGIT call once its message is taken, an UNSURE call
// after a few turns, and anything at max turns; the talk budget also ends it.
// The judge returns a verdict every turn, so every end still has a summary.
export function shouldEndNow({ verdict, turnCount, elapsedMs = null, budgetMinutes = null }) {
  if (elapsedMs != null && budgetMinutes != null && elapsedMs >= budgetMinutes * 60000) return true;
  if (!verdict) return turnCount >= config.maxTurnsPerCall;
  return nextAction(verdict, turnCount, { maxTurns: config.maxTurnsPerCall }) !== 'continue';
}

// Audit trail: one structured line per finalized decision (transcript lives
// on the call record; this line proves what was decided and on which
// signals). No reason text: it quotes the caller (names, numbers) — PDPA.
export function auditDecision(call, verdict) {
  console.log('[audit]', JSON.stringify({
    call: call?.id, member: call?.memberId,
    verdict: verdict?.verdict, conf: verdict?.confidence,
    engine: verdict?.engine, signals: verdict?.pressureSignals || [],
  }));
}
