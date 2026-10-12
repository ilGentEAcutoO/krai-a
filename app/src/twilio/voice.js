// Telephony adapter: Twilio Voice (TwiML Gather loop).
// Real phone path: Twilio receives the call, transcribes speech, POSTs here.
// We run member gate -> persona + verdict -> TwiML Say/Gather/Hangup.
// Swap vendors by replacing this module only (same req/res shape).
// Voice: fixed lines <Play> the pre-rendered Gemini TTS clips (Achernar,
// public/voice-audio, made by scripts/render-demo.mjs); dynamic replies use
// Twilio's Google Chirp3-HD Thai voice, the closest soft female voice.
// A call is settled exactly once (minutes, quota warning, owner alert) by
// whichever side ends it first: the AI's closing line, Twilio's status
// callback (caller hung up), or the stale-call sweep.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import {
  createCall, getCall, getCallBySid, listCalls, addTurn, setVerdict, endCall, checkRejectLimit, countReject,
  getReputation, setReputation, listMembers, consumeMinutes, quotaSummary,
} from '../store.js';
import { openingLine, personaReply } from '../ai.js';
import { judge, shouldEndNow, auditDecision, talkBudgetMinutes } from '../verdict.js';
import { notifyOwner, maybeNotifyQuotaLow } from '../notify/index.js';
import { resolveIncoming, markForwardingVerified, allowAnswer, protectedOf } from '../household.js';
import { notifyPayer } from '../lifecycle.js';
import * as sms from '../sms.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Phone numbers stay out of production logs (last 3 digits only).
const mask = (p) => (process.env.NODE_ENV === 'production' ? `…${String(p || '').slice(-3)}` : p);

// Outbound side effects, swappable in tests (an SMS must never leave a test run).
export const voiceDeps = {
  sendSms: (phone, text) => sms.sendTextSms(phone, text),
  notifyPayer: (m, text) => notifyPayer(m, text),
};

const TERMINAL = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);
export const STALE_CALL_MS = 15 * 60000;
// In-flight settle claims: process memory, never on the call record, so a
// snapshot taken mid-settle can't restore a call that refuses to settle.
const settling = new Set();

// The hard house cap (MAX_MINUTES_PER_HOUSE) is the only quota that stops
// answering; the plan quota is soft (overage is counted, payer warned).
export const HOUSE_CAP_SMS = 'ใครอะหยุดรับสายแทนชั่วคราว เพราะครบเพดานการใช้งานเดือนนี้ กด ##002# เพื่อรับสายตามปกติ';
const houseCapPayerText = () => `ใครอะ: ครบเพดาน ${config.maxMinutesPerHousePerMonth} นาทีของเดือนนี้แล้ว AI หยุดรับสายแทนจนถึงรอบหน้า แจ้งเบอร์ที่ดูแลให้กด ##002# แล้ว`;

// Twilio <Say> voices we allow (Twilio th-TH list: Google Chirp3-HD
// Aoede/Kore/Leda/Zephyr are the female ones). Polly has no Thai voice.
export const VOICE = 'Google.th-TH-Chirp3-HD-Aoede';
export const ALLOWED_VOICES = new Set([VOICE]);

// Fixed lines owned by this module (also pre-rendered).
export const PHONE_LINES = {
  gather: 'เชิญพูดธุระได้เลยค่ะ',
  noSpeech: 'ไม่ได้ยินเสียงเลยค่ะ ขอบคุณที่โทรมานะคะ',
};

// Pre-rendered prompts: { text, file }. A clip is used only while its text
// still equals what we would say, so a wording change can never play stale audio.
const PROMPTS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'voice-audio', 'prompts.json');
function loadPrompts() {
  try {
    const { prompts } = JSON.parse(fs.readFileSync(PROMPTS_FILE, 'utf8'));
    return new Map(Object.values(prompts || {}).map((p) => [p.text, p.file]));
  } catch {
    return new Map();
  }
}
const PROMPTS = loadPrompts();

function speak(text, base) {
  const file = PROMPTS.get(text);
  if (file && base) return `<Play>${esc(base + file)}</Play>`;
  return `<Say language="th-TH" voice="${VOICE}">${esc(text)}</Say>`;
}

function gatherTwiml(lines, actionUrl, base, { prompt = false } = {}) {
  const said = lines.map((l) => speak(l, base)).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${said}<Gather input="speech" language="th-TH" speechModel="phone_call" speechTimeout="auto" action="${esc(actionUrl)}" method="POST" timeout="6">${prompt ? speak(PHONE_LINES.gather, base) : ''}</Gather><Redirect>${esc(actionUrl)}&amp;empty=1</Redirect></Response>`;
}

function sayHangupTwiml(say, base) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${speak(say, base)}<Hangup/></Response>`;
}

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${req.get('host')}`;
}

// Absolute origin for <Play> URLs (Twilio fetches them itself).
const audioBase = (req) => config.publicBaseUrl || baseUrl(req);

function rejectTwiml() {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="busy"/></Response>`;
}

function sendReject(res, from, to, reason) {
  countReject(from);
  console.log(`[voice] reject $0 ${mask(from)} -> ${mask(to)} reason=${reason}`);
  res.type('text/xml').send(rejectTwiml());
}

// Once per quota period at the hard cap: every protected phone is told to
// cancel forwarding (an unanswered **21* forward means they silently miss
// every call) and the payer is told why.
export async function houseCapNotice(member) {
  const { period } = quotaSummary(member);
  if (member.houseCapNotified === period) return 0;
  member.houseCapNotified = period; // mark first: a retry never double-texts
  let sent = 0;
  for (const p of protectedOf(member)) {
    try { await voiceDeps.sendSms(p.phone, HOUSE_CAP_SMS); sent += 1; } catch (e) { console.error('[voice] house-cap sms failed', e.message); }
  }
  try { await voiceDeps.notifyPayer(member, houseCapPayerText()); } catch (e) { console.error('[voice] house-cap payer notice failed', e.message); }
  return sent;
}

const hangupVerdict = (callerTurns) => ({
  verdict: 'UNSURE', confidence: 0.4, pressureSignals: [], matchesKnownScam: false, engine: 'none', action: 'END_UNSURE',
  reason: callerTurns ? 'ผู้โทรวางสายก่อนสรุปได้' : 'ผู้โทรวางสายก่อนพูด',
  reasonEn: callerTurns ? 'The caller hung up before a verdict.' : 'The caller hung up before speaking.',
  closingLine: '', judgedAt: new Date().toISOString(),
});

// Ends a phone call once: bills minutes (Twilio's duration when known),
// warns on quota, and alerts the owner whenever the caller said anything —
// a scammer who hangs up mid-call still triggers the alert.
export async function settleCall(call, { minutes = null, reason = 'ai' } = {}) {
  if (!call || call.endedAt || settling.has(call.id)) return false;
  settling.add(call.id); // claimed synchronously: a concurrent callback or sweep can't double-bill
  try {
    const callerTurns = call.turns.filter((t) => t.role === 'caller').length;
    // Hung up after speaking but before a verdict: judge what was said, so
    // the owner's alert carries a real verdict.
    if (!call.verdict && callerTurns > 0) {
      try {
        const v = await judge({ call, member: { id: call.memberId, whitelisted: [], familyWatchers: [] }, isWhitelistedCaller: false });
        setVerdict(call.id, v);
        auditDecision(call, v);
        setReputation(call.memberId, call.callerPhone,
          { verdict: v.verdict, confidence: v.confidence, signals: v.pressureSignals || [] }, config.reputationTtlDays);
      } catch (e) {
        console.error('[voice] hang-up judge failed', e.message);
      }
    }
    if (!call.verdict) setVerdict(call.id, hangupVerdict(callerTurns));
    endCall(call.id);
    if (minutes != null) call.minutesBilled = minutes;
    call.endReason = reason;
    const member = listMembers().find((m) => m.id === call.memberId);
    if (!member) return true;
    consumeMinutes(member, call.minutesBilled);
    await maybeNotifyQuotaLow(member);
    if (callerTurns > 0) {
      await notifyOwner({ call, member, verdict: call.verdict }).catch((e) => console.error('[notify] failed', e.message));
    }
    return true;
  } finally {
    settling.delete(call.id);
  }
}

// Calls Twilio never reported closed (status callback missing or lost):
// settle any call quiet for STALE_CALL_MS, billed up to its last activity.
export async function closeStaleCalls(now = Date.now(), maxOpenMs = STALE_CALL_MS) {
  let closed = 0;
  for (const call of listCalls(Number.MAX_SAFE_INTEGER)) {
    if (call.source !== 'twilio' || call.endedAt) continue;
    const last = Date.parse(call.turns.at(-1)?.at || call.startedAt);
    if (now - last < maxOpenMs) continue;
    const minutes = Math.max(1, Math.ceil((last - Date.parse(call.startedAt)) / 60000));
    if (await settleCall(call, { minutes, reason: 'stale' })) closed += 1;
  }
  return closed;
}

export function voiceIncoming(req, res) {
  const to = req.body?.To || req.body?.Called || '';
  const from = req.body?.From || req.body?.Caller || 'unknown';
  const forwardedFrom = req.body?.ForwardedFrom || '';

  // Gate 1: forwarder allowlist. Only when configured — empty allowlist is
  // permissive (direct dials and unmarked forwards pass to Gate 2).
  if (config.forwardAllowlist.length > 0 && !config.forwardAllowlist.includes(forwardedFrom)) {
    sendReject(res, from, to, 'not-allowlisted');
    return;
  }

  // Repeat abusers get a busy tone ($0), not a polite 10s message (billed).
  if (checkRejectLimit(from) >= config.maxRejectsPerDayPerCaller) {
    console.log(`[voice] reject $0 ${mask(from)} -> ${mask(to)} reason=over-daily-cap`);
    res.type('text/xml').send(rejectTwiml());
    return;
  }

  // Central-number gate (src/household.js): mode B answers only calls
  // forwarded from a verified protected phone, or a protected person calling
  // in; mode A identifies the household by the dialled number.
  const { member, reason, via, protectedPhone } = resolveIncoming({
    to, from, forwardedFrom, mode: config.identifyMode,
    diversion: req.body?.SipHeader_Diversion || req.body?.Diversion || '',
  });
  if (!member || !member.active) {
    // Mode B: a call nobody pays for is never answered — <Reject/> is $0.
    if (config.identifyMode === 'B') {
      sendReject(res, from, to, reason || 'inactive');
      return;
    }
    countReject(from);
    // ~10s polite reject, zero AI cost.
    res.type('text/xml').send(sayHangupTwiml('ขออภัยค่ะ เบอร์นี้ยังไม่ได้สมัครใช้บริการใครอะค่ะ', audioBase(req)));
    console.log(`[voice] reject ${mask(from)} -> ${mask(to)} reason=${reason}`);
    return;
  }
  // Gate 2: known-bad caller, per-household. A number this household already
  // judged SCAM is cut before answer ($0, no AI cost). Flags never cross
  // households (PDPA: no shared blacklist) and expire so recycled numbers
  // can't stay flagged forever (see store.js).
  const rep = getReputation(member.id, from);
  if (rep && rep.verdict === 'SCAM' && rep.confidence >= config.reputationMinConfidence) {
    sendReject(res, from, to, `known-scam conf=${rep.confidence}`);
    return;
  }

  // Hard house cap: unanswered busy ($0) + one notice per period. The plan
  // quota is soft: over it we keep screening (rejecting would make a
  // protected elder silently miss every forwarded call).
  if (quotaSummary(member).used >= config.maxMinutesPerHousePerMonth) {
    sendReject(res, from, to, 'house-cap');
    houseCapNotice(member).catch((e) => console.error('[voice] house-cap notice failed', e.message));
    return;
  }

  // Spoofed caller ID / forward floods: daily answer caps per household
  // (household.allowAnswer). Counted only for calls we actually answer.
  if (config.identifyMode === 'B') {
    const cap = allowAnswer(member, { from, protectedPhone, via });
    if (!cap.ok) { sendReject(res, from, to, cap.reason); return; }
  }

  const call = createCall({ memberId: member.id, callerPhone: from, aiNumber: to, source: 'twilio', callSid: req.body?.CallSid });
  if (protectedPhone) call.protectedPhone = protectedPhone; // member app shows "to Mom"
  if (via === 'forwarded') markForwardingVerified(member, protectedPhone);
  const lines = [config.recordNotice, openingLine()];
  addTurn(call.id, 'assistant', lines.join(' '));
  const action = `${baseUrl(req)}/voice/turn?callId=${call.id}`;
  console.log(`[voice] incoming ${call.id} from=${mask(from)} to=${mask(to)}`);
  res.type('text/xml').send(gatherTwiml(lines, action, audioBase(req), { prompt: true }));
}

export async function voiceTurn(req, res) {
  const call = getCall(req.query.callId);
  const action = `${baseUrl(req)}/voice/turn?callId=${req.query.callId}`;
  if (!call || call.endedAt) {
    res.type('text/xml').send(sayHangupTwiml('ขออภัยค่ะ สายหลุด กรุณาโทรกลับมาใหม่นะคะ', audioBase(req)));
    return;
  }
  const heard = (req.body?.SpeechResult || '').trim();
  if (heard) addTurn(call.id, 'caller', heard);

  const member = { id: call.memberId, whitelisted: [], familyWatchers: [] }; // light ref; full record not needed for judging
  const full = listMembers().find((m) => m.id === call.memberId);
  const callerTurns = call.turns.filter((t) => t.role === 'caller').length;
  // Silence before the caller ever spoke: close politely, no AI spend.
  if (req.query.empty && callerTurns === 0) {
    await settleCall(call, { reason: 'no-speech' });
    res.type('text/xml').send(sayHangupTwiml(PHONE_LINES.noSpeech, audioBase(req)));
    return;
  }
  const verdict = await judge({ call, member, isWhitelistedCaller: false });
  setVerdict(call.id, verdict);
  auditDecision(call, verdict);
  setReputation(call.memberId, call.callerPhone,
    { verdict: verdict.verdict, confidence: verdict.confidence, signals: verdict.pressureSignals || [] },
    config.reputationTtlDays);

  // Talk budget (per-minute phone bill): cut at 20% of plan quota, always
  // with the just-judged verdict's closing line — the call still concludes.
  const budgetMinutes = talkBudgetMinutes(full);
  const elapsedMs = Date.now() - Date.parse(call.startedAt);
  if (shouldEndNow({ verdict, turnCount: callerTurns, elapsedMs, budgetMinutes }) || req.query.empty) {
    await settleCall(call, { reason: 'ai' });
    res.type('text/xml').send(sayHangupTwiml(verdict.closingLine, audioBase(req)));
    return;
  }

  // turnIndex is 0-based: the caller's first line gets the first reply.
  const reply = await personaReply(
    call.turns.map((t) => `${t.role}: ${t.text}`).join('\n'), Math.max(0, callerTurns - 1),
    { turnsLeft: config.maxTurnsPerCall - callerTurns },
  );
  addTurn(call.id, 'assistant', reply.text);
  res.type('text/xml').send(gatherTwiml([reply.text], action, audioBase(req)));
}

// Twilio status callback (the number's "call status changes" URL ->
// /voice/status). A terminal status settles a call the AI hadn't ended (the
// caller hung up); for one the AI already ended, Twilio's billed duration
// tops up our wall-clock minutes. Retries are no-ops.
export async function voiceStatus(req, res) {
  const sid = String(req.body?.CallSid || '');
  const status = String(req.body?.CallStatus || '');
  const seconds = Math.max(0, Number(req.body?.CallDuration) || 0);
  console.log('[voice] status', JSON.stringify({ sid, status, dur: seconds }));
  const call = sid && TERMINAL.has(status) ? getCallBySid(sid) : null;
  if (call && call.source === 'twilio' && call.twilioMinutes == null) {
    const billed = status === 'completed' ? Math.max(1, Math.ceil(seconds / 60)) : 0;
    call.twilioMinutes = billed;
    try {
      if (!call.endedAt) {
        await settleCall(call, { minutes: billed, reason: 'caller-hangup' });
      } else {
        const extra = billed - (call.minutesBilled || 0);
        const member = listMembers().find((m) => m.id === call.memberId);
        if (extra > 0 && member) {
          consumeMinutes(member, extra);
          call.minutesBilled = billed;
        }
      }
    } catch (e) {
      console.error('[voice] status settle failed', e.message);
    }
  }
  res.status(200).send('ok');
}
