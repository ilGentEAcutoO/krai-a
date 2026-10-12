// Central configuration. All secrets come from environment variables only.
// Never commit real keys — see .env.example.
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ~/.typesafe.env holds a shared machine-work TypeSafe key: local runs only.
// Never read in production (Cloud Run sets K_SERVICE; the image NODE_ENV).
function machineTypesafeKey() {
  if (process.env.NODE_ENV === 'production' || process.env.K_SERVICE) return '';
  try {
    const txt = fs.readFileSync(path.join(os.homedir(), '.typesafe.env'), 'utf8');
    for (const name of ['TYPESAFE_API_KEY', 'TYPESAFE_AI_KEY', 'TYPESAFE_AI_MAC_KEY']) {
      const m = txt.match(new RegExp(`^\\s*${name}\\s*=\\s*"?([^"\\r\\n]*)"?`, 'm'));
      if (m && m[1].trim()) return m[1].trim();
    }
  } catch {
    // no machine key file
  }
  return '';
}

function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const config = {
  port: num('PORT', 8080),

  // Mode B (default): one central shared AI number per country; a call is
  // answered only if forwarded from a registered protected number.
  // Mode A (legacy demo): one virtual number per household, identify by To.
  identifyMode: process.env.IDENTIFY_MODE === 'A' ? 'A' : 'B',

  // Gemini (Google AI): escalation verdicts, owner reasons, persona lines.
  // gemini-3.5-flash-lite = current stable Flash-Lite: same 20/20 on the
  // judge smoke as gemini-3.8-flash at ~1.5 s vs ~3.8 s, and a caller waits
  // in silence on every turn (2.0-flash was shut down 2026-06-01).
  // Empty key = canned persona + templated reasons.
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
  geminiTimeoutMs: num('GEMINI_TIMEOUT_MS', 12000), // off-call work (reasons at build time)
  geminiTurnTimeoutMs: num('GEMINI_TURN_TIMEOUT_MS', 4000), // per Gemini call during a live turn
  // Whole-turn deadline: judge + spoken reply <= 8 s even if every engine
  // hangs (Twilio drops a webhook after 15 s). See judge/index.js.
  judgeBudgetMs: 5000,
  replyBudgetMs: 3000,

  // Jev (TypeSafe System One): the per-turn judge. Key from env, else the
  // machine key for local work only (see machineTypesafeKey).
  typesafeApiKey: process.env.TYPESAFE_API_KEY || process.env.TYPESAFE_AI_KEY || process.env.TYPESAFE_AI_MAC_KEY || machineTypesafeKey(),
  jevModel: process.env.JEV_MODEL || 'jev-latest',
  jevTimeoutMs: num('JEV_TIMEOUT_MS', 4000),

  // No AI network calls: AI_OFFLINE=1, and always under `node --test` (the
  // suite must stay free and deterministic) unless AI_LIVE_TESTS=1.
  aiOffline: process.env.AI_OFFLINE === '1' || (Boolean(process.env.NODE_TEST_CONTEXT) && process.env.AI_LIVE_TESTS !== '1'),

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
  recordNotice: process.env.RECORD_NOTICE_TH || 'สายนี้มีการบันทึกบทสนทนาเพื่อความปลอดภัยค่ะ',
  retentionLegitDays: num('RETENTION_LEGIT_DAYS', 7),
  retentionUnsureDays: num('RETENTION_UNSURE_DAYS', 90),
  retentionScamDays: num('RETENTION_SCAM_DAYS', 365),

  // Demo seed: household(s) pre-registered as members.
  seedMemberPhone: process.env.SEED_MEMBER_PHONE || '+66810000001',
  seedMemberName: process.env.SEED_MEMBER_NAME || 'Demo Household',

  // Stripe billing (test mode). Empty secret = billing disabled (503).
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  // One-time prices (pricing v2) per item x region (THB for th, USD for intl);
  // plans also have an annual price (_YR). Unset = that item can't be bought.
  stripePrices: {
    'solo-99': {
      th: process.env.STRIPE_PRICE_SOLO_TH || '', intl: process.env.STRIPE_PRICE_SOLO_INTL || '',
      th_year: process.env.STRIPE_PRICE_SOLO_TH_YR || '', intl_year: process.env.STRIPE_PRICE_SOLO_INTL_YR || '',
    },
    'family-199': {
      th: process.env.STRIPE_PRICE_FAMILY_TH || '', intl: process.env.STRIPE_PRICE_FAMILY_INTL || '',
      th_year: process.env.STRIPE_PRICE_FAMILY_TH_YR || '', intl_year: process.env.STRIPE_PRICE_FAMILY_INTL_YR || '',
    },
    'gift-solo-990': { th: process.env.STRIPE_PRICE_GIFT_SOLO || '', intl: process.env.STRIPE_PRICE_GIFT_SOLO_INTL || '' },
    'gift-family-1990': { th: process.env.STRIPE_PRICE_GIFT_FAMILY || '', intl: process.env.STRIPE_PRICE_GIFT_FAMILY_INTL || '' },
    seat: { th: process.env.STRIPE_PRICE_SEAT_TH || '', intl: process.env.STRIPE_PRICE_SEAT_INTL || '' },
    'topup-small': { th: process.env.STRIPE_PRICE_TOPUP_SMALL_TH || '', intl: process.env.STRIPE_PRICE_TOPUP_SMALL_INTL || '' },
    'topup-medium': { th: process.env.STRIPE_PRICE_TOPUP_MEDIUM_TH || '', intl: process.env.STRIPE_PRICE_TOPUP_MEDIUM_INTL || '' },
  },
};

export const isLiveAI = () => config.geminiApiKey.length > 10 && !config.aiOffline;
