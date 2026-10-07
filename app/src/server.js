// Krai-a demo: lean hackathon build. Web sessions + real Twilio voice path,
// console alerts (watch them land in /demo.html). No auth/billing/LINE.
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { addMember, listMembers, purgeCalls } from './store.js';
import { voiceIncoming, voiceTurn, voiceStatus } from './twilio/voice.js';
import { demoRouter } from './routes.js';
import { privacyNoticeTh } from './evidence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// One demo household: every call forwarded to the demo number lands here.
if (listMembers().length === 0) {
  addMember({ ownerPhone: '+66800000001', aiNumber: config.demoNumber || '+6620000001', plan: 'starter-20' });
}

app.get('/health', (req, res) => res.json({ ok: true, service: 'krai-a-demo', time: new Date().toISOString() }));
app.get('/privacy', (req, res) => res.json({ updated: '2026-10-07', text: privacyNoticeTh() }));

// Real phone path: point a Twilio number's webhooks here.
app.post('/voice/incoming', voiceIncoming);
app.post('/voice/turn', voiceTurn);
app.post('/voice/status', voiceStatus);

// Demo + data API.
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}
wss.on('connection', (ws) => ws.send(JSON.stringify({ type: 'hello', engines: ['demo'] })));

app.use('/api', demoRouter(broadcast));
app.use(express.static(path.join(__dirname, '..', 'public')));

// PDPA retention: sweep expired call records at boot + daily.
function sweepExpired() {
  try {
    const n = purgeCalls({
      LEGIT: config.retentionLegitDays,
      UNSURE: config.retentionUnsureDays,
      SCAM: config.retentionScamDays,
    });
    if (n) console.log(`[privacy] purged ${n} expired call record(s)`);
  } catch (e) { console.error('[privacy] sweep failed', e.message); }
}
sweepExpired();
setInterval(sweepExpired, 86400000);

server.listen(config.port, () => {
  console.log(`[krai-a-demo] listening on :${config.port} ai=${config.geminiApiKey ? 'gemini' : 'rules'}`);
});
