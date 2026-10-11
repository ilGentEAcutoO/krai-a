// Demo API: full call loop without a phone — same persona + verdict +
// notify path as the Twilio adapter. Judges can run scripted scenarios or
// freestyle-type as the caller.
import { Router } from 'express';
import { config, isLiveAI } from './config.js';
import {
  findMember, createCall, getCall, addTurn, setVerdict, endCall, listCalls,
  listMembers, isWhitelisted, addMember, getMemberById, getMemberByOwner,
  setForwardingConfirmed, addWhitelist, removeWhitelist, addWatcher,
  removeWatcher, callsByMember, PLANS, planOf, trialDaysLeft, TRIAL_DAYS,
  addNumber, setPlan, setLineUserId, cancelMember, reactivateMember,
  seatCap, requestSeat, confirmSeat, pruneSeats, ADDON_SEAT, MAX_HOUSEHOLD_SEATS,
  deleteCall, clearReputation, getMemberByLineUserId, TOPUP_PACKS, quotaSummary,
  consumeMinutes, setAutoTopup, AUTO_TOPUP_MIN_THRESHOLD, AUTO_TOPUP_MAX_THRESHOLD,
} from './store.js';
import { openingLine, personaReply, closingLine } from './ai.js';
import { judge, shouldEndNow, auditDecision, talkBudgetMinutes } from './verdict.js';
import { notifyOwner, maybeNotifyQuotaLow } from './notify/index.js';
import { SCRIPTS, getScript } from './demoScripts.js';
import { normalizePhone, requestOtp, verifyOtp, createSession, destroySession, requireAuth, peekOtpForMockSms } from './auth.js';
import { sendOtpSms, checkOtpLive, smsMode } from './sms.js';
import { assignNumber, markAssigned, poolStatus } from './numbers.js';
import { buildEvidenceBundle } from './evidence.js';
import { billingConfigured } from './billing.js';
import { verifyLineIdToken } from './line/verify.js';
import { getPublicStats } from './stats.js';
import { verifyCaptcha } from './recaptcha.js';
import { take } from './ratelimit.js';

const publicMember = (m) => ({
  id: m.id, ownerPhone: m.ownerPhone, aiNumber: m.aiNumber, numbers: m.numbers,
  plan: m.plan, planMeta: planOf(m), trialDaysLeft: trialDaysLeft(m),
  minutesUsed: m.minutesUsed, forwardingConfirmed: m.forwardingConfirmed,
  seatsPaid: m.seatsPaid || 0,
  whitelisted: m.whitelisted, familyWatchers: m.familyWatchers,
  lineUserId: m.lineUserId, active: m.active, cancelledAt: m.cancelledAt,
  createdAt: m.createdAt, trialEndsAt: m.trialEndsAt,
});

export function demoRouter(broadcast) {
  const r = Router();
  const auth = requireAuth(getMemberById);
  const clientIp = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

  const budgetOf = (call, member) => {
    const minutes = talkBudgetMinutes(member);
    return {
      minutes: Number.isFinite(minutes) ? minutes : null, // null = unlimited
      elapsedMin: Math.max(0, Math.floor((Date.now() - Date.parse(call.startedAt)) / 60000)),
      turnsMax: config.maxTurnsPerCall,
    };
  };

  // Canned verdict for demo calls that die without evidence (replaced or
  // idle) — $0, no AI call, no owner notify.
  const cannedUnsure = (reason) => ({
    verdict: 'UNSURE', confidence: 0.4, claimedIdentity: 'unknown',
    requestedAction: 'unknown', pressureSignals: [], matchesKnownScam: false,
    reason, reasonEn: 'Demo call ended before any evidence.', engine: 'none',
    action: 'END_UNSURE', actionTh: 'จบสาย demo ที่ไม่มีหลักฐาน',
    closingLine: closingLine('UNSURE'), judgedAt: new Date().toISOString(),
  });

  // ---- Single-shot scam analysis (landing widget, no call record) ----
  // No UI sender yet, so rate limits only (no CAPTCHA token to check).
  r.post('/analyze', async (req, res) => {
    const g = take('analyze', config.analyzeMaxPerHour, 3600000);
    if (!g.ok) return res.status(429).json({ error: 'analyze-rate-limited', retryAfterSec: g.retryAfterSec });
    const perIp = take(`analyze:ip:${clientIp(req)}`, config.analyzeMaxPerIpMin, 60000);
    if (!perIp.ok) return res.status(429).json({ error: 'analyze-rate-limited', retryAfterSec: perIp.retryAfterSec });
    const text = String(req.body?.text || '').trim().slice(0, 1000);
    if (text.length < 4) return res.status(400).json({ error: 'text-too-short' });
    const call = { turns: [{ role: 'assistant', text: openingLine() }, { role: 'caller', text }] };
    const verdict = await judge({ call, member: null, isWhitelistedCaller: false });
    res.json({ verdict });
  });

  r.get('/status', (req, res) => {
    res.json({
      engine: isLiveAI() ? 'gemini' : 'rules',
      model: config.geminiModel,
      identifyMode: config.identifyMode,
      notifyAdapters: config.notifyAdapters,
      twilio: Boolean(config.twilioAccountSid),
      liffId: config.liffId,
      recaptchaSiteKey: config.recaptchaSiteKey,
      demoNumber: config.demoNumber || listMembers()[0]?.aiNumber || '',
    });
  });

  r.get('/demo/scripts', (req, res) => res.json({ scripts: SCRIPTS }));

  // Public trust stats (landing strip + /stats.html). Aggregate-only —
  // per-metric `shown` flags already apply the brag-gate minimums, so the
  // frontend hides weak numbers instead of second-guessing them.
  r.get('/stats', (req, res) => res.json(getPublicStats()));

  r.get('/members', (req, res) => res.json({ members: listMembers() }));
  r.get('/calls', (req, res) => res.json({ calls: listCalls() }));
  r.get('/calls/:id', (req, res) => {
    const call = getCall(req.params.id);
    if (!call) return res.status(404).json({ error: 'call not found' });
    res.json({ call });
  });

  // Start a simulated inbound call.
  r.post('/demo/call', async (req, res) => {
    // Guard 1: hourly caps — the public page must not drain the AI budget.
    // Limits run before CAPTCHA so floods burn no Google round-trip.
    const ip = clientIp(req);
    const g = take('demo:start', config.demoMaxCallsPerHour, 3600000);
    if (!g.ok) return res.status(429).json({ error: 'demo-rate-limited', retryAfterSec: g.retryAfterSec });
    const perIp = take(`demo:start:ip:${ip}`, config.demoMaxCallsPerIpHour, 3600000);
    if (!perIp.ok) return res.status(429).json({ error: 'demo-rate-limited', retryAfterSec: perIp.retryAfterSec });
    // Guard 1b: reCAPTCHA v3 (invisible). Missing token fails closed when
    // the gate is configured — bots must solve, not just omit.
    const v = await verifyCaptcha(req.body?.recaptchaToken, { action: 'demo_call' });
    if (!v.ok) return res.status(v.error === 'captcha-required' ? 400 : 403).json({ error: v.error });
    const member = listMembers()[0];
    if (!member) return res.status(500).json({ error: 'no seed member' });
    // Guard 2: one active demo call — auto-end the abandoned one ($0 close,
    // no owner notify: demo sessions are visitors playing, not evidence).
    let replacedCallId = null;
    for (const c of listCalls(200)) {
      if (c.source === 'demo' && !c.endedAt) {
        replacedCallId = c.id;
        if (!c.verdict) setVerdict(c.id, cannedUnsure('สาย demo ถูกแทนที่ก่อนมีหลักฐาน'));
        endCall(c.id);
      }
    }
    const script = req.body?.scriptId ? getScript(req.body.scriptId) : null;
    const callerPhone = req.body?.callerPhone || script?.callerPhone || '+66819998888';
    const call = createCall({ memberId: member.id, callerPhone, aiNumber: member.aiNumber, source: 'demo' });
    const greeting = openingLine();
    addTurn(call.id, 'assistant', greeting);
    const payload = {
      call, budget: budgetOf(call, member), replacedCallId,
      script: script ? { id: script.id, lines: script.lines, expected: script.expected } : null,
    };
    broadcast({ type: 'call-update', ...payload });
    res.json(payload);
  });

  // One caller utterance -> verdict update + assistant reply (or call end).
  r.post('/demo/turn', async (req, res) => {
    const { callId, text } = req.body || {};
    const call = getCall(callId);
    if (!call || call.endedAt) return res.status(404).json({ error: 'call not found or ended' });
    if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
    const member = listMembers().find((m) => m.id === call.memberId);
    // Guard 3: idle demo calls close without spending another AI turn.
    const lastAt = call.turns.length ? Date.parse(call.turns[call.turns.length - 1].at) : Date.parse(call.startedAt);
    if (Date.now() - lastAt > config.demoIdleMinutes * 60000) {
      const verdict = call.verdict || cannedUnsure('สาย demo หมดเวลาเงียบก่อนมีหลักฐาน');
      setVerdict(call.id, verdict);
      endCall(call.id);
      consumeMinutes(member, call.minutesBilled);
      await maybeNotifyQuotaLow(member);
      addTurn(call.id, 'assistant', verdict.closingLine);
      const payload = { call: getCall(call.id), ended: true, verdict, idleTimeout: true, budget: budgetOf(call, member) };
      broadcast({ type: 'call-update', ...payload });
      return res.json(payload);
    }
    addTurn(call.id, 'caller', text.trim());

    const verdict = await judge({ call, member, isWhitelistedCaller: isWhitelisted(member, call.callerPhone) });
    setVerdict(call.id, verdict);
    auditDecision(call, verdict);
    const callerTurns = call.turns.filter((t) => t.role === 'caller').length;
    const budgetMinutes = talkBudgetMinutes(member);
    const elapsedMs = Date.now() - Date.parse(call.startedAt);
    const budgetHit = elapsedMs >= budgetMinutes * 60000;

    if (shouldEndNow({ verdict, turnCount: callerTurns, elapsedMs, budgetMinutes })) {
      endCall(call.id);
      consumeMinutes(member, call.minutesBilled);
      await maybeNotifyQuotaLow(member);
      const notify = await notifyOwner({ call, member, verdict }).catch((e) => ({ error: e.message }));
      addTurn(call.id, 'assistant', verdict.closingLine);
      const payload = {
        call: getCall(call.id), ended: true, verdict, notify, budget: budgetOf(call, member),
        endReason: budgetHit ? 'budget' : (callerTurns >= config.maxTurnsPerCall ? 'max-turns' : 'verdict'),
      };
      broadcast({ type: 'call-update', ...payload });
      return res.json(payload);
    }

    const reply = await personaReply(
      call.turns.map((t) => `${t.role}: ${t.text}`).join('\n'), callerTurns,
      { turnsLeft: config.maxTurnsPerCall - callerTurns },
    );
    addTurn(call.id, 'assistant', reply.text);
    const payload = { call: getCall(call.id), ended: false, verdict, reply: reply.text, replyEngine: reply.engine, budget: budgetOf(call, member) };
    broadcast({ type: 'call-update', ...payload });
    res.json(payload);
  });

  // ---- LINE login (LIFF): exchange ID token for a session ----
  r.post('/auth/line-verify', async (req, res) => {
    const v = await verifyLineIdToken(req.body?.idToken);
    if (!v.ok) return res.status(v.error === 'line-unreachable' ? 502 : 401).json({ error: v.error });
    const member = getMemberByLineUserId(v.lineUserId);
    // Unknown LINE id: no orphan member (empty ownerPhone can never OTP).
    // Client verifies phone OTP first, then binds via POST /me/link-line.
    if (!member) return res.json({ ok: true, needsLink: true });
    const token = createSession(member.id);
    res.json({ ok: true, token, isNew: false, member: publicMember(member) });
  });

  // ---- Auth (browser-locked sessions) ----
  r.post('/auth/request-otp', async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'invalid-phone' });
    const req_ = requestOtp(phone);
    if (!req_.ok) return res.status(429).json({ error: req_.error });
    const sent = await sendOtpSms(phone, peekOtpForMockSms(phone));
    if (!sent.ok) return res.status(502).json({ error: 'sms-failed', detail: sent.detail });
    res.json({ ok: true, mode: sent.mode, ...(sent.devCode ? { devCode: sent.devCode } : {}) });
  });

  r.post('/auth/verify-otp', async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'invalid-phone' });
    const v = smsMode() === 'twilio-verify'
      ? await checkOtpLive(phone, req.body?.code)
      : verifyOtp(phone, req.body?.code);
    if (!v.ok) return res.status(v.error === 'verify-unavailable' ? 502 : 400).json({ error: v.error, attemptsLeft: v.attemptsLeft });
    let member = getMemberByOwner(phone);
    let isNew = false;
    if (!member) {
      const num = await assignNumber();
      if (!num.ok) return res.status(503).json({ error: num.error });
      const plan = PLANS[req.body?.plan] ? req.body.plan : 'starter-20';
      member = addMember({ ownerPhone: phone, aiNumber: num.number, plan });
      isNew = true;
    }
    markAssigned(member.aiNumber);
    const token = createSession(member.id);
    res.json({ token, member: publicMember(member), isNew });
  });

  r.post('/auth/logout', (req, res) => {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (token) destroySession(token);
    res.json({ ok: true });
  });

  // ---- Member self-service ----
  r.get('/me', auth, (req, res) => res.json({ member: publicMember(req.member) }));

  r.post('/me/forwarding', auth, (req, res) => {
    const m = setForwardingConfirmed(req.member.id, req.body?.confirmed !== false);
    res.json({ member: publicMember(m) });
  });

  r.get('/me/whitelist', auth, (req, res) => res.json({ whitelisted: req.member.whitelisted }));
  r.post('/me/whitelist', auth, (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'invalid-phone' });
    if (phone === req.member.ownerPhone) return res.status(400).json({ error: 'cannot-whitelist-self' });
    const list = addWhitelist(req.member.id, {
      phone,
      label: String(req.body?.label || '').slice(0, 40) || 'family',
      safeWord: String(req.body?.safeWord || '').slice(0, 40),
    });
    res.json({ whitelisted: list });
  });
  r.delete('/me/whitelist', auth, (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'invalid-phone' });
    res.json({ whitelisted: removeWhitelist(req.member.id, phone) });
  });

  r.get('/me/watchers', auth, (req, res) => res.json({ watchers: req.member.familyWatchers }));
  r.post('/me/watchers', auth, (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'invalid-phone' });
    if (req.member.familyWatchers.length >= planOf(req.member).watchers) {
      return res.status(403).json({ error: 'plan-limit', max: planOf(req.member).watchers });
    }
    res.json({ watchers: addWatcher(req.member.id, phone) });
  });
  r.delete('/me/watchers', auth, (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'invalid-phone' });
    res.json({ watchers: removeWatcher(req.member.id, phone) });
  });

  r.get('/me/calls', auth, (req, res) => res.json({ calls: callsByMember(req.member.id) }));

  // Evidence bundle for AOC 1441 / police reports (owner only).
  r.get('/me/calls/:id/export', auth, (req, res) => {
    const call = getCall(req.params.id);
    if (!call || call.memberId !== req.member.id) return res.status(404).json({ error: 'call not found' });
    res.json({ bundle: buildEvidenceBundle(call) });
  });

  // Erasure (owner deletes their own call record).
  r.delete('/me/calls/:id', auth, (req, res) => {
    const call = getCall(req.params.id);
    if (!call || call.memberId !== req.member.id) return res.status(404).json({ error: 'call not found' });
    deleteCall(call.id);
    res.json({ ok: true });
  });

  // Appeal: owner clears a wrongly-flagged (innocent) number immediately.
  r.delete('/me/reputation', auth, (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'invalid-phone' });
    res.json({ ok: true, cleared: clearReputation(req.member.id, phone) });
  });
  r.get('/me/usage', auth, (req, res) => {
    const q = quotaSummary(req.member);
    res.json({
      minutesUsed: q.used,
      quota: q.quota,
      trialDaysLeft: trialDaysLeft(req.member),
      trialDays: TRIAL_DAYS,
      callsThisMonth: q.callsUsed,
      callsQuota: q.callsQuota,
      pool: poolStatus(),
    });
  });

  // Quota meter for LIFF settings/status: remaining/used/reset + packs.
  r.get('/me/quota', auth, (req, res) => res.json({
    ...quotaSummary(req.member),
    packs: TOPUP_PACKS,
    canTopup: billingConfigured(),
    autoTopupBounds: { min: AUTO_TOPUP_MIN_THRESHOLD, max: AUTO_TOPUP_MAX_THRESHOLD },
  }));

  // Auto-billing toggle. body: { enabled, threshold?, pack? }. Card members
  // with a saved card get auto-charged when remaining <= threshold;
  // PromptPay/unknown members get manualTopup=true (pay by hand instead).
  r.post('/me/auto-topup', auth, (req, res) => {
    const { enabled, threshold, pack } = req.body || {};
    if (pack !== undefined && !TOPUP_PACKS[pack]) return res.status(400).json({ error: 'invalid-pack' });
    if (threshold !== undefined && !Number.isFinite(Number(threshold))) {
      return res.status(400).json({ error: 'invalid-threshold' });
    }
    const autoTopup = setAutoTopup(req.member, { enabled, threshold, pack });
    const q = quotaSummary(req.member);
    res.json({ autoTopup, quota: q, manualTopup: q.autoTopup.manualPrompt && !q.autoTopup.due });
  });

  // Plans, family numbers, notify channel, cancel — all self-service, no support ticket.
  r.get('/plans', (req, res) => res.json({ plans: PLANS, addon: ADDON_SEAT, trialDays: TRIAL_DAYS }));

  r.post('/me/plan', auth, (req, res) => {
    const m = setPlan(req.member.id, req.body?.plan);
    if (!m) return res.status(400).json({ error: 'invalid-plan' });
    res.json({ member: publicMember(m) });
  });

  r.get('/me/numbers', auth, (req, res) => {
    pruneSeats(req.member.id);
    const m = req.member;
    res.json({
      numbers: m.numbers,
      max: seatCap(m),
      pending: (m.pendingSeats || []).map((s) => ({ aiNumber: s.aiNumber, ownerPhone: s.ownerPhone })),
      seatPrice: ADDON_SEAT,
    });
  });
  // Extra seats are OTP-gated. Step 1 — request: reserve an AI number and text
  // a code to the NEW member's own phone. Step 2 — /verify activates it.
  r.post('/me/numbers', auth, async (req, res) => {
    const m = req.member;
    pruneSeats(m.id);
    const ownerPhone = normalizePhone(req.body?.ownerPhone);
    if (!ownerPhone) return res.status(400).json({ error: 'invalid-phone' });
    const existing = (m.pendingSeats || []).find((s) => s.ownerPhone === ownerPhone);
    let aiNumber = existing?.aiNumber;
    if (!aiNumber) { // resends skip the cap: they reuse, not consume
      const used = m.numbers.length + (m.pendingSeats || []).length;
      const cap = seatCap(m);
      if (used >= cap) {
        if (cap >= MAX_HOUSEHOLD_SEATS) return res.status(403).json({ error: 'seat-cap', max: cap });
        if (m.plan !== 'family-149') return res.status(403).json({ error: 'plan-limit', max: cap });
        return res.status(402).json({ error: 'seat-payment-required', seatPrice: ADDON_SEAT });
      }
      const num = await assignNumber();
      if (!num.ok) return res.status(503).json({ error: num.error });
      aiNumber = num.number;
    }
    const seat = requestSeat(m.id, aiNumber, ownerPhone);
    if (!seat) return res.status(403).json({ error: 'seat-cap', max: seatCap(m) });
    const req_ = requestOtp(ownerPhone);
    if (!req_.ok) return res.status(429).json({ error: req_.error });
    const sent = await sendOtpSms(ownerPhone, peekOtpForMockSms(ownerPhone));
    if (!sent.ok) return res.status(502).json({ error: 'sms-failed', detail: sent.detail });
    res.json({ pending: true, aiNumber, mode: sent.mode, ...(sent.devCode ? { devCode: sent.devCode } : {}) });
  });

  // Step 2 — verify: the code went to the NEW member's phone, not the owner's.
  r.post('/me/numbers/verify', auth, async (req, res) => {
    const m = req.member;
    pruneSeats(m.id);
    const seat = (m.pendingSeats || []).find((s) => s.aiNumber === req.body?.aiNumber);
    if (!seat) return res.status(404).json({ error: 'seat-not-found' });
    const v = smsMode() === 'twilio-verify'
      ? await checkOtpLive(seat.ownerPhone, req.body?.code)
      : verifyOtp(seat.ownerPhone, req.body?.code);
    if (!v.ok) return res.status(400).json({ error: v.error, attemptsLeft: v.attemptsLeft });
    res.json({ numbers: confirmSeat(m.id, seat.aiNumber) });
  });

  // LINE is optional: dashboard inbox always works; add a LINE user ID to also push there.
  r.post('/me/notify', auth, (req, res) => {
    const m = setLineUserId(req.member.id, req.body?.lineUserId || '');
    res.json({ member: publicMember(m) });
  });

  // Bind a LINE id to the CURRENT phone-OTP member. The idToken proves
  // ownership of the LINE account; the session proves the phone account.
  // 409 when that LINE id already belongs to a different member.
  r.post('/me/link-line', auth, async (req, res) => {
    const v = await verifyLineIdToken(req.body?.idToken);
    if (!v.ok) return res.status(v.error === 'line-unreachable' ? 502 : 401).json({ error: v.error });
    const other = getMemberByLineUserId(v.lineUserId);
    if (other && other.id !== req.member.id) return res.status(409).json({ error: 'line-already-linked' });
    const m = setLineUserId(req.member.id, v.lineUserId);
    res.json({ ok: true, member: publicMember(m) });
  });

  // Cancel anytime: membership stops screening immediately (##21# stops forwarding on your phone).
  r.post('/me/cancel', auth, (req, res) => {
    res.json({ member: publicMember(cancelMember(req.member.id)) });
  });
  r.post('/me/reactivate', auth, (req, res) => {
    res.json({ member: publicMember(reactivateMember(req.member.id)) });
  });

  // Force-end (owner hangup / judge skip).
  r.post('/demo/end', async (req, res) => {
    const call = getCall(req.body?.callId);
    if (!call || call.endedAt) return res.status(404).json({ error: 'call not found or ended' });
    const member = listMembers().find((m) => m.id === call.memberId);
    const verdict = call.verdict || (await judge({ call, member, isWhitelistedCaller: false }));
    setVerdict(call.id, verdict);
    auditDecision(call, verdict);
    endCall(call.id);
    consumeMinutes(member, call.minutesBilled);
    await maybeNotifyQuotaLow(member);
    addTurn(call.id, 'assistant', verdict.closingLine);
    const notify = await notifyOwner({ call, member, verdict }).catch((e) => ({ error: e.message }));
    const payload = { call: getCall(call.id), ended: true, verdict, notify, endReason: 'hangup', budget: budgetOf(call, member) };
    broadcast({ type: 'call-update', ...payload });
    res.json(payload);
  });

  return r;
}
