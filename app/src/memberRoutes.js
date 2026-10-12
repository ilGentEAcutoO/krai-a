// Member app API for central-number households (web dashboard + LIFF share
// it via public/member-core.js). Protected people are added only after an
// OTP sent to THAT phone (the person reads the code out = consent), and can
// withdraw that consent themselves at /withdraw.html.
import { Router } from 'express';
import { getMemberById, listMembers } from './store.js';
import { requireAuth, sendOtp, checkOtp } from './auth.js';
import { smsMode } from './sms.js';
import { captchaGate } from './recaptcha.js';
import { safe } from './asyncRoute.js';
import { verifyLineIdToken } from './line/verify.js';
import { take } from './ratelimit.js';
import { config } from './config.js';
import { toLocalNumber } from './numbers.js';
import { notifyPayer } from './lifecycle.js';
import {
  toE164, requestProtected, confirmProtected, addSelfProtected, removeProtected,
  joinWaitlist, linkWatcherLine, publicHousehold, findProtected, withdrawProtected,
} from './household.js';

const WATCH_SENDS_PER_IP_HOUR = 10;
const WITHDRAW_REQUEST_PER_IP_HOUR = 10;
const WITHDRAW_VERIFY_PER_IP_HOUR = 20;
// Public withdraw routes: a cheap per-IP limit runs BEFORE captchaGate, so a
// flood can't burn reCAPTCHA assessments (or guess codes).
const perIpLimit = (name, max) => (req, res, next) => {
  const g = take(`withdraw:${name}:ip:${req.ip || 'unknown'}`, max, 3600000);
  if (!g.ok) return res.status(429).json({ error: 'too-many-requests', retryAfterSec: g.retryAfterSec });
  next();
};
const withdrawRequestLimit = perIpLimit('req', WITHDRAW_REQUEST_PER_IP_HOUR);
const withdrawVerifyLimit = perIpLimit('verify', WITHDRAW_VERIFY_PER_IP_HOUR);
const isWatcher = (phone) => listMembers().some((m) => (m.familyWatchers || []).includes(phone));
const isPendingAnywhere = (phone) => listMembers().some((m) => (m.pendingProtected || []).some((s) => s.phone === phone));
const otpFail = (res, sent) => res.status(sent.status || 502).json({
  error: sent.error || 'sms-failed', ...(sent.retryAfterSec ? { retryAfterSec: sent.retryAfterSec } : {}),
});
const codeFail = (res, v) => res.status(v.error === 'verify-unavailable' ? 502 : 400).json({ error: v.error, attemptsLeft: v.attemptsLeft });

// Every SMS says what its code is for — never mistakable for a login code.
const site = () => (config.publicBaseUrl || 'https://krai-a.com').replace(/^https?:\/\//, '');
const protectSms = (requester) => (code) => `ใครอะ: ${toLocalNumber(requester)} ขอให้ AI รับสายแปลกแทนเบอร์นี้และจะเห็นบทสนทนา รหัสยินยอม ${code} บอกเฉพาะคนนี้ (ไม่ใช่รหัสเข้าระบบ) ถอนได้ที่ ${site()}/withdraw.html`;
const withdrawSms = (code) => `ใครอะ: รหัส ${code} สำหรับถอนเบอร์นี้ออกจากการรับสายแทน — ไม่ใช่รหัสเข้าสู่ระบบ อย่าบอกใคร`;
const watcherSms = (code) => `ใครอะ: รหัส ${code} สำหรับรับแจ้งเตือนครอบครัวใน LINE — ไม่ใช่รหัสเข้าสู่ระบบ อย่าบอกใคร`;
const RELATION_TH = { self: 'ตัวคุณ', mother: 'แม่', father: 'พ่อ', grandparent: 'ปู่ย่าตายาย', child: 'ลูก', partner: 'คู่ชีวิต', other: 'คนในบ้าน' };

export function memberRouter() {
  const r = Router();
  const auth = requireAuth(getMemberById);
  const snapshot = (m) => ({ household: publicHousehold(m) });

  r.get('/me/household', auth, (req, res) => res.json(snapshot(req.member)));

  // Step 1: reserve a seat, text the code to the person being protected.
  r.post('/me/protected', auth, safe(async (req, res) => {
    const m = req.member;
    const seat = requestProtected(m, { phone: req.body?.phone, label: req.body?.label });
    if (!seat.ok) {
      const status = seat.error === 'invalid-phone' ? 400 : seat.error === 'plan-limit' ? 403 : 409;
      return res.status(status).json({ error: seat.error, ...(seat.max ? { max: seat.max } : {}) });
    }
    const phone = seat.pending.phone;
    const sent = await sendOtp(phone, 'protect', { ip: req.ip, message: protectSms(m.ownerPhone) }); // purpose-scoped: never a login code
    if (!sent.ok) return otpFail(res, sent);
    res.json({ pending: true, phone, mode: sent.mode, ...(sent.devCode ? { devCode: sent.devCode } : {}) });
  }));

  // Step 2: the code from that phone activates protection.
  r.post('/me/protected/verify', auth, safe(async (req, res) => {
    const m = req.member;
    const phone = toE164(req.body?.phone);
    if (!phone || !(m.pendingProtected || []).some((s) => s.phone === phone)) {
      return res.status(404).json({ error: 'seat-not-found' });
    }
    const v = await checkOtp(phone, req.body?.code, 'protect');
    if (!v.ok) return codeFail(res, v);
    if (!confirmProtected(m, phone)) return res.status(404).json({ error: 'seat-not-found' });
    res.json(snapshot(m));
  }));

  // The account phone already passed OTP at signup — no second code.
  r.post('/me/protected/self', auth, (req, res) => {
    const out = addSelfProtected(req.member);
    if (out?.error) return res.status(out.error === 'plan-limit' ? 403 : 409).json(out);
    res.json(snapshot(req.member));
  });

  r.delete('/me/protected', auth, (req, res) => {
    const phone = toE164(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'invalid-phone' });
    removeProtected(req.member, phone);
    res.json(snapshot(req.member));
  });

  // Central number not live yet: how the member wants to hear about it.
  r.post('/me/waitlist', auth, (req, res) => {
    joinWaitlist(req.member, { channel: req.body?.channel });
    res.json(snapshot(req.member));
  });

  // ---- consent withdrawal: the protected person, not the payer ----
  // Own OTP purpose 'withdraw': a withdraw code can never confirm a pending
  // consent request (and vice versa), so "read me the code to cancel" can't
  // be turned into consent. No lookup oracle: the reply is always {ok:true},
  // sent BEFORE any SMS work, and send errors are swallowed — protected and
  // unknown phones look the same (status, shape, timing). reCAPTCHA-gated
  // (public endpoint). Dev mock mode only (never production) waits for the
  // send so the code can be shown in the browser.
  r.post('/withdraw/request-otp', withdrawRequestLimit, captchaGate({ action: 'withdraw' }), safe(async (req, res) => {
    const phone = toE164(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'invalid-phone' });
    const target = findProtected(phone) || isPendingAnywhere(phone);
    const send = () => (target ? sendOtp(phone, 'withdraw', { ip: req.ip, message: withdrawSms }) : Promise.resolve({ ok: true }));
    if (smsMode() === 'mock' && process.env.NODE_ENV !== 'production') {
      const sent = await send().catch(() => ({}));
      return res.json({ ok: true, ...(sent.devCode ? { devCode: sent.devCode } : {}) });
    }
    res.json({ ok: true });
    send().catch((e) => console.error('[withdraw] send failed', e.message));
  }));

  // Verify answers every failure identically — no code, expired, locked out
  // or wrong, protected or unknown phone: 400 {error:'wrong-code'}, no
  // attemptsLeft — so it can't be used to enumerate protected numbers.
  r.post('/withdraw', withdrawVerifyLimit, captchaGate({ action: 'withdraw' }), safe(async (req, res) => {
    const phone = toE164(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'invalid-phone' });
    const v = await checkOtp(phone, req.body?.code, 'withdraw').catch(() => ({ ok: false }));
    if (!v.ok) return res.status(400).json({ error: 'wrong-code' });
    const out = withdrawProtected(phone);
    if (out.withdrawn) {
      const who = RELATION_TH[out.label] || out.label;
      await notifyPayer(out.member, `ใครอะ: ${who} (${toLocalNumber(phone)}) ถอนความยินยอมแล้ว AI จะไม่รับสายแทนเบอร์นี้อีก`);
    }
    res.json({ ok: true, withdrawn: out.withdrawn });
  }));

  // A family watcher opens the invite in LINE: the ID token proves the LINE
  // account, the OTP proves the phone the owner listed. Then alerts reach them.
  // Sending needs a LINE login too, and texts only listed watcher phones (no
  // anonymous SMS pumping) while answering the same way for any phone.
  r.post('/watchers/request-otp', safe(async (req, res) => {
    const perIp = take(`otp:watch:ip:${req.ip || 'unknown'}`, WATCH_SENDS_PER_IP_HOUR, 3600000);
    if (!perIp.ok) return res.status(429).json({ error: 'too-many-requests', retryAfterSec: perIp.retryAfterSec });
    const line = await verifyLineIdToken(req.body?.idToken);
    if (!line.ok) return res.status(line.error === 'line-unreachable' ? 502 : 401).json({ error: line.error });
    const phone = toE164(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'invalid-phone' });
    if (!isWatcher(phone)) return res.json({ ok: true }); // same reply either way: no watcher-list oracle
    const sent = await sendOtp(phone, 'watcher', { ip: req.ip, message: watcherSms });
    if (!sent.ok) return otpFail(res, sent);
    res.json({ ok: true, mode: sent.mode, ...(sent.devCode ? { devCode: sent.devCode } : {}) });
  }));

  r.post('/watchers/link', safe(async (req, res) => {
    const line = await verifyLineIdToken(req.body?.idToken);
    if (!line.ok) return res.status(line.error === 'line-unreachable' ? 502 : 401).json({ error: line.error });
    const phone = toE164(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'invalid-phone' });
    const v = await checkOtp(phone, req.body?.code, 'watcher');
    if (!v.ok) return res.status(400).json({ error: v.error, attemptsLeft: v.attemptsLeft });
    const linked = linkWatcherLine(phone, line.lineUserId);
    if (!linked) return res.status(404).json({ error: 'not-a-watcher' });
    res.json({ ok: true, linked });
  }));

  return r;
}
