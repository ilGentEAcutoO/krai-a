// Krai-A server: Twilio voice webhooks + demo API + static console.
// Deploy target: Google Cloud Run (see Dockerfile). Static console served
// from /public so the whole demo is one service.
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { addMember, getMemberByOwner, purgeCalls, getCall } from './store.js';
import { markAssigned } from './numbers.js';
import { voiceIncoming, voiceTurn, voiceStatus } from './twilio/voice.js';
import { twilioSignature } from './twilio/signature.js';
import { privacyNoticeTh } from './evidence.js';
import { bootLoad, startPersistence } from './persist/index.js';
import { lineWebhookHandler } from './line/webhook.js';
import { demoRouter } from './routes.js';
import { billingRouter } from './billingRoutes.js';
import { attachLiveHub } from './live.js';
import { createLiveVoice, LIVE_WS_PATH } from './liveVoice.js';
import { ttsRouter } from './ttsRoutes.js';
import { memberRouter } from './memberRoutes.js';
import { mountRedirects } from './redirects.js';
import { textDemoGate, textDemoEnabled } from './textDemoGate.js';
import { securityHeaders, cspReportRoute } from './securityHeaders.js';
import { take } from './ratelimit.js';
import { probeEngines } from './judge/index.js';
import { startJobs } from './jobs.js';
import { siteMode, siteModeGate } from './siteMode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Node 20 kills the process on an unhandled rejection / stray throw —
// losing up to 15 s of unsnapshotted state and crash-looping the single
// instance. Log instead; request handlers are wrapped (asyncRoute.js) too.
process.on('unhandledRejection', (e) => console.error('[process] unhandled rejection:', e?.stack || e));
process.on('uncaughtException', (e) => console.error('[process] uncaught exception:', e?.stack || e));
const app = express();
// Trust the platform LB (Cloud Run / container ingress) so req.ip is the
// real client — required for per-IP rate limits to mean anything.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(securityHeaders());
app.post('/api/csp-report', express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '16kb' }), cspReportRoute(take));
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: false }));
// SITE_MODE=demo (hackathon site): / = demo.html, member/pay/LINE/Twilio
// routes 404, product pages 302 to the business host. Before every router.
app.use(siteModeGate({ publicDir: path.join(__dirname, '..', 'public') }));

// Seed demo household (mode A default number; override via env). Runs AFTER
// the snapshot restore (a restore replaces the store) and keys on
// SEED_MEMBER_PHONE, so the demo household always exists exactly once.
function ensureSeedMember() {
  const seed = getMemberByOwner(config.seedMemberPhone) || addMember({
    ownerPhone: config.seedMemberPhone,
    aiNumber: config.demoNumber || '+6621000142',
    counted: false, // demo fixture — never counts as a protected household
    plan: 'family-199',
    whitelisted: [{ phone: '+66810000002', label: 'Mom', safeWord: 'mango' }],
    familyWatchers: [],
  });
  markAssigned(seed.aiNumber); // never hand the seed number to signups
}

app.get('/health', (req, res) => res.json({ ok: true, service: 'krai-a', time: new Date().toISOString() }));
app.get('/privacy', (req, res) => res.json({ updated: '2026-10-07', text: privacyNoticeTh() }));

// Telephony adapter (Twilio posts form-encoded). Every /voice/* request
// must carry a valid X-Twilio-Signature — otherwise anyone could inject
// fake calls and transcripts.
app.use('/voice', twilioSignature());
app.post('/voice/incoming', voiceIncoming);
app.post('/voice/turn', voiceTurn);
app.post('/voice/status', voiceStatus);
app.post('/line/webhook', lineWebhookHandler);

// Demo + data API.
const server = createServer(app);
// WebSocket upgrades are routed by exact path (a `{ server, path }` WSS
// answers every other path with 400, which would kill /ws/live). Unknown
// paths drop.
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
const broadcast = attachLiveHub(wss, { canWatch: (id) => getCall(id)?.source === 'demo' });
const liveVoice = createLiveVoice();
const wsRoutes = new Map([
  // The /ws hub only streams text-demo calls: closed with the text demo.
  ['/ws', (req, socket, head) => (textDemoEnabled()
    ? wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
    : socket.destroy())],
  [LIVE_WS_PATH, (req, socket, head) => liveVoice.handleUpgrade(req, socket, head)],
]);
server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { /* malformed */ }
  const route = wsRoutes.get(pathname);
  if (route) route(req, socket, head);
  else socket.destroy();
});

mountRedirects(app);

app.use(textDemoGate()); // /api/demo/*, /api/analyze, /api/calls, /api/tts: 404 unless DEMO_TEXT_API=1
app.use('/api/live', liveVoice.router); // Gemini Live freestyle (captcha + caps inside)
app.use('/api', demoRouter(broadcast));
app.use('/api', memberRouter()); // central-number households (/me/household, /me/protected*, /watchers/link)
app.use('/api', ttsRouter()); // GET /api/tts: voices stored demo assistant turns only
app.use('/api/billing', billingRouter());
app.use(express.static(path.join(__dirname, '..', 'public')));
// Malformed bodies and stray errors answer in JSON — never a stack trace.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = Number(err?.status) >= 400 && Number(err?.status) < 500 ? Number(err.status) : 500;
  if (status === 500) console.error(`[http] ${req.method} ${req.path} failed:`, err?.message || err);
  if (!res.headersSent) res.status(status).json({ error: status === 500 ? 'internal' : 'bad-request' });
});

// PDPA retention: sweep expired (and abandoned, >24 h unfinished) call
// records at boot + hourly.
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

await bootLoad(); // restore snapshot before serving (no-op locally)
ensureSeedMember();
sweepExpired(); // after the restore, so restored expired records go too
setInterval(sweepExpired, 3600000).unref();
startPersistence(); // 15s snapshots + SIGTERM flush (needs max-instances=1)
if (siteMode() === 'product') startJobs(); // hourly trial reminders / lapse sweep (after the restore; not under NODE_ENV=test)
probeEngines().catch(() => {}); // first /api/status is already truthful

server.listen(config.port, () => {
  console.log(`[krai-a] listening on :${config.port} site=${siteMode()} identifyMode=${config.identifyMode} ai=${config.geminiApiKey ? 'gemini' : 'rules'}`);
});
