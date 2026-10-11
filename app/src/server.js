// Krai-a server: Twilio voice webhooks + demo API + static console.
// Deploy target: Google Cloud Run (see Dockerfile). Static console served
// from /public so the whole demo is one service.
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { addMember, listMembers, purgeCalls } from './store.js';
import { markAssigned } from './numbers.js';
import { voiceIncoming, voiceTurn, voiceStatus } from './twilio/voice.js';
import { privacyNoticeTh } from './evidence.js';
import { bootLoad, startPersistence } from './persist/index.js';
import { lineWebhookHandler } from './line/webhook.js';
import { demoRouter } from './routes.js';
import { billingRouter } from './billingRoutes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// Trust the platform LB (Cloud Run / container ingress) so req.ip is the
// real client — required for per-IP rate limits to mean anything.
app.set('trust proxy', 1);
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: false }));

// Seed demo household (mode A default number; override via env).
if (listMembers().length === 0) {
  const seed = addMember({
    ownerPhone: config.seedMemberPhone,
    aiNumber: config.demoNumber || '+6621000142',
    counted: false, // demo fixture — never counts as a protected household
    plan: 'family-149',
    whitelisted: [{ phone: '+66810000002', label: 'Mom', safeWord: 'mango' }],
    familyWatchers: [],
  });
  markAssigned(seed.aiNumber); // never hand the seed number to signups
}

app.get('/health', (req, res) => res.json({ ok: true, service: 'krai-a', time: new Date().toISOString() }));
app.get('/privacy', (req, res) => res.json({ updated: '2026-10-07', text: privacyNoticeTh() }));

// Telephony adapter (Twilio posts form-encoded).
app.post('/voice/incoming', voiceIncoming);
app.post('/voice/turn', voiceTurn);
app.post('/voice/status', voiceStatus);
app.post('/line/webhook', lineWebhookHandler);

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
app.use('/api/billing', billingRouter());
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

await bootLoad(); // restore snapshot before serving (no-op locally)
startPersistence(); // 15s snapshots + SIGTERM flush (needs max-instances=1)

server.listen(config.port, () => {
  console.log(`[krai-a] listening on :${config.port} identifyMode=${config.identifyMode} ai=${config.geminiApiKey ? 'gemini' : 'rules'}`);
});
