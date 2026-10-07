// Telephony adapter: Twilio Voice (TwiML Gather loop).
// Real phone path: Twilio receives the call, transcribes speech, POSTs here.
// We run member gate -> persona + verdict -> TwiML Say/Gather/Hangup.
// Swap vendors by replacing this module only (same req/res shape).
import { config } from '../config.js';
import { findMember, isWhitelisted, createCall, getCall, addTurn, setVerdict, endCall, checkRejectLimit, countReject, getReputation, setReputation } from '../store.js';
import { openingLine, personaReply } from '../ai.js';
import { judge, shouldEndNow, auditDecision } from '../verdict.js';
import { notifyOwner } from '../notify/index.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const VOICE = 'Polly.Tiamat'; // Thai TTS voice on Twilio

function gatherTwiml(say, actionUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="th-TH" voice="${VOICE}">${esc(say)}</Say><Gather input="speech" language="th-TH" speechModel="phone_call" speechTimeout="auto" action="${actionUrl}" method="POST" timeout="6"><Say language="th-TH" voice="${VOICE}">กรุณาพูดธุระของท่านหลังสัญญาณค่ะ</Say></Gather><Redirect>${actionUrl}?empty=1</Redirect></Response>`;
}

function sayHangupTwiml(say) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="th-TH" voice="${VOICE}">${esc(say)}</Say><Hangup/></Response>`;
}

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${req.get('host')}`;
}

function rejectTwiml() {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="busy"/></Response>`;
}

function sendReject(res, from, to, reason) {
  countReject(from);
  console.log(`[voice] reject $0 ${from} -> ${to} reason=${reason}`);
  res.type('text/xml').send(rejectTwiml());
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
    console.log(`[voice] reject $0 ${from} -> ${to} reason=over-daily-cap`);
    res.type('text/xml').send(rejectTwiml());
    return;
  }

  const { member, reason } = findMember({ to, forwardedFrom, mode: config.identifyMode });
  if (!member || !member.active) {
    countReject(from);
    // ~10s polite reject, zero AI cost.
    res.type('text/xml').send(sayHangupTwiml('ขออภัยค่ะ เบอร์นี้ยังไม่ได้สมัครใช้บริการใครอ่ะ'));
    console.log(`[voice] reject ${from} -> ${to} reason=${reason}`);
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

  if (member.minutesUsed >= config.maxMinutesPerHousePerMonth) {
    res.type('text/xml').send(sayHangupTwiml('ขออภัยค่ะ วงเงินการใช้งานเดือนนี้เต็มแล้ว'));
    return;
  }

  const call = createCall({ memberId: member.id, callerPhone: from, aiNumber: to, source: 'twilio' });
  const greeting = `${config.recordNotice} ${openingLine()}`;
  addTurn(call.id, 'assistant', greeting);
  const action = `${baseUrl(req)}/voice/turn?callId=${call.id}`;
  console.log(`[voice] incoming ${call.id} from=${from} to=${to}`);
  res.type('text/xml').send(gatherTwiml(greeting, action));
}

export async function voiceTurn(req, res) {
  const call = getCall(req.query.callId);
  const action = `${baseUrl(req)}/voice/turn?callId=${req.query.callId}`;
  if (!call) {
    res.type('text/xml').send(sayHangupTwiml('ขออภัยค่ะ สายหลุด กรุณาโทรกลับมาใหม่'));
    return;
  }
  const heard = (req.body?.SpeechResult || '').trim();
  if (heard) addTurn(call.id, 'caller', heard);

  const member = { id: call.memberId, whitelisted: [], familyWatchers: [] }; // light ref; full record not needed for judging
  const callerTurns = call.turns.filter((t) => t.role === 'caller').length;
  const verdict = await judge({ call, member, isWhitelistedCaller: false });
  setVerdict(call.id, verdict);
  auditDecision(call, verdict);
  setReputation(call.memberId, call.callerPhone,
    { verdict: verdict.verdict, confidence: verdict.confidence, signals: verdict.pressureSignals || [] },
    config.reputationTtlDays);

  if (shouldEndNow({ verdict, turnCount: callerTurns }) || req.query.empty) {
    if (req.query.empty && callerTurns === 0) {
      res.type('text/xml').send(sayHangupTwiml('ไม่ได้ยินเสียง กรุณาฝากข้อความไว้หลังสัญญาณ ขอบคุณค่ะ'));
      return;
    }
    endCall(call.id);
    const full = (await import('../store.js')).listMembers().find((m) => m.id === call.memberId);
    if (full) {
      full.minutesUsed += call.minutesBilled;
      await notifyOwner({ call, member: full, verdict }).catch((e) => console.error('[notify] failed', e.message));
    }
    res.type('text/xml').send(sayHangupTwiml(verdict.closingLine));
    return;
  }

  const reply = await personaReply(call.turns.map((t) => `${t.role}: ${t.text}`).join('\n'), callerTurns);
  addTurn(call.id, 'assistant', reply.text);
  res.type('text/xml').send(gatherTwiml(reply.text, action));
}

export function voiceStatus(req, res) {
  // Twilio status callback: log completion for billing/audit.
  console.log('[voice] status', JSON.stringify({ sid: req.body?.CallSid, status: req.body?.CallStatus, dur: req.body?.CallDuration }));
  res.status(200).send('ok');
}
