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
  thsmsApiKey: process.env.THSMS_API_KEY || '',
  thsmsSender: process.env.THSMS_SENDER || '',
  demoNumber: process.env.DEMO_NUMBER || '', // the one AI number used in demo

  // Plan quota (minutes/month included in ฿149).
  monthlyQuotaMinutes: num('MONTHLY_QUOTA_MINUTES', 60),

  // Notification adapters: comma list, e.g. "console,line".
  notifyAdapters: (process.env.NOTIFY_ADAPTERS || 'console').split(',').map((s) => s.trim()).filter(Boolean),
  lineChannelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  lineChannelSecret: process.env.LINE_CHANNEL_SECRET || '',
  lineLoginChannelId: process.env.LINE_LOGIN_CHANNEL_ID || '',
  liffId: process.env.LINE_LIFF_ID || '2008922436-G2kWQbrj',
  lineDefaultTo: process.env.LINE_DEFAULT_TO || '',

  // Abuse limits (per spec: rate-limit rejects, cap minutes per house).
  maxRejectsPerDayPerCaller: num('MAX_REJECTS_PER_DAY', 20),
  maxMinutesPerHousePerMonth: num('MAX_MINUTES_PER_HOUSE', 200),
  maxTurnsPerCall: num('MAX_TURNS_PER_CALL', 12),

  // Talk budget: one call may burn at most this fraction of the plan's
  // monthly quota (0.2 → ฿20/10min = 2min, ฿100/50min = 10min). 0 disables.
  talkBudgetFraction: Number(process.env.TALK_BUDGET_FRACTION ?? 0.2) || 0,

  // Demo guards: the public page must not drain the AI budget.
  demoMaxCallsPerHour: num('DEMO_MAX_CALLS_PER_HOUR', 30),
  demoMaxCallsPerIpHour: num('DEMO_MAX_CALLS_PER_IP_HOUR', 5),
  demoIdleMinutes: num('DEMO_IDLE_MINUTES', 10),

  // Single-shot analysis endpoint (no UI sender yet — rate limits only).
  analyzeMaxPerHour: num('ANALYZE_MAX_PER_HOUR', 100),
  analyzeMaxPerIpMin: num('ANALYZE_MAX_PER_IP_MIN', 10),

  // reCAPTCHA v3 (invisible bot gate on demo start). Empty apiKey = disabled.
  recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || '',
  recaptchaProjectId: process.env.RECAPTCHA_PROJECT_ID || '',
  recaptchaApiKey: process.env.RECAPTCHA_API_KEY || '',
  recaptchaMinScore: num('RECAPTCHA_MIN_SCORE', 0.5),

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

  // Stripe billing (test mode). Empty secret = billing disabled (503).
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  // One-time prices per plan/seat x region (THB for th, USD for intl).
  stripePrices: {
    'starter-20': { th: process.env.STRIPE_PRICE_STARTER_TH || '', intl: process.env.STRIPE_PRICE_STARTER_INTL || '' },
    'plus-100': { th: process.env.STRIPE_PRICE_PLUS_TH || '', intl: process.env.STRIPE_PRICE_PLUS_INTL || '' },
    'family-149': { th: process.env.STRIPE_PRICE_FAMILY_TH || '', intl: process.env.STRIPE_PRICE_FAMILY_INTL || '' },
    seat: { th: process.env.STRIPE_PRICE_SEAT_TH || '', intl: process.env.STRIPE_PRICE_SEAT_INTL || '' },
    'topup-small': { th: process.env.STRIPE_PRICE_TOPUP_SMALL_TH || '', intl: process.env.STRIPE_PRICE_TOPUP_SMALL_INTL || '' },
    'topup-medium': { th: process.env.STRIPE_PRICE_TOPUP_MEDIUM_TH || '', intl: process.env.STRIPE_PRICE_TOPUP_MEDIUM_INTL || '' },
  },
};

export const isLiveAI = () => config.geminiApiKey.length > 10;
