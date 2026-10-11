// SMS adapter for OTP delivery. Modes (priority order):
//   thsms         — THSMS V2 raw SMS for +66 (final stack: we generate +
//                   verify the code locally; THSMS only delivers it).
//   twilio-verify — legacy managed-Verify path (kept as fallback; the
//                   finalized stack does not pay managed-Verify fees).
//   mock          — returns the code to the caller (shown in-browser).
import { config } from './config.js';

const THSMS_API = 'https://thsms.com/api';

export const smsMode = () => (
  config.thsmsApiKey ? 'thsms'
    : config.twilioVerifySid ? 'twilio-verify'
      : 'mock'
);

// E.164 +668... -> local 08... for the THSMS msisdn field.
export function toLocalMsisdn(phone) {
  const p = String(phone || '');
  if (p.startsWith('+66')) return `0${p.slice(3)}`;
  return p.replace(/^\+/, '');
}

// One segment: Thai UCS-2 counts 70 chars — this stays ~30.
export function otpMessage(code) {
  return `ใครอ่ะ: รหัส OTP ของคุณคือ ${code}`;
}

async function sendThsms({ phone, code, fetchImpl, apiKey, sender }) {
  const payload = { msisdn: [toLocalMsisdn(phone)], message: otpMessage(code) };
  if (sender) payload.sender = sender;
  let res;
  try {
    res = await fetchImpl(`${THSMS_API}/send-sms`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { ok: false, mode: 'thsms', detail: 'transport-error' };
  }
  if (!res.ok) return { ok: false, mode: 'thsms', detail: `http-${res.status}` };
  return { ok: true, mode: 'thsms' };
}

// Zero-cost key/credit check (GET /api/me). Never throws, never logs the key.
export async function thsmsAccount({ fetchImpl = fetch, apiKey = config.thsmsApiKey } = {}) {
  if (!apiKey) return { ok: false, detail: 'thsms-unconfigured' };
  let res;
  try {
    res = await fetchImpl(`${THSMS_API}/me`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (e) {
    return { ok: false, detail: 'transport-error' };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, detail: `http-${res.status}` };
  return { ok: true, data };
}

export async function sendOtpSms(phone, code, { fetchImpl = fetch } = {}) {
  if (config.thsmsApiKey) {
    return sendThsms({ phone, code, fetchImpl, apiKey: config.thsmsApiKey, sender: config.thsmsSender });
  }
  if (config.twilioVerifySid && config.twilioAccountSid && config.twilioAuthToken) {
    const body = new URLSearchParams({ To: phone, Channel: 'sms' });
    const res = await fetch(
      `https://verify.twilio.com/v2/Services/${config.twilioVerifySid}/Verifications`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      },
    );
    if (!res.ok) return { ok: false, mode: 'twilio-verify', detail: `http-${res.status}` };
    return { ok: true, mode: 'twilio-verify' };
  }
  console.log(`[sms:mock → ${phone}] OTP ${code} (mock mode — shown in browser)`);
  return { ok: true, mode: 'mock', devCode: code };
}

// Live verification against Twilio Verify. The code the user received came
// from Twilio, NOT from requestOtp — never compare against the local map.
// Fail closed: transport errors and non-approved statuses both deny.
export async function checkOtpLive(phone, code) {
  const body = new URLSearchParams({ To: phone, Code: String(code).trim() });
  let res;
  try {
    res = await fetch(
      `https://verify.twilio.com/v2/Services/${config.twilioVerifySid}/VerificationCheck`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      },
    );
  } catch (e) {
    return { ok: false, error: 'verify-unavailable' };
  }
  if (!res.ok) return { ok: false, error: 'wrong-code' };
  const data = await res.json().catch(() => ({}));
  if (data.status === 'approved') return { ok: true };
  return { ok: false, error: 'wrong-code' };
}
