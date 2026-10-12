// Live freestyle smoke test (real Gemini key, local only). Boots the relay
// in-process, opens one session like the browser would, lets the AI greet,
// streams a recorded Thai caller clip in real time (100 ms frames), then
// records transcripts, verdicts, time-to-first-audio and the AI's audio.
//
//   node scripts/live-smoke.mjs [caller.wav] [outDir]
// Writes <outDir>/greeting.wav, reply.wav, smoke.json. Never prints keys.
// Relay-mechanics variants (NOT verdict results — judge is replaced):
//   SMOKE_FORCE_SCAM=1   judge always answers SCAM 0.95 → exercises the polite scam closing
//   SMOKE_MAX_SECONDS=25 short cap → exercises the cap−10 s closing + hard stop
//   SMOKE_TAG=name       output suffix: smoke-<name>.json / reply-<name>.wav
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import WebSocket from 'ws';
import { createLiveVoice, LIVE_WS_PATH } from '../src/liveVoice.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const callerWavs = (process.argv[2] || path.join(root, 'agent-temp/voice-lab/caller_scam-police_alnilam.wav')).split(',');
const outDir = process.argv[3] || path.join(root, 'agent-temp/live-agent');
const PORT = Number(process.env.SMOKE_PORT || 8192);
const TAG = process.env.SMOKE_TAG ? `-${process.env.SMOKE_TAG}` : '';
const forceScam = process.env.SMOKE_FORCE_SCAM === '1';
const capSeconds = Number(process.env.SMOKE_MAX_SECONDS) || undefined;
mkdirSync(outDir, { recursive: true });

const clips = callerWavs.map((file) => ({
  file: path.relative(root, path.resolve(file)).split(path.sep).join('/'),
  pcm: execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', '16000', '-f', 's16le', '-']),
}));
const FRAME = 3200; // 100 ms

const serverLog = [];
const usage = []; // raw usageMetadata frames, tapped for the cost estimate
const live = createLiveVoice({
  ...(capSeconds ? { maxSeconds: capSeconds } : {}),
  ...(forceScam ? { judge: async () => ({ verdict: 'SCAM', confidence: 0.95, signals: {}, reasonTh: 'ทดสอบกลไกปิดสาย', reasonEn: 'forced for closing-path smoke', engine: 'smoke-forced', latencyMs: 0 }) } : {}),
  log: (...a) => { const line = a.join(' '); serverLog.push(line); console.log('[live]', line); },
  connectUpstream: ({ url, headers }) => {
    const up = new WebSocket(url, { headers });
    up.on('message', (d) => { try { const m = JSON.parse(String(d)); if (m.usageMetadata) usage.push(m.usageMetadata); } catch { /* binary */ } });
    return up;
  },
});
const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use('/api/live', live.router);
const server = createServer(app);
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname === LIVE_WS_PATH) live.handleUpgrade(req, socket, head);
  else socket.destroy();
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const wavOf = (pcm, rate) => {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const res = await fetch(`http://127.0.0.1:${PORT}/api/live/session`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ captchaToken: 'smoke', lang: 'th' }),
});
const session = await res.json();
if (!res.ok) throw new Error(`session failed ${res.status} ${JSON.stringify(session)}`);

const t0 = Date.now();
const ev = [];
const greetingAudio = [];
const replyAudio = [];
let phase = 'greeting';
let cur = null; // current caller turn: { file, startMs, doneMs, ttfaMs }
let firstGreetingAudioMs = null;
let lastAiAt = 0;
let endMsg = null;

// The session is bound to this client: same IP + the ka_live cookie (a browser sends it itself).
const bindCookie = (res.headers.get('set-cookie') || '').split(';')[0];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}${LIVE_WS_PATH}?session=${session.sessionId}`, { headers: { Cookie: bindCookie } });
const closed = new Promise((r) => ws.on('close', r));
ws.on('message', (data, isBinary) => {
  const at = Date.now() - t0;
  if (isBinary) {
    if (phase === 'greeting') {
      firstGreetingAudioMs ??= at;
      greetingAudio.push(Buffer.from(data));
    } else {
      if (cur?.doneMs != null) cur.ttfaMs ??= at - cur.doneMs;
      replyAudio.push(Buffer.from(data));
    }
    lastAiAt = at;
    return;
  }
  const m = JSON.parse(String(data));
  if (m.type === 'timer') return;
  ev.push({ at, ...m });
  // audio is generated faster than real time; the AI's final transcript
  // arrives with the (paced) turnComplete, so count transcripts as activity too
  if (m.type === 'transcript' && m.role === 'ai') lastAiAt = at;
  if (m.type === 'transcript' && m.final) console.log(`${at}ms ${m.role}: ${m.text}`);
  if (m.type === 'transcript' && !m.final && m.role === 'ai' && !ev.some((e) => e.type === 'transcript' && e.role === 'ai' && !e.final && e.at > (ev.findLast((x) => x.final && x.role === 'ai')?.at ?? -1) && e !== ev.at(-1))) console.log(`${at}ms ai… (first partial)`);
  if (m.type === 'verdict') console.log(`${at}ms verdict ${m.verdict} ${m.confidence} (${m.engine}) ${m.reasonEn}`);
  if (m.type === 'end') { endMsg = m; console.log(`${at}ms end ${m.reason}`); }
});
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });

const silence = Buffer.alloc(FRAME);
const sendFrames = async (buf) => {
  for (let i = 0; i < buf.length && ws.readyState === 1; i += FRAME) {
    ws.send(buf.subarray(i, i + FRAME));
    await sleep(100);
  }
};

// 1. let the AI greet (stream silence like an open mic) until its turn is final
for (let i = 0; i < 120 && ws.readyState === 1; i++) {
  if (ev.some((e) => e.type === 'transcript' && e.role === 'ai' && e.final)) break;
  ws.send(silence);
  await sleep(100);
}
await sendFrames(Buffer.alloc(FRAME * 10)); // ~1 s for the greeting audio to play out
// 2. caller turns: stream each clip, then open-mic silence until the AI has
//    answered and gone quiet for a moment (or the server ended the call)
phase = 'reply';
const callerTurns = [];
const quietFor = (ms) => Date.now() - t0 - lastAiAt > ms;
for (const clip of clips) {
  if (ws.readyState !== 1 || endMsg) break;
  cur = { file: clip.file, clipSec: +(clip.pcm.length / 32000).toFixed(2), startMs: Date.now() - t0, doneMs: null, ttfaMs: null };
  callerTurns.push(cur);
  await sendFrames(clip.pcm);
  cur.doneMs = Date.now() - t0;
  for (let i = 0; i < 300 && ws.readyState === 1 && !endMsg; i++) {
    const answered = ev.some((e) => e.type === 'transcript' && e.role === 'ai' && e.final && e.at > cur.doneMs);
    if (answered && quietFor(1500)) break;
    ws.send(silence);
    await sleep(100);
  }
}
// 3. after the last turn: give a server-side closing time to finish, else hang up
for (let i = 0; i < (capSeconds ? 1500 : 250) && ws.readyState === 1 && !endMsg; i++) {
  if (!capSeconds && quietFor(5000)) break;
  ws.send(silence);
  await sleep(100);
}
if (ws.readyState === 1 && !endMsg) ws.send(JSON.stringify({ type: 'end' }));
await Promise.race([closed, sleep(5000)]);

const greet = Buffer.concat(greetingAudio);
const reply = Buffer.concat(replyAudio);
writeFileSync(path.join(outDir, `greeting${TAG}.wav`), wavOf(greet, 24000));
writeFileSync(path.join(outDir, `reply${TAG}.wav`), wavOf(reply, 24000));
const report = {
  ranAt: new Date().toISOString(),
  model: process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live',
  voice: 'Achernar',
  variant: forceScam ? 'forced-scam (relay mechanics only)' : capSeconds ? `short-cap ${capSeconds}s (relay mechanics only)` : 'real-judge',
  maxSeconds: capSeconds || Number(process.env.LIVE_MAX_SECONDS) || 120,
  ttfaGreetingMs: firstGreetingAudioMs,
  callerTurns, // ttfaMs = first AI audio after the caller clip ended (includes VAD end-of-speech)
  greetingAudioSec: +(greet.length / 48000).toFixed(2),
  replyAudioSec: +(reply.length / 48000).toFixed(2),
  transcripts: ev.filter((e) => e.type === 'transcript' && e.final).map(({ at, role, text }) => ({ at, role, text })),
  verdicts: ev.filter((e) => e.type === 'verdict'),
  interrupted: ev.filter((e) => e.type === 'interrupted').map((e) => e.at),
  end: endMsg,
  usageFrames: usage.length,
  usageLast: usage.at(-1) || null,
  serverLog: serverLog.filter((l) => !/key/i.test(l)),
};
writeFileSync(path.join(outDir, `smoke${TAG}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ttfaGreetingMs: report.ttfaGreetingMs, ttfaReply: callerTurns.map((t) => t.ttfaMs), end: endMsg?.reason }, null, 0));
live.close();
server.closeAllConnections?.();
server.close();
process.exit(0);
