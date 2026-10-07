// Demo API: lean hackathon build — scripted web sessions, one-click police
// evidence export, call history. No auth/OTP/plans/LINE (krai-a-app only).
import { Router } from 'express';
import { config, isLiveAI } from './config.js';
import {
  createCall, getCall, addTurn, setVerdict, endCall, listCalls, listMembers,
} from './store.js';
import { openingLine, personaReply } from './ai.js';
import { judge, shouldEndNow, auditDecision } from './verdict.js';
import { notifyOwner } from './notify/index.js';
import { SCRIPTS, getScript } from './demoScripts.js';
import { buildEvidenceBundle } from './evidence.js';

export function demoRouter(broadcast) {
  const r = Router();

  r.get('/status', (req, res) => {
    res.json({
      engine: isLiveAI() ? 'gemini' : 'rules',
      model: config.geminiModel,
      demoNumber: config.demoNumber || listMembers()[0]?.aiNumber || '',
    });
  });

  r.get('/demo/scripts', (req, res) => res.json({ scripts: SCRIPTS }));
  r.get('/calls', (req, res) => res.json({ calls: listCalls() }));

  // Start a simulated inbound call.
  r.post('/demo/call', (req, res) => {
    const member = listMembers()[0];
    if (!member) return res.status(500).json({ error: 'no seed member' });
    const script = req.body?.scriptId ? getScript(req.body.scriptId) : null;
    const callerPhone = req.body?.callerPhone || script?.callerPhone || '+66819998888';
    const call = createCall({ memberId: member.id, callerPhone, aiNumber: member.aiNumber, source: 'demo' });
    const greeting = openingLine();
    addTurn(call.id, 'assistant', greeting);
    const payload = { call, script: script ? { id: script.id, lines: script.lines, expected: script.expected } : null };
    broadcast({ type: 'call-update', ...payload });
    res.json(payload);
  });

  // One caller utterance -> verdict update + assistant reply (or call end).
  r.post('/demo/turn', async (req, res) => {
    const { callId, text } = req.body || {};
    const call = getCall(callId);
    if (!call || call.endedAt) return res.status(404).json({ error: 'call not found or ended' });
    if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
    addTurn(call.id, 'caller', text.trim());
    const verdict = await judge({ call, member: null, isWhitelistedCaller: false });
    setVerdict(call.id, verdict);
    auditDecision(call, verdict);
    const callerTurns = call.turns.filter((t) => t.role === 'caller').length;

    if (shouldEndNow({ verdict, turnCount: callerTurns })) {
      endCall(call.id);
      const member = listMembers().find((m) => m.id === call.memberId);
      const notify = await notifyOwner({ call, member: member || {}, verdict }).catch((e) => ({ error: e.message }));
      addTurn(call.id, 'assistant', verdict.closingLine);
      const payload = { call: getCall(call.id), ended: true, verdict, notify };
      broadcast({ type: 'call-update', ...payload });
      return res.json(payload);
    }

    const reply = await personaReply(call.turns.map((t) => `${t.role}: ${t.text}`).join('\n'), callerTurns);
    addTurn(call.id, 'assistant', reply.text);
    const payload = { call: getCall(call.id), ended: false, verdict, reply: reply.text, replyEngine: reply.engine };
    broadcast({ type: 'call-update', ...payload });
    res.json(payload);
  });

  // Force-end (owner hangup / judge skip).
  r.post('/demo/end', async (req, res) => {
    const call = getCall(req.body?.callId);
    if (!call || call.endedAt) return res.status(404).json({ error: 'call not found or ended' });
    const verdict = call.verdict || (await judge({ call, member: null, isWhitelistedCaller: false }));
    setVerdict(call.id, verdict);
    auditDecision(call, verdict);
    endCall(call.id);
    const member = listMembers().find((m) => m.id === call.memberId);
    addTurn(call.id, 'assistant', verdict.closingLine);
    const notify = await notifyOwner({ call, member: member || {}, verdict }).catch((e) => ({ error: e.message }));
    const payload = { call: getCall(call.id), ended: true, verdict, notify };
    broadcast({ type: 'call-update', ...payload });
    res.json(payload);
  });

  // One-click police evidence (AOC 1441 / Thai Police Online).
  r.get('/demo/export/:callId', (req, res) => {
    const call = getCall(req.params.callId);
    if (!call) return res.status(404).json({ error: 'call not found' });
    res.json({ bundle: buildEvidenceBundle(call) });
  });

  return r;
}
