// reCAPTCHA Enterprise assessments (v3 score, invisible — no checkbox).
// Cloud-native: server calls assessments.create with a restricted API key
// (key locked to recaptchaenterprise.googleapis.com, secret-side only).
// Empty apiKey = gate disabled (dev default, like other adapters).
// Fail-open ONLY on Google outage/timeout (availability for a demo);
// explicit reject, bad token, or low score fails closed here (captchaGate
// below turns a low score into one bounded low-trust pass).
import { config } from './config.js';
import { take } from './ratelimit.js';

export const captchaRequired = () => config.recaptchaApiKey.length > 10;

export async function verifyCaptcha(token, { action = '', fetchImpl = fetch } = {}) {
  if (!captchaRequired()) return { ok: true, skipped: true };
  if (!token) return { ok: false, error: 'captcha-required' };
  // Key in a header, never the query string (URLs land in logs/traces).
  const url = `https://recaptchaenterprise.googleapis.com/v1/projects/${encodeURIComponent(config.recaptchaProjectId)}/assessments`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.recaptchaApiKey },
      body: JSON.stringify({
        event: { token, siteKey: config.recaptchaSiteKey, ...(action ? { expectedAction: action } : {}) },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      if (res.status >= 500) {
        console.error(`[captcha] google ${res.status}, allowing (fail-open)`);
        return { ok: true, failed: true };
      }
      return { ok: false, error: 'captcha-failed' };
    }
    const data = await res.json();
    const tp = data?.tokenProperties || {};
    if (tp.valid !== true) console.warn(`[captcha] rejected reason=${tp.invalidReason || 'invalid'} score=${data?.riskAnalysis?.score ?? 'n/a'}`);
    if (tp.valid !== true) return { ok: false, error: 'captcha-failed', reason: tp.invalidReason || 'invalid' };
    if (action && tp.action && tp.action !== action) return { ok: false, error: 'captcha-action' };
    const score = Number(data?.riskAnalysis?.score);
    if (!(score >= config.recaptchaMinScore)) return { ok: false, error: 'captcha-score', score };
    return { ok: true, score };
  } catch (e) {
    console.error('[captcha] verify unreachable, allowing (fail-open):', e.message);
    return { ok: true, failed: true };
  } finally {
    clearTimeout(t);
  }
}

// ---- Express gate for the endpoints that spend AI live ----
// Only demo call start, /api/analyze and the live voice session sit behind
// this; read-only pages and mid-call turns never do. A valid token with a
// low score is NOT a hard lock (fresh/incognito judges score low): it gets
// one low-trust pass per IP per hour, bounded globally. Failures return a
// friendly bilingual message + `fallback: 'scenarios'` (the pre-rendered
// demo needs no API), keeping the `captcha-*` error codes the UI maps.
const FRIENDLY = {
  'captcha-required': {
    th: 'เบราว์เซอร์บล็อกระบบกันบอทอยู่ ลองปิดตัวบล็อกโฆษณาแล้วลองใหม่ หรือดูเดโมที่อัดไว้ได้เลย',
    en: 'Your browser blocked the bot check. Turn off the ad blocker and retry, or watch the recorded demo.',
  },
  'captcha-score': {
    th: 'ระบบกันบอทยังไม่มั่นใจในเบราว์เซอร์นี้ รอสักครู่แล้วลองใหม่ หรือดูเดโมที่อัดไว้ได้เลย',
    en: "The bot check isn't sure about this browser yet. Wait a bit and retry, or watch the recorded demo.",
  },
  'captcha-failed': {
    th: 'ตรวจสอบกันบอทไม่ผ่าน รีเฟรชหน้าแล้วลองใหม่ หรือดูเดโมที่อัดไว้ได้เลย',
    en: 'The bot check failed. Refresh the page and retry, or watch the recorded demo.',
  },
};
FRIENDLY['captcha-action'] = FRIENDLY['captcha-failed'];

export const LOW_TRUST_PER_IP_HOUR = 1;
export const LOW_TRUST_PER_HOUR = 20;

export function captchaFailure(error) {
  return {
    error,
    friendly: FRIENDLY[error] || FRIENDLY['captcha-failed'],
    fallback: 'scenarios',
    retryable: error !== 'captcha-action',
  };
}

export function captchaGate({ action, scope = action }) {
  return async (req, res, next) => {
    const token = req.body?.recaptchaToken || req.body?.captchaToken || req.get?.('x-recaptcha-token') || '';
    const v = await verifyCaptcha(token, { action });
    if (v.ok) {
      req.captcha = { ...v, lowTrust: false };
      return next();
    }
    if (v.error === 'captcha-score') {
      const ip = req.ip || req.socket?.remoteAddress || 'unknown';
      const perIp = take(`captcha:low:${scope}:ip:${ip}`, LOW_TRUST_PER_IP_HOUR, 3600000);
      if (perIp.ok && take(`captcha:low:${scope}`, LOW_TRUST_PER_HOUR, 3600000).ok) {
        console.warn(`[captcha] low score ${v.score} → low-trust pass (${scope})`);
        req.captcha = { ...v, ok: true, lowTrust: true };
        return next();
      }
    }
    res.status(v.error === 'captcha-required' ? 400 : 403).json(captchaFailure(v.error));
  };
}
