// Judge policy: the ONLY place that turns Jev probabilities into a verdict,
// a confidence, an escalation decision and the next call action. Thresholds
// were checked against the demo scripts + variants (scripts/judge-smoke.mjs);
// models supply probabilities, this file owns the consequences.

// Contract signals (0..1) plus two policy helpers: `injection` (caller text
// addressed to the AI) and `callbackGiven` (caller left a way to call back).
export const SIGNALS = ['authority', 'urgency', 'secrecy', 'moneyTransfer', 'otpRequest', 'appInstall', 'identityProbe'];
export const EXTRA_SIGNALS = ['injection', 'callbackGiven'];
export const ALL_SIGNALS = [...SIGNALS, ...EXTRA_SIGNALS];

export const T = {
  scamP: 0.8, // Jev P(SCAM) to call SCAM on the Choice alone
  legitP: 0.8, // Jev P(LEGIT) to call LEGIT (and no risk signal)
  confirm: 0.5, // Jev noul that confirms a hard-rule regex hit
  demand: 0.85, // OTP / app-install noul: a direct scam demand by itself
  transfer: 0.85, // money-transfer noul, when backed by authority or pressure
  backing: 0.7,
  risk: 0.5, // any risk noul at/above this blocks LEGIT
  injection: 0.5,
  escalateConf: 0.5, // Choice confidence below this goes to Gemini
  hangup: 0.85, // SCAM confidence that ends the call
  legitClose: 0.8,
  callback: 0.6,
  legitMaxTurns: 3,
  unsureMaxTurns: 4,
};

export const zeroSignals = () => Object.fromEntries(ALL_SIGNALS.map((k) => [k, 0]));
const clamp01 = (x) => Math.min(1, Math.max(0, Number(x) || 0));
export const round = (x) => Math.round(clamp01(x) * 1000) / 1000;

export function riskOf(s) {
  return Math.max(s.moneyTransfer, s.otpRequest, s.appInstall, s.secrecy);
}

// jev = { choice, probabilities:{SCAM,LEGIT,UNSURE}, confidence, signals }
export function decide(jev) {
  const s = jev.signals;
  const p = jev.probabilities;
  const demand = Math.max(s.otpRequest, s.appInstall);
  const backed = Math.max(s.authority, s.urgency, s.secrecy) >= T.backing;
  const risk = riskOf(s);

  // "Any serious violation": a direct demand is SCAM whatever the Choice says.
  if (demand >= T.demand) return { verdict: 'SCAM', confidence: round(Math.max(p.SCAM, demand)), escalate: false, rule: 'demand' };
  if (s.moneyTransfer >= T.transfer && backed) {
    return { verdict: 'SCAM', confidence: round(Math.max(p.SCAM, s.moneyTransfer)), escalate: false, rule: 'transfer' };
  }
  if (p.SCAM >= T.scamP) return { verdict: 'SCAM', confidence: round(p.SCAM), escalate: false, rule: 'choice' };
  if (p.LEGIT >= T.legitP && risk < T.risk && s.injection < T.injection && s.identityProbe < T.risk) {
    return { verdict: 'LEGIT', confidence: round(p.LEGIT), escalate: false, rule: 'choice' };
  }
  // Escalate when Jev is flat, or when it leans SCAM/LEGIT but the policy
  // could not accept that (grey zone, or LEGIT contradicted by a risk signal).
  const escalate = jev.confidence < T.escalateConf || jev.choice !== 'UNSURE';
  return { verdict: 'UNSURE', confidence: round(p.UNSURE), escalate, rule: escalate ? 'escalate' : 'choice' };
}

// Gemini may raise suspicion freely, but can never clear a call that Jev saw
// asking for something sensitive, probing for identity, or talking to the AI.
export function guardGemini(verdict, s) {
  if (verdict === 'LEGIT' && (riskOf(s) >= T.risk || s.injection >= T.injection || s.identityProbe >= T.risk)) return 'UNSURE';
  return verdict;
}

// Gemini is not calibrated: blend its verdict with Jev's own probability for
// it (moderate unless Jev agrees), or a fixed 0.7 when Jev was unavailable.
export function geminiConfidence(verdict, probabilities) {
  if (!probabilities) return 0.7;
  return round(0.5 + 0.5 * (probabilities[verdict] || 0));
}

// 'continue' | 'hangup' | 'take-message'. Accepts a verdict object or string.
export function nextAction(v, turnCount, { maxTurns = 12 } = {}) {
  const verdict = typeof v === 'string' ? v : v?.verdict || 'UNSURE';
  const confidence = typeof v === 'string' ? 1 : Number(v?.confidence) || 0;
  const callback = typeof v === 'object' && v?.signals ? Number(v.signals.callbackGiven) || 0 : 0;
  const n = Number(turnCount) || 0;
  if (n >= maxTurns) return verdict === 'SCAM' ? 'hangup' : 'take-message';
  if (verdict === 'SCAM' && confidence >= T.hangup) return 'hangup';
  if (verdict === 'LEGIT' && confidence >= T.legitClose && (callback >= T.callback || n >= T.legitMaxTurns)) return 'take-message';
  if (verdict === 'UNSURE' && callback >= T.callback && n >= 2) return 'take-message';
  if (n >= T.unsureMaxTurns) return verdict === 'SCAM' ? 'hangup' : 'take-message';
  return 'continue';
}

const PHRASE = {
  otpRequest: ['ขอรหัส OTP/รหัสยืนยัน', 'asks for an OTP/verification code'],
  appInstall: ['ให้ติดตั้งแอปหรือกดลิงก์', 'asks to install an app or open a link'],
  moneyTransfer: ['ขอให้โอนเงินหรือขอเลขบัญชี', 'asks for a money transfer or account number'],
  secrecy: ['สั่งห้ามวางสาย/ห้ามบอกใคร', "demands secrecy / don't hang up"],
  urgency: ['ข่มขู่หรือเร่งให้รีบทำ', 'threatens or rushes the owner'],
  authority: ['แจ้งว่าโทรจากหน่วยงานหรือบริษัท', 'says it is calling from an organisation or company'],
  identityProbe: ['ถามข้อมูลส่วนตัว', 'probes for personal details'],
  injection: ['พยายามสั่งระบบ AI', 'tries to give orders to the AI'],
};
const ORDER = ['otpRequest', 'appInstall', 'moneyTransfer', 'secrecy', 'urgency', 'authority', 'injection', 'identityProbe'];

// Code-written reasons from signals: used whenever Gemini didn't write them.
export function templateReasons(verdict, s, { min = 0.6, max = 3 } = {}) {
  const hits = ORDER.filter((k) => (s[k] || 0) >= min).slice(0, max);
  const th = hits.map((k) => PHRASE[k][0]).join(' + ');
  const en = hits.map((k) => PHRASE[k][1]).join(' + ');
  if (verdict === 'SCAM') {
    return {
      reasonTh: hits.length ? `สัญญาณมิจฉาชีพ: ${th}` : 'บทสนทนาเข้าเค้าสคริปต์มิจฉาชีพ',
      reasonEn: hits.length ? `Scam signals: ${en}.` : 'The conversation matches a known scam script.',
    };
  }
  if (verdict === 'LEGIT') {
    return {
      reasonTh: 'ธุระชัดเจน ไม่ขอเงิน รหัส หรือให้ลงแอป',
      reasonEn: 'Clear everyday purpose; no request for money, codes or app installs.',
    };
  }
  return {
    reasonTh: hits.length ? `ยังสรุปไม่ได้: ${th}` : 'ข้อมูลยังไม่พอ ขอฟังต่อก่อน',
    reasonEn: hits.length ? `Not conclusive yet: ${en}.` : 'Not enough information yet; still listening.',
  };
}
