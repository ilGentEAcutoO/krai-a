// reCAPTCHA Enterprise assessments (v3 score, invisible — no checkbox).
// Cloud-native: server calls assessments.create with a restricted API key
// (key locked to recaptchaenterprise.googleapis.com, secret-side only).
// Empty apiKey = gate disabled (dev default, like other adapters).
// Fail-open ONLY on Google outage/timeout (availability for a demo);
// explicit reject, bad token, or low score always fails closed.
import { config } from './config.js';

export const captchaRequired = () => config.recaptchaApiKey.length > 10;

export async function verifyCaptcha(token, { action = '', fetchImpl = fetch } = {}) {
  if (!captchaRequired()) return { ok: true, skipped: true };
  if (!token) return { ok: false, error: 'captcha-required' };
  const url = `https://recaptchaenterprise.googleapis.com/v1/projects/${config.recaptchaProjectId}/assessments?key=${config.recaptchaApiKey}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
