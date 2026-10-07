// Central configuration. All secrets come from environment variables only.
// Never commit real keys — see .env.example.
import 'dotenv/config';

function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const config = {
  port: num('PORT', 8080),

  // Mode A (default): one virtual number per household, identify by To.
  // Mode B (scale): one shared number, identify by ForwardedFrom header.
  identifyMode: process.env.IDENTIFY_MODE === 'B' ? 'B' : 'A',

  // Gemini (Google AI). Empty key = RULES mock mode for offline demo.
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
  geminiTimeoutMs: num('GEMINI_TIMEOUT_MS', 12000),

  // Verdict confidence gate: only SCAM/LEGIT at high confidence, else UNSURE.
  verdictThreshold: 0.8,

  // Twilio (telephony adapter). Empty = telephony disabled, demo API still works.
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || '',
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || '',
  twilioVerifySid: process.env.TWILIO_VERIFY_SID || '',
  demoNumber: process.env.DEMO_NUMBER || '', // the one AI number used in demo

  // Plan quota (minutes/month included in ฿149).
  monthlyQuotaMinutes: num('MONTHLY_QUOTA_MINUTES', 60),

  // Notification adapters: comma list, e.g. "console,line".
  notifyAdapters: (process.env.NOTIFY_ADAPTERS || 'console').split(',').map((s) => s.trim()).filter(Boolean),
  lineChannelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  lineDefaultTo: process.env.LINE_DEFAULT_TO || '',

  // Abuse limits (per spec: rate-limit rejects, cap minutes per house).
  maxRejectsPerDayPerCaller: num('MAX_REJECTS_PER_DAY', 20),
  maxMinutesPerHousePerMonth: num('MAX_MINUTES_PER_HOUSE', 200),
  maxTurnsPerCall: num('MAX_TURNS_PER_CALL', 12),

  // Gate 1: forwarder allowlist (customer owner numbers). Empty = permissive.
  forwardAllowlist: (process.env.FORWARD_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean),

  // Gate 2: caller reputation. SCAM numbers auto-reject repeats until TTL.
  reputationTtlDays: num('REPUTATION_TTL_DAYS', 60),
  reputationMinConfidence: num('REPUTATION_MIN_CONFIDENCE', 0.8),

  // PDPA tab-3: spoken recording notice + retention windows. Day counts are
  // operational defaults pending lawyer confirmation — disclosed via /privacy.
  recordNotice: process.env.RECORD_NOTICE_TH || 'เพื่อความปลอดภัย สายนี้มีการบันทึกเสียงค่ะ',
  retentionLegitDays: num('RETENTION_LEGIT_DAYS', 7),
  retentionUnsureDays: num('RETENTION_UNSURE_DAYS', 90),
  retentionScamDays: num('RETENTION_SCAM_DAYS', 365),

  // Demo seed: household(s) pre-registered as members.
  seedMemberPhone: process.env.SEED_MEMBER_PHONE || '+66810000001',
  seedMemberName: process.env.SEED_MEMBER_NAME || 'Demo Household',
};

export const isLiveAI = () => config.geminiApiKey.length > 10;
