// Demo API: full call loop without a phone — same persona + verdict +
// notify path as the Twilio adapter. Judges can run scripted scenarios or
// freestyle-type as the caller.
import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { config, isLiveAI } from './config.js';
import {
  createCall, getCall, addTurn, setVerdict, endCall, listCalls,
  isWhitelisted, getMemberById, getMemberByOwner,
  setForwardingConfirmed, addWhitelist, removeWhitelist, addWatcher,
  removeWatcher, callsByMember, PLANS, GIFTS, TRIAL, planOf, trialDaysLeft, TRIAL_DAYS, watcherCap,
  setPlan, setLineUserId, cancelMember, reactivateMember,
  seatCap, requestSeat, confirmSeat, pruneSeats, ADDON_SEAT, MAX_HOUSEHOLD_SEATS,
  deleteCall, clearReputation, getMemberByLineUserId, TOPUP_PACKS, quotaSummary,
  setAutoTopup, AUTO_TOPUP_MIN_THRESHOLD, AUTO_TOPUP_MAX_THRESHOLD, deleteMember, activeSeats, trialUsedBefore,
} from './store.js';
import { openingLine, closingLine } from './ai.js';
import { judge, auditDecision, talkBudgetMinutes } from './verdict.js';
import { nextAction, personaReply, getEngineStatus } from './judge/index.js';
import { provisionMember, maskWhitelist, publicHousehold } from './household.js';
import { buildMessage, buildFlexMessage } from './notify/index.js';
import { SCRIPTS, getScript } from './demoScripts.js';
import {
  normalizePhone, sendOtp, checkOtp, createSession, destroySession, destroySessionsFor, requireAuth,
} from './auth.js';
import { assignNumber, markAssigned, poolStatus } from './numbers.js';
import { buildEvidenceBundle } from './evidence.js';
import { billingConfigured, priceIdFor } from './billing.js';
import { verifyLineIdToken } from './line/verify.js';
import { getPublicStats } from './stats.js';
import { captchaGate } from './recaptcha.js';
import { safe } from './asyncRoute.js';
import { farewellProtected } from './lifecycle.js';
import { take } from './ratelimit.js';

const publicMember = (m) => ({
  id: m.id, ownerPhone: m.ownerPhone, aiNumber: m.aiNumber, numbers: m.numbers,
  plan: m.plan, planMeta: planOf(m), trialDaysLeft: trialDaysLeft(m),
  minutesUsed: m.minutesUsed, forwardingConfirmed: m.forwardingConfirmed,
  seatsPaid: activeSeats(m), // unexpired 30-day seat periods
  whitelisted: maskWhitelist(m.whitelisted), familyWatchers: m.familyWatchers, // safe words never leave the server
  lineUserId: m.lineUserId, active: m.active, cancelledAt: m.cancelledAt,
  createdAt: m.createdAt, trialEndsAt: m.trialEndsAt,
  ...publicHousehold(m),
});

// Public demo endpoints may only ever touch calls the demo itself created.
const isDemoCall = (call) => call?.source === 'demo';

// Demo visitor scope: an HttpOnly cookie names the visitor, and calls keep
// only its hash — "one active demo call" is per visitor, never global, and
// neither value ever leaves through a payload.
const DEMO_COOKIE = 'ka_demo';
const VISITOR_ID = /^[0-9a-f]{32}$/;
const MAX_DEMO_TEXT = 500;
const TRIAL_USED_NOTICE = 'เบอร์นี้เคยใช้ช่วงทดลองแล้ว';
const DEMO_TURNS_PER_IP_MIN = 30;
const visitorKeyOf = (id) => createHash('sha256').update(`demo-visitor:${id}`).digest('hex').slice(0, 32);
const publicCall = (call) => {
  if (!call) return call;
  const { visitorKey, ...rest } = call;
  return rest;
};

function demoVisitor(req, res) {
  const found = /(?:^|;\s*)ka_demo=([^;]*)/.exec(req.headers.cookie || '')?.[1];
  if (found && VISITOR_ID.test(found)) return found;
  const id = randomBytes(16).toString('hex');
  res.append('Set-Cookie', `${DEMO_COOKIE}=${id}; Path=/api; Max-Age=86400; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`);
  return id;
}

// Demo household = SEED_MEMBER_PHONE (never "first member": after a restore
// or a signup race that could be a real customer).
const demoMember = () => getMemberByOwner(config.seedMemberPhone);

// Demo alerts are built exactly like the owner's LINE alert but returned for
// on-screen display only — a visitor's demo never pushes to anyone's LINE.
// Watcher phones stay off the anonymous payload.
function demoAlert(call, member, verdict) {
  const view = { ...member, familyWatchers: [] };
  return {
    message: { text: buildMessage({ call, member: view, verdict }).text },
    flex: buildFlexMessage({ call, member: view, verdict }),
    results: [], delivered: false, demo: true,
  };
}

// Plan change without payment may never grant more of anything.
const grantsMore = (to, from) => ['quota', 'calls', 'numbers'].some((k) => (to[k] || 0) > (from[k] || 0))
  || watcherCap(to) > watcherCap(from) || (to.tapes && !from.tapes);

// UI credit line: name exactly the engines whose last real call or probe
// worked ('jev+gemini' | 'jev' | 'gemini' | 'rules') — never a guess.
export function engineLabel(status) {
  const up = [status?.jev?.ok && 'jev', status?.gemini?.ok && 'gemini'].filter(Boolean);
  return up.length ? up.join('+') : 'rules';
}


// OTP replies: the dev code only exists in local mock mode (sendOtp refuses
// mock in production).
const otpSent = (sent, extra = {}) => ({ ...extra, mode: sent.mode, ...(sent.devCode ? { devCode: sent.devCode } : {}) });
const otpFailed = (res, sent) => res.status(sent.status || 502)
  .json({ error: sent.error || 'sms-failed', ...(sent.retryAfterSec ? { retryAfterSec: sent.retryAfterSec } : {}) });

export function demoRouter(broadcast) {
  const r = Router();
  const auth = requireAuth(getMemberById);
  const clientIp = (req) => req.ip || req.socket?.remoteAddress || 'unknown';
  const turnsInFlight = new Set(); // callId — one AI turn at a time per call
  const idleMs = () => config.demoIdleMinutes * 60000;
  const lastActivity = (call) => Date.parse(call.turns.at(-1)?.at || call.startedAt);

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
  // Spends AI live: rate limits first (floods burn no Google round-trip),
  // then the CAPTCHA gate.
  const analyzeLimits = (req, res, next) => {
    const g = take('analyze', config.analyzeMaxPerHour, 3600000);
    if (!g.ok) return res.status(429).json({ error: 'analyze-rate-limited', retryAfterSec: g.retryAfterSec });
    const perIp = take(`analyze:ip:${clientIp(req)}`, config.analyzeMaxPerIpMin, 60000);
    if (!perIp.ok) return res.status(429).json({ error: 'analyze-rate-limited', retryAfterSec: perIp.retryAfterSec });
    next();
  };
  r.post('/analyze', analyzeLimits, captchaGate({ action: 'analyze' }), safe(async (req, res) => {
    const text = String(req.body?.text || '').trim().slice(0, 1000);
    if (text.length < 4) return res.status(400).json({ error: 'text-too-short' });
    const call = { turns: [{ role: 'assistant', text: openingLine() }, { role: 'caller', text }] };
    const verdict = await judge({ call, member: null, isWhitelistedCaller: false });
    res.json({ verdict });
  }));

  // Truthful engine status from the cached snapshot (never blocks page load;
  // server.js probes at boot, stale entries re-probe in the background).
  // No key values ever appear in it.
  r.get('/status', safe(async (req, res) => {
    const engineStatus = await getEngineStatus({ noWait: true });
    res.json({
      engine: engineLabel(engineStatus),
      engines: { jev: Boolean(engineStatus?.jev?.ok), gemini: Boolean(engineStatus?.gemini?.ok) },
      engineStatus,
      live: isLiveAI(), // Gemini Live freestyle available (UI hides the button otherwise)
      model: config.geminiModel,
      identifyMode: config.identifyMode,
      notifyAdapters: config.notifyAdapters,
      twilio: Boolean(config.twilioAccountSid),
      liffId: config.liffId,
      recaptchaSiteKey: config.recaptchaSiteKey,
      demoNumber: config.demoNumber || demoMember()?.aiNumber || '',
    });
  }));

  r.get('/demo/scripts', (req, res) => res.json({ scripts: SCRIPTS }));

  // Public trust stats (landing strip + /stats.html). Aggregate-only —
  // per-metric `shown` flags already apply the brag-gate minimums, so the
  // frontend hides weak numbers instead of second-guessing them.
  r.get('/stats', (req, res) => res.json(getPublicStats()));

  // Demo history: a visitor sees only the demo calls it started — the
  // client keeps its own (unguessable) call ids. Member calls never leave
  // through here; there is no global call feed or member listing.
  r.get('/calls', (req, res) => {
    const ids = [...new Set(String(req.query.ids || '').split(',').filter(Boolean))].slice(0, 12);
    res.json({ calls: ids.map((id) => getCall(id)).filter(isDemoCall).map(publicCall) });
  });
  r.get('/calls/:id', (req, res) => {
    const call = getCall(req.params.id);
    if (!isDemoCall(call)) return res.status(404).json({ error: 'call not found' });
    res.json({ call: publicCall(call) });
  });

  // Demo calls are free fixtures: ending one never burns the seed
  // household's quota, never fires quota-low or owner LINE pushes.
  function finishDemoCall(call, member, verdict, closing = verdict.closingLine) {
    setVerdict(call.id, verdict);
    endCall(call.id);
    addTurn(call.id, 'assistant', closing);
    return demoAlert(getCall(call.id), member, verdict);
  }
  const send = (res, payload) => {
    broadcast({ type: 'call-update', ...payload });
    res.json(payload);
  };

  // Before a new call: end THIS visitor's open call (replaced) and any
  // visitor's call that went idle — $0 canned close, no AI, no alert.
  function sweepDemoCalls(visitorKey, now = Date.now()) {
    let replaced = false;
    for (const c of listCalls(Number.MAX_SAFE_INTEGER)) {
      if (!isDemoCall(c) || c.endedAt || turnsInFlight.has(c.id)) continue;
      const mine = c.visitorKey === visitorKey;
      if (!mine && now - lastActivity(c) <= idleMs()) continue;
      replaced ||= mine;
      if (!c.verdict) setVerdict(c.id, cannedUnsure(mine ? 'สาย demo ถูกแทนที่ก่อนมีหลักฐาน' : 'สาย demo หมดเวลาเงียบก่อนมีหลักฐาน'));
      endCall(c.id);
    }
    return replaced;
  }

  // End policy = judge/nextAction (confident SCAM hangs up; LEGIT once the
  // message is taken; UNSURE after a few turns; max turns) + talk budget.
  function decideNext({ verdict, callerTurns, elapsedMs, budgetMinutes }) {
    if (elapsedMs >= budgetMinutes * 60000) {
      return { action: verdict.verdict === 'SCAM' ? 'hangup' : 'take-message', endReason: 'budget' };
    }
    const action = nextAction(verdict, callerTurns, { maxTurns: config.maxTurnsPerCall });
    if (action === 'continue') return { action, endReason: null };
    if (callerTurns >= config.maxTurnsPerCall) return { action, endReason: 'max-turns' };
    return { action, endReason: action === 'hangup' ? 'scam' : 'message-taken' };
  }

  // Start a simulated inbound call. Guard 1: hourly caps — the public page
  // must not drain the AI budget; they run before CAPTCHA so floods burn no
  // Google round-trip. Guard 1b: reCAPTCHA gate (low score = one low-trust
  // pass, then a friendly error with the recorded-demo fallback).
  const demoStartLimits = (req, res, next) => {
    const g = take('demo:start', config.demoMaxCallsPerHour, 3600000);
    if (!g.ok) return res.status(429).json({ error: 'demo-rate-limited', retryAfterSec: g.retryAfterSec });
    const perIp = take(`demo:start:ip:${clientIp(req)}`, config.demoMaxCallsPerIpHour, 3600000);
    if (!perIp.ok) return res.status(429).json({ error: 'demo-rate-limited', retryAfterSec: perIp.retryAfterSec });
    next();
  };
  r.post('/demo/call', demoStartLimits, captchaGate({ action: 'demo_call', scope: 'demo' }), (req, res) => {
    const member = demoMember();
    if (!member) return res.status(503).json({ error: 'demo-unavailable' });
    const visitorKey = visitorKeyOf(demoVisitor(req, res));
    const replaced = sweepDemoCalls(visitorKey);
    const script = req.body?.scriptId ? getScript(req.body.scriptId) : null;
    const typedPhone = String(req.body?.callerPhone || '').replace(/[^\d+]/g, '').slice(0, 16);
    const callerPhone = typedPhone || script?.callerPhone || '+66819998888';
    const call = createCall({ memberId: member.id, callerPhone, aiNumber: member.aiNumber, source: 'demo', visitorKey });
    addTurn(call.id, 'assistant', openingLine());
    send(res, {
      call: publicCall(call), budget: budgetOf(call, member), replaced,
      script: script ? { id: script.id, lines: script.lines, expected: script.expected } : null,
    });
  });

  // Mid-call endpoints: no CAPTCHA (a judge is never locked out mid-call);
  // the unguessable call id + per-IP limit + one-turn-at-a-time bound spend.
  const demoTurnLimit = (req, res, next) => {
    const g = take(`demo:turn:ip:${clientIp(req)}`, DEMO_TURNS_PER_IP_MIN, 60000);
    if (!g.ok) return res.status(429).json({ error: 'demo-rate-limited', retryAfterSec: g.retryAfterSec });
    next();
  };
  const openDemoCall = (req, res) => {
    const call = getCall(req.body?.callId);
    if (!isDemoCall(call) || call.endedAt) {
      res.status(404).json({ error: 'call not found or ended' });
      return null;
    }
    if (turnsInFlight.has(call.id)) {
      res.status(409).json({ error: 'turn-in-progress' });
      return null;
    }
    return call;
  };

  // One caller utterance -> verdict update + assistant reply (or call end).
  r.post('/demo/turn', demoTurnLimit, safe(async (req, res) => {
    const call = openDemoCall(req, res);
    if (!call) return;
    const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, MAX_DEMO_TEXT) : '';
    if (!text) return res.status(400).json({ error: 'text required' });
    const member = getMemberById(call.memberId);
    // Guard 3: idle demo calls close without spending another AI turn.
    if (Date.now() - lastActivity(call) > idleMs()) {
      const verdict = call.verdict || cannedUnsure('สาย demo หมดเวลาเงียบก่อนมีหลักฐาน');
      const notify = finishDemoCall(call, member, verdict);
      return send(res, {
        call: publicCall(getCall(call.id)), ended: true, verdict, notify, idleTimeout: true, endReason: 'idle', budget: budgetOf(call, member),
      });
    }
    const lang = req.body?.lang === 'en' ? 'en' : 'th';
    turnsInFlight.add(call.id);
    try {
      addTurn(call.id, 'caller', text);
      const verdict = await judge({ call, member, isWhitelistedCaller: isWhitelisted(member, call.callerPhone), lang });
      setVerdict(call.id, verdict);
      auditDecision(call, verdict);
      const callerTurns = call.turns.filter((t) => t.role === 'caller').length;
      const elapsedMs = Date.now() - Date.parse(call.startedAt);
      const { action, endReason } = decideNext({ verdict, callerTurns, elapsedMs, budgetMinutes: talkBudgetMinutes(member) });
      // Same persona writes the next line or the closing (Gemini, Jev-guarded;
      // canned lines when AI is down) — every call type ends politely.
      const turnsLeft = config.maxTurnsPerCall - callerTurns;
      const reply = await personaReply({ turns: call.turns, verdict, lang, action, wrapUp: turnsLeft <= 2 });
      if (endReason) {
        const notify = finishDemoCall(call, member, verdict, reply.text);
        return send(res, {
          call: publicCall(getCall(call.id)), ended: true, verdict, notify, budget: budgetOf(call, member), endReason, next: action,
        });
      }
      addTurn(call.id, 'assistant', reply.text);
      send(res, {
        call: publicCall(getCall(call.id)), ended: false, verdict, reply: reply.text, replyEngine: reply.engine, budget: budgetOf(call, member),
      });
    } finally {
      turnsInFlight.delete(call.id);
    }
  }));

  // ---- LINE login (LIFF): exchange ID token for a session ----
  r.post('/auth/line-verify', safe(async (req, res) => {
    const v = await verifyLineIdToken(req.body?.idToken);
    if (!v.ok) return res.status(v.error === 'line-unreachable' ? 502 : 401).json({ error: v.error });
    const member = getMemberByLineUserId(v.lineUserId);
    // Unknown LINE id: no orphan member (empty ownerPhone can never OTP).
    // Client verifies phone OTP first, then binds via POST /me/link-line.
    if (!member) return res.json({ ok: true, needsLink: true });
    const token = createSession(member.id);
    res.json({ ok: true, token, isNew: false, member: publicMember(member) });
  }));

  // ---- Auth (browser-locked sessions) ----
  // sendOtp (auth.js) owns every SMS-cost guard: per-phone, per-IP, global.
  // Login codes are purpose 'login' — consent codes can never sign in.
  r.post('/auth/request-otp', safe(async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'invalid-phone' });
    const sent = await sendOtp(phone, 'login', { ip: clientIp(req) });
    if (!sent.ok) return otpFailed(res, sent);
    res.json(otpSent(sent, { ok: true }));
  }));

  r.post('/auth/verify-otp', safe(async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'invalid-phone' });
    const v = await checkOtp(phone, req.body?.code, 'login');
    if (!v.ok) return res.status(v.error === 'verify-unavailable' ? 502 : 400).json({ error: v.error, attemptsLeft: v.attemptsLeft });
    let member = getMemberByOwner(phone);
    let isNew = false;
    if (!member) {
      // Every signup starts on the trial plan (Family, 7 days / 5 calls);
      // the plan picked on the pricing page is remembered for checkout.
      const plan = TRIAL.plan;
      const p = await provisionMember({ ownerPhone: phone, plan, mode: config.identifyMode });
      if (!p.ok) return res.status(503).json({ error: p.error });
      member = p.member;
      isNew = true;
      if (PLANS[req.body?.plan]) member.intendedPlan = req.body.plan;
      // An erased household's phone already had its free trial (tombstone,
      // store.js): it starts with none — pay to activate.
      if (trialUsedBefore(phone)) {
        member.trialDenied = true;
        member.trialEndsAt = new Date().toISOString();
      }
    }
    if (config.identifyMode !== 'B') markAssigned(member.aiNumber); // mode B never hands out pool numbers
    const token = createSession(member.id);
    const trial = isNew && member.trialDenied ? { trialUsed: true, notice: TRIAL_USED_NOTICE } : {};
    res.json({ token, member: publicMember(member), isNew, ...trial });
  }));

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

  r.get('/me/whitelist', auth, (req, res) => res.json({ whitelisted: maskWhitelist(req.member.whitelisted) }));
  r.post('/me/whitelist', auth, (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'invalid-phone' });
    if (phone === req.member.ownerPhone) return res.status(400).json({ error: 'cannot-whitelist-self' });
    const list = addWhitelist(req.member.id, {
      phone,
      label: String(req.body?.label || '').slice(0, 40) || 'family',
      safeWord: String(req.body?.safeWord || '').slice(0, 40),
    });
    res.json({ whitelisted: maskWhitelist(list) });
  });
  r.delete('/me/whitelist', auth, (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'invalid-phone' });
    res.json({ whitelisted: maskWhitelist(removeWhitelist(req.member.id, phone)) });
  });

  r.get('/me/watchers', auth, (req, res) => res.json({ watchers: req.member.familyWatchers }));
  r.post('/me/watchers', auth, (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'invalid-phone' });
    const plan = planOf(req.member);
    if (req.member.familyWatchers.length >= watcherCap(plan)) {
      return res.status(403).json({ error: 'plan-limit', max: plan.watchers });
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
  // Pricing page + member app source of truth (pricing v2). Prices in THB
  // (`usd` = the EN price, null = not offered). watchers null = unlimited.
  // `purchasable` = billing configured AND a Stripe price set for that item
  // (TH): false → show the item, but no buy button yet.
  r.get('/plans', (req, res) => {
    const can = (kind, item, interval) => billingConfigured() && Boolean(priceIdFor(kind, item, 'th', interval));
    const plans = Object.fromEntries(Object.entries(PLANS).map(([id, p]) => [id, {
      id, name: p.name, price: p.price, usd: p.usd, annual: p.annual, annualUsd: null,
      numbers: p.numbers, calls: p.calls, minutes: p.quota, quota: p.quota, watchers: p.watchers,
      recommended: id === TRIAL.plan, purchasable: { month: can('plan', id, 'month'), year: can('plan', id, 'year') },
    }]));
    const gifts = Object.fromEntries(Object.entries(GIFTS).map(([id, g]) => [id, {
      id, plan: g.plan, price: g.price, usd: null, days: g.days, months: Math.round(g.days / 30.4),
      numbers: PLANS[g.plan].numbers, autoRenew: false, purchasable: can('gift', id),
    }]));
    const topups = Object.fromEntries(Object.entries(TOPUP_PACKS).map(([id, t]) => [id, {
      id, price: t.price, usd: t.usd, calls: t.calls, minutes: t.minutes, purchasable: can('topup', id),
    }]));
    res.json({
      plans,
      extraSeat: {
        price: ADDON_SEAT.price, usd: ADDON_SEAT.usd, calls: ADDON_SEAT.calls, minutes: ADDON_SEAT.quota,
        allowedOn: Object.keys(PLANS).filter((id) => PLANS[id].numbers > 1), maxNumbers: MAX_HOUSEHOLD_SEATS,
        purchasable: can('seat'),
      },
      gifts,
      topups,
      trial: TRIAL,
      retention: { legitDays: config.retentionLegitDays, unsureDays: config.retentionUnsureDays, scamDays: config.retentionScamDays },
      // Signed-in checkout: POST here with Bearer auth and
      // { kind:'plan', plan, interval:'month'|'year' } | { kind:'gift', gift }
      // | { kind:'seat' } | { kind:'topup', pack } → { url } (Stripe Checkout).
      checkout: { path: '/api/billing/checkout' },
      // Legacy fields (older clients).
      addon: ADDON_SEAT, trialDays: TRIAL_DAYS, maxNumbers: MAX_HOUSEHOLD_SEATS,
    });
  });

  // Self-service may only move to a plan that grants nothing more; any
  // upgrade goes through Stripe Checkout, whose webhook applies the plan.
  r.post('/me/plan', auth, (req, res) => {
    const plan = req.body?.plan;
    if (!PLANS[plan]) return res.status(400).json({ error: 'invalid-plan' });
    if (grantsMore(PLANS[plan], planOf(req.member))) {
      return res.status(402).json({ error: 'payment-required', checkout: { kind: 'plan', plan } });
    }
    res.json({ member: publicMember(setPlan(req.member.id, plan)) });
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
  // Mode B (central number): people are protected via /me/protected — the
  // legacy seat flow would hand out pool numbers and text seat codes.
  const seatsClosed = (req, res, next) => (config.identifyMode === 'B'
    ? res.status(410).json({ error: 'use-protected' }) : next());
  r.post('/me/numbers', auth, seatsClosed, safe(async (req, res) => {
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
        if (m.plan !== 'family-199') return res.status(403).json({ error: 'plan-limit', max: cap });
        return res.status(402).json({ error: 'seat-payment-required', seatPrice: ADDON_SEAT });
      }
      const num = await assignNumber();
      if (!num.ok) return res.status(503).json({ error: num.error });
      aiNumber = num.number;
    }
    const seat = requestSeat(m.id, aiNumber, ownerPhone);
    if (!seat) return res.status(403).json({ error: 'seat-cap', max: seatCap(m) });
    const sent = await sendOtp(ownerPhone, 'seat', { ip: clientIp(req) });
    if (!sent.ok) return otpFailed(res, sent);
    res.json(otpSent(sent, { pending: true, aiNumber }));
  }));

  // Step 2 — verify: the code went to the NEW member's phone, not the owner's.
  r.post('/me/numbers/verify', auth, seatsClosed, safe(async (req, res) => {
    const m = req.member;
    pruneSeats(m.id);
    const seat = (m.pendingSeats || []).find((s) => s.aiNumber === req.body?.aiNumber);
    if (!seat) return res.status(404).json({ error: 'seat-not-found' });
    const v = await checkOtp(seat.ownerPhone, req.body?.code, 'seat');
    if (!v.ok) return res.status(400).json({ error: v.error, attemptsLeft: v.attemptsLeft });
    res.json({ numbers: confirmSeat(m.id, seat.aiNumber) });
  }));

  // LINE is optional (dashboard inbox always works). This route only
  // UNLINKS: binding a LINE id needs proof of owning it (/me/link-line with
  // a verified idToken) — a raw id would let anyone hijack a stranger's LINE.
  r.post('/me/notify', auth, (req, res) => {
    if (req.body?.lineUserId) return res.status(400).json({ error: 'use-link-line' });
    res.json({ member: publicMember(setLineUserId(req.member.id, '')) });
  });

  // Bind a LINE id to the CURRENT phone-OTP member. The idToken proves
  // ownership of the LINE account; the session proves the phone account.
  // 409 when that LINE id already belongs to a different member.
  r.post('/me/link-line', auth, safe(async (req, res) => {
    const v = await verifyLineIdToken(req.body?.idToken);
    if (!v.ok) return res.status(v.error === 'line-unreachable' ? 502 : 401).json({ error: v.error });
    const other = getMemberByLineUserId(v.lineUserId);
    if (other && other.id !== req.member.id) return res.status(409).json({ error: 'line-already-linked' });
    const m = setLineUserId(req.member.id, v.lineUserId);
    res.json({ ok: true, member: publicMember(m) });
  }));

  // Cancel anytime: membership stops screening immediately (##002# stops forwarding on your phone).
  // Cancel stops the AI at once: with **21* forwarding still on, a
  // protected parent would silently miss every call — tell each protected
  // phone (once per cancellation) to dial ##002#.
  r.post('/me/cancel', auth, safe(async (req, res) => {
    const m = req.member;
    const wasActive = m.active !== false;
    cancelMember(m.id);
    if (wasActive && !m.farewellAt) {
      m.farewellAt = new Date().toISOString();
      await farewellProtected(m);
    }
    res.json({ member: publicMember(m) });
  }));
  // Erasure (PDPA ม.33): delete the household — member record, calls,
  // reputation flags, every session. Irreversible, so the body must say
  // { confirm: true }. The operator's demo household cannot be erased.
  // Every protected phone (not the payer's own) is told once to cancel its
  // forwarding first — nobody silently misses calls after we are gone.
  r.delete('/me', auth, safe(async (req, res) => {
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'confirm-required' });
    if (req.member.ownerPhone === config.seedMemberPhone) return res.status(403).json({ error: 'demo-household' });
    if (!req.member.farewellAt) await farewellProtected(req.member); // not already told at cancel
    const out = deleteMember(req.member.id);
    const sessions = destroySessionsFor(req.member.id);
    console.log(`[privacy] member erased on request (${out?.calls || 0} calls, ${sessions} sessions)`);
    res.json({ ok: true, erased: true });
  }));

  r.post('/me/reactivate', auth, (req, res) => {
    req.member.farewellAt = null; // a later cancel tells protected phones again
    res.json({ member: publicMember(reactivateMember(req.member.id)) });
  });

  // Force-end (owner hangup / judge skip). No caller words yet → canned
  // verdict instead of an AI call over the greeting alone.
  r.post('/demo/end', demoTurnLimit, safe(async (req, res) => {
    const call = openDemoCall(req, res);
    if (!call) return;
    const member = getMemberById(call.memberId);
    turnsInFlight.add(call.id);
    try {
      const heard = call.turns.some((t) => t.role === 'caller');
      const verdict = call.verdict
        || (heard ? await judge({ call, member, isWhitelistedCaller: false }) : cannedUnsure('วางสายก่อนผู้โทรพูด'));
      auditDecision(call, verdict);
      const notify = finishDemoCall(call, member, verdict);
      send(res, { call: publicCall(getCall(call.id)), ended: true, verdict, notify, endReason: 'hangup', budget: budgetOf(call, member) });
    } finally {
      turnsInFlight.delete(call.id);
    }
  }));

  // JSON errors only (never an HTML stack trace to the public).
  r.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error(`[api] ${req.method} ${req.path} failed:`, err?.message || err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal' });
  });

  return r;
}
