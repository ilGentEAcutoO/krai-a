// Live freestyle relay (TASK-022): session gate (shared captchaGate, per-IP,
// per-day), server-side cap/idle enforcement, transcript → judge → verdict,
// and upstream cleanup on every exit path. Gemini is a fake upstream socket;
// the browser is a real `ws` client so the actual upgrade path is exercised;
// reCAPTCHA is the real gate against a stubbed Google endpoint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import express from 'express';
import WebSocket from 'ws';
import { createLiveVoice, LIVE_WS_PATH } from '../src/liveVoice.js';
import { resetLimits } from '../src/ratelimit.js';
import { config } from '../src/config.js';
import { downsampleToPcm16 } from '../public/demo-live.js';

const FAKE_KEY = 'test-gemini-key-never-leaves-the-server'; // deliberately not AIza…-shaped (secret scanners)

class FakeUpstream extends EventEmitter {
  constructor(target, { ignoreClose = false } = {}) {
    super();
    this.target = target;
    this.sent = [];
    this.readyState = 0;
    this.closed = false;
    this.ignoreClose = ignoreClose; // simulates Gemini never acking our close frame
    this.closeCalls = 0;
    this.terminated = false;
    setImmediate(() => {
      if (this.closed) return;
      this.readyState = 1;
      this.emit('open');
    });
  }
  send(s) {
    const msg = JSON.parse(s);
    this.sent.push(msg);
    this.emit('sent', msg);
  }
  close() {
    this.closeCalls += 1;
    if (this.ignoreClose) { this.readyState = 2; return; }
    this.finish();
  }
  terminate() {
    this.terminated = true;
    this.finish();
  }
  finish() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit('close', 1000, Buffer.from(''));
  }
  serverSend(obj) { this.emit('message', Buffer.from(JSON.stringify(obj)), true); }
  texts() { return this.sent.filter((m) => m.realtimeInput?.text).map((m) => m.realtimeInput.text); }
}

// Real captchaGate/verifyCaptcha; only Google's assessment endpoint is faked.
// byToken: token -> { valid, score }. Returns a restore function.
function stubRecaptcha(byToken) {
  const realFetch = globalThis.fetch;
  const savedKey = config.recaptchaApiKey;
  config.recaptchaApiKey = 'configured-recaptcha-key-for-test';
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('recaptchaenterprise.googleapis.com')) return realFetch(url, init);
    const { event } = JSON.parse(init.body);
    const r = byToken[event.token] || { valid: false };
    return new Response(JSON.stringify({
      tokenProperties: { valid: r.valid, action: event.expectedAction, ...(r.valid ? {} : { invalidReason: 'MALFORMED' }) },
      riskAnalysis: { score: r.score ?? 0 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return () => { globalThis.fetch = realFetch; config.recaptchaApiKey = savedKey; };
}

const waitFor = async (fn, ms = 3000, what = 'condition') => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function harness(opts = {}, { upstreamIgnoresClose = false } = {}) {
  resetLimits();
  const upstreams = [];
  const judgeCalls = [];
  const live = createLiveVoice({
    apiKey: FAKE_KEY,
    available: () => true, // isLiveAI() is false under node --test (aiOffline)
    model: 'gemini-3.8-live',
    maxSeconds: 120,
    maxPerIpHour: 3,
    maxPerDay: 300,
    connectUpstream: (target) => {
      const u = new FakeUpstream(target, { ignoreClose: upstreamIgnoresClose });
      upstreams.push(u);
      return u;
    },
    judge: async (input) => {
      judgeCalls.push(input);
      return { verdict: 'UNSURE', confidence: 0.5, signals: {}, reasonTh: 'ยังไม่แน่ใจ', reasonEn: 'Not sure yet', engine: 'jev', latencyMs: 5 };
    },
    log: () => {},
    ...opts,
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
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `127.0.0.1:${server.address().port}`;
  const post = (body = { captchaToken: 'tok' }, ip = '203.0.113.7') => fetch(`http://${base}/api/live/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify(body),
  });
  // Issue a session like the browser: the response sets the ka_live binding cookie.
  const issue = async (body, ip = '203.0.113.7') => {
    const res = await post(body, ip);
    assert.equal(res.status, 200);
    const { sessionId } = await res.json();
    const setCookie = res.headers.get('set-cookie') || '';
    return { sessionId, cookie: setCookie.split(';')[0], ip, setCookie };
  };
  const open = async (sessionId, { ip = '203.0.113.7', cookie = '' } = {}) => {
    const headers = { 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}) };
    const ws = new WebSocket(`ws://${base}${LIVE_WS_PATH}?session=${encodeURIComponent(sessionId)}`, { headers });
    ws.texts = [];
    ws.raw = [];
    ws.bins = [];
    ws.on('message', (data, isBinary) => {
      if (isBinary) ws.bins.push(Buffer.from(data));
      else { ws.raw.push(String(data)); ws.texts.push(JSON.parse(String(data))); }
    });
    ws.closedP = new Promise((r) => ws.on('close', (code) => { ws.closeCode = code; r(code); }));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    return ws;
  };
  const start = async (body) => {
    const { sessionId, cookie, ip } = await issue(body);
    const ws = await open(sessionId, { cookie, ip });
    const up = await waitFor(() => upstreams.at(-1), 2000, 'upstream');
    await waitFor(() => up.sent.length >= 1, 2000, 'setup frame');
    return { ws, up };
  };
  const ready = async (body) => {
    const s = await start(body);
    s.up.serverSend({ setupComplete: {} });
    await waitFor(() => s.up.texts().length >= 1, 2000, 'greeting control');
    return s;
  };
  const close = async () => {
    live.close();
    await new Promise((r) => server.close(r));
  };
  return { live, post, issue, open, start, ready, upstreams, judgeCalls, close, base };
}

// ---------- session gate ----------

test('session: returns {sessionId, maxSeconds} only — key never in the payload', async () => {
  const h = await harness();
  try {
    const res = await h.post();
    assert.equal(res.status, 200);
    const text = await res.text();
    const body = JSON.parse(text);
    assert.deepEqual(Object.keys(body).sort(), ['maxSeconds', 'sessionId']);
    assert.equal(body.maxSeconds, 120);
    assert.ok(body.sessionId.length >= 20, 'session id is unguessable');
    assert.ok(!text.includes(FAKE_KEY));
  } finally { await h.close(); }
});

test('session: captcha token required when reCAPTCHA is configured → 400 with friendly copy', async () => {
  const restore = stubRecaptcha({});
  const h = await harness();
  try {
    const res = await h.post({});
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'captcha-required');
    assert.ok(body.friendly.th && body.friendly.en);
    assert.equal(body.fallback, 'scenarios');
  } finally { restore(); await h.close(); }
});

test('session: invalid captcha → 403 and does not burn the live IP quota', async () => {
  const restore = stubRecaptcha({ good: { valid: true, score: 0.9 } });
  const h = await harness();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await h.post({ captchaToken: 'bad' })).status, 403);
    for (let i = 0; i < 3; i++) assert.equal((await h.post({ captchaToken: 'good' })).status, 200);
  } finally { restore(); await h.close(); }
});

test('session: low reCAPTCHA score is never a hard lock — one low-trust pass per IP/hour, then friendly 403', async () => {
  const restore = stubRecaptcha({ low: { valid: true, score: 0.1 } });
  const h = await harness();
  try {
    assert.equal((await h.post({ captchaToken: 'low' }, '198.51.100.9')).status, 200, 'first low score passes');
    const res = await h.post({ captchaToken: 'low' }, '198.51.100.9');
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'captcha-score');
    assert.equal(body.fallback, 'scenarios');
    assert.ok(body.friendly.th);
    assert.equal((await h.post({ captchaToken: 'low' }, '198.51.100.10')).status, 200, 'another judge still gets in');
  } finally { restore(); await h.close(); }
});

test('session: per-IP cap (3/hour) → 429 scope ip; other IPs unaffected', async () => {
  const h = await harness();
  try {
    for (let i = 0; i < 3; i++) assert.equal((await h.post(undefined, '198.51.100.1')).status, 200);
    const res = await h.post(undefined, '198.51.100.1');
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.error, 'live-rate-limited');
    assert.equal(body.scope, 'ip');
    assert.ok(body.retryAfterSec > 0);
    assert.equal((await h.post(undefined, '198.51.100.2')).status, 200);
  } finally { await h.close(); }
});

test('session: per-day global cap → 429 scope day', async () => {
  const h = await harness({ maxPerDay: 2 });
  try {
    assert.equal((await h.post(undefined, '192.0.2.1')).status, 200);
    assert.equal((await h.post(undefined, '192.0.2.2')).status, 200);
    const res = await h.post(undefined, '192.0.2.3');
    assert.equal(res.status, 429);
    assert.equal((await res.json()).scope, 'day');
  } finally { await h.close(); }
});

test('session: 503 live-unavailable when live AI is off (no key / AI_OFFLINE) — matches /api/status live:false', async () => {
  const h = await harness({ available: () => false });
  try {
    const res = await h.post();
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'live-unavailable');
  } finally { await h.close(); }
});

test('ws: unknown or reused session id is rejected at upgrade', async () => {
  const h = await harness();
  try {
    await assert.rejects(h.open('not-a-session'));
    const { sessionId, cookie } = await h.issue();
    const ws = await h.open(sessionId, { cookie });
    await assert.rejects(h.open(sessionId, { cookie }), 'one-time session id');
    ws.close();
  } finally { await h.close(); }
});

// ---------- relay ----------

test('relay: setup frame configures model, Achernar voice, transcription, Thai persona', async () => {
  const h = await harness();
  try {
    const { ws, up } = await h.start();
    const setup = up.sent[0].setup;
    assert.equal(setup.model, 'models/gemini-3.8-live');
    assert.deepEqual(setup.generationConfig.responseModalities, ['AUDIO']);
    assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Achernar');
    assert.deepEqual(setup.inputAudioTranscription, {});
    assert.deepEqual(setup.outputAudioTranscription, {});
    const persona = setup.systemInstruction.parts[0].text;
    assert.match(persona, /ค่ะ/);
    assert.match(persona, /OTP/);
    assert.ok(!JSON.stringify(setup).includes(FAKE_KEY), 'key travels in a header, not the setup frame');
    assert.equal(up.target.headers['x-goog-api-key'], FAKE_KEY);
    assert.ok(!up.target.url.includes(FAKE_KEY), 'key never in the URL');
    ws.close();
  } finally { await h.close(); }
});

test('persona: nameless receptionist in both languages — no self-name, no claimed technical problems', async () => {
  const h = await harness();
  try {
    for (const lang of ['th', 'en']) {
      const { ws, up } = await h.start({ captchaToken: 'tok', lang });
      const text = up.sent[0].setup.systemInstruction.parts[0].text;
      assert.ok(!/ใครอะ|krai/i.test(text), `${lang}: no brand/self-name for the model to say`);
      assert.match(text, lang === 'th' ? /ห้ามบอกชื่อตัวเอง/ : /Never state a name for yourself/);
      assert.match(text, lang === 'th' ? /สัญญาณไม่ดี/ : /bad signal/);
      ws.close();
      await waitFor(() => up.closed, 2000, 'upstream closed');
    }
  } finally { await h.close(); }
});

test('relay: mic PCM → realtimeInput.audio; AI PCM → binary frames; greeting sent after setupComplete', async () => {
  const h = await harness();
  try {
    const { ws, up } = await h.start();
    ws.send(Buffer.alloc(3200, 1)); // before setupComplete → dropped: the AI greets first
    await new Promise((r) => setTimeout(r, 50));
    up.serverSend({ setupComplete: {} });
    await waitFor(() => up.texts().length >= 1, 2000, 'greeting');
    const pcm = Buffer.alloc(3200, 7);
    ws.send(pcm);
    await waitFor(() => up.sent.find((m) => m.realtimeInput?.audio), 2000, 'audio forwarded');
    assert.equal(up.sent.filter((m) => m.realtimeInput?.audio).length, 1, 'pre-setup audio not forwarded');
    const audio = up.sent.find((m) => m.realtimeInput?.audio).realtimeInput.audio;
    assert.equal(audio.mimeType, 'audio/pcm;rate=16000');
    assert.equal(Buffer.from(audio.data, 'base64').length, pcm.length);
    assert.match(up.texts()[0], /⟦ระบบ⟧/, 'greeting is a control message');
    assert.ok(Buffer.from(up.sent.find((m) => m.realtimeInput?.audio).realtimeInput.audio.data, 'base64').every((b) => b === 0),
      'mic is silenced while the AI greets');
    up.serverSend({ serverContent: { turnComplete: true } }); // greeting done → the caller's mic goes live
    ws.send(pcm);
    await waitFor(() => up.sent.filter((m) => m.realtimeInput?.audio).length >= 2, 2000, 'live mic forwarded');
    assert.deepEqual(Buffer.from(up.sent.filter((m) => m.realtimeInput?.audio).at(-1).realtimeInput.audio.data, 'base64'), pcm);

    const out = Buffer.alloc(4800, 3);
    up.serverSend({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: out.toString('base64') } }] } } });
    await waitFor(() => ws.bins.length, 2000, 'binary audio to client');
    assert.deepEqual(ws.bins[0], out);
    ws.close();
  } finally { await h.close(); }
});

test('relay: caller transcript → final → judgeTurn → verdict frame; AI transcript finalised on turnComplete', async () => {
  const h = await harness();
  try {
    const { ws, up } = await h.ready();
    up.serverSend({ serverContent: { inputTranscription: { text: 'สวัสดีครับ ผม' } } });
    up.serverSend({ serverContent: { inputTranscription: { text: 'ตำรวจ สภ.เมือง' } } });
    await waitFor(() => ws.texts.find((m) => m.type === 'transcript' && m.role === 'caller' && !m.final), 2000, 'caller partial');
    // model starts answering → caller utterance is final
    up.serverSend({ serverContent: { outputTranscription: { text: 'ขอทราบชื่อด้วยค่ะ' } } });
    const fin = await waitFor(() => ws.texts.find((m) => m.type === 'transcript' && m.role === 'caller' && m.final), 2000, 'caller final');
    assert.equal(fin.text, 'สวัสดีครับ ผมตำรวจ สภ.เมือง');
    const verdict = await waitFor(() => ws.texts.find((m) => m.type === 'verdict'), 2000, 'verdict');
    assert.deepEqual(
      { v: verdict.verdict, c: verdict.confidence, th: verdict.reasonTh, en: verdict.reasonEn, e: verdict.engine },
      { v: 'UNSURE', c: 0.5, th: 'ยังไม่แน่ใจ', en: 'Not sure yet', e: 'jev' },
    );
    const call = h.judgeCalls[0];
    assert.equal(call.callerText, 'สวัสดีครับ ผมตำรวจ สภ.เมือง');
    assert.equal(call.lang, 'th');
    assert.deepEqual(call.turns.at(-1), { role: 'caller', text: 'สวัสดีครับ ผมตำรวจ สภ.เมือง' });

    up.serverSend({ serverContent: { turnComplete: true } });
    const aiFinal = await waitFor(() => ws.texts.find((m) => m.type === 'transcript' && m.role === 'ai' && m.final), 2000, 'ai final');
    assert.equal(aiFinal.text, 'ขอทราบชื่อด้วยค่ะ');
    ws.close();
  } finally { await h.close(); }
});

test('policy: hang-up decision comes from the judge policy (nextAction) — UNSURE keeps talking', async () => {
  const seen = [];
  const h = await harness({ decideAction: async (v, n) => { seen.push([v.verdict, n]); return 'continue'; } });
  try {
    const { ws, up } = await h.ready();
    up.serverSend({ serverContent: { inputTranscription: { text: 'สวัสดีครับ' } } });
    up.serverSend({ serverContent: { turnComplete: true } });
    await waitFor(() => seen.length, 2000, 'decideAction called');
    assert.deepEqual(seen[0], ['UNSURE', 1]);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(up.texts().length, 1, 'no closing on continue');
    ws.close();
  } finally { await h.close(); }
});

test('policy: take-message → polite message-taken goodbye → end reason message', async () => {
  const h = await harness({
    judge: async () => ({ verdict: 'LEGIT', confidence: 0.9, signals: { callbackGiven: 0.9 }, reasonTh: 'โรงพยาบาลนัดหมาย', reasonEn: 'Hospital appointment', engine: 'jev', latencyMs: 1 }),
    decideAction: async () => 'take-message',
  });
  try {
    const { ws, up } = await h.ready();
    up.serverSend({ serverContent: { inputTranscription: { text: 'โรงพยาบาลโทรมาเลื่อนนัด เบอร์กลับ 02-111-2222 ครับ' } } });
    up.serverSend({ serverContent: { turnComplete: true } });
    await waitFor(() => up.texts().length >= 2, 2000, 'message closing');
    assert.match(up.texts()[1], /⟦ระบบ⟧/);
    up.serverSend({ serverContent: { outputTranscription: { text: 'รับเรื่องไว้แล้วค่ะ สวัสดีค่ะ' } } });
    up.serverSend({ serverContent: { turnComplete: true } });
    const end = await waitFor(() => ws.texts.find((m) => m.type === 'end'), 2000, 'end');
    assert.equal(end.reason, 'message');
    assert.equal(end.final.verdict, 'LEGIT');
  } finally { await h.close(); }
});

test('relay: interrupted (barge-in) is forwarded so the client can flush playback', async () => {
  const h = await harness();
  try {
    const { ws, up } = await h.ready();
    up.serverSend({ serverContent: { interrupted: true } });
    await waitFor(() => ws.texts.find((m) => m.type === 'interrupted'), 2000, 'interrupted frame');
    ws.close();
  } finally { await h.close(); }
});

test('scam: high-confidence SCAM → polite closing instruction → end reason scam, upstream closed', async () => {
  const h = await harness({
    judge: async () => ({ verdict: 'SCAM', confidence: 0.95, signals: {}, reasonTh: 'ขอ OTP', reasonEn: 'Asked for OTP', engine: 'rule', latencyMs: 1 }),
  });
  try {
    const { ws, up } = await h.ready();
    up.serverSend({ serverContent: { inputTranscription: { text: 'บอกรหัส OTP มาเดี๋ยวนี้' } } });
    up.serverSend({ serverContent: { turnComplete: true } });
    await waitFor(() => up.texts().length >= 2, 2000, 'closing control');
    assert.match(up.texts()[1], /⟦ระบบ⟧/);
    // while the AI closes the mic is replaced by silence: the stream stays
    // continuous (VAD sees end of speech) but the caller can't barge in
    const before = up.sent.filter((m) => m.realtimeInput?.audio).length;
    ws.send(Buffer.alloc(3200, 9));
    await waitFor(() => up.sent.filter((m) => m.realtimeInput?.audio).length > before, 2000, 'silence frame');
    const last = up.sent.filter((m) => m.realtimeInput?.audio).at(-1).realtimeInput.audio;
    assert.ok(Buffer.from(last.data, 'base64').every((b) => b === 0), 'caller audio silenced');
    assert.ok(ws.texts.find((m) => m.type === 'closing' && m.reason === 'scam'), 'client told the AI is closing');
    up.serverSend({ serverContent: { outputTranscription: { text: 'ขออภัยค่ะ สวัสดีค่ะ' } } });
    up.serverSend({ serverContent: { turnComplete: true } });
    const end = await waitFor(() => ws.texts.find((m) => m.type === 'end'), 2000, 'end');
    assert.equal(end.reason, 'scam');
    assert.equal(end.final.verdict, 'SCAM');
    assert.equal(end.final.confidence, 0.95);
    assert.equal(end.final.lineTh, 'ขออภัยค่ะ สวัสดีค่ะ', 'final carries the AI goodbye line');
    await waitFor(() => up.closed, 2000, 'upstream closed');
    await ws.closedP;
    assert.equal(h.live.stats().active, 0);
  } finally { await h.close(); }
});

test('scam: verdict while the AI is mid-sentence → goodbye waits for turnComplete; a stale turnComplete never ends the call', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = await harness({
    judge: async () => { await gate; return { verdict: 'SCAM', confidence: 0.9, signals: {}, reasonTh: 'x', reasonEn: 'x', engine: 'jev', latencyMs: 1 }; },
  });
  try {
    const { ws, up } = await h.ready();
    up.serverSend({ serverContent: { inputTranscription: { text: 'ผมตำรวจ คุณมีคดีฟอกเงิน' } } });
    up.serverSend({ serverContent: { outputTranscription: { text: 'ขอทราบชื่อ' } } }); // AI starts its reply
    await waitFor(() => h.judgeCalls.length || ws.texts.find((m) => m.final && m.role === 'caller'), 2000, 'caller final');
    release();
    await waitFor(() => ws.texts.find((m) => m.type === 'verdict'), 2000, 'verdict');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(up.texts().length, 1, 'no goodbye injected while the AI is speaking');
    // audioStreamEnd mid-utterance stalls Gemini Live (smoke 2026-10-12) — never send it
    assert.ok(!up.sent.some((m) => m.realtimeInput?.audioStreamEnd));
    up.serverSend({ serverContent: { turnComplete: true } }); // the AI finishes its sentence
    await waitFor(() => up.texts().length >= 2, 2000, 'goodbye injected after turnComplete');
    up.serverSend({ serverContent: { turnComplete: true } }); // stale/empty turnComplete
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!ws.texts.find((m) => m.type === 'end'), 'no end before the goodbye is spoken');
    up.serverSend({ serverContent: { outputTranscription: { text: 'ขออภัยค่ะ สวัสดีค่ะ' } } });
    up.serverSend({ serverContent: { turnComplete: true } });
    const end = await waitFor(() => ws.texts.find((m) => m.type === 'end'), 2000, 'end');
    assert.equal(end.reason, 'scam');
  } finally { await h.close(); }
});

test('scam: closing deadline ends the call if the model never answers the goodbye', async () => {
  const h = await harness({
    closingMaxMs: 200,
    judge: async () => ({ verdict: 'SCAM', confidence: 0.99, signals: {}, reasonTh: 'x', reasonEn: 'x', engine: 'rule', latencyMs: 1 }),
  });
  try {
    const { ws, up } = await h.ready();
    up.serverSend({ serverContent: { inputTranscription: { text: 'ขอ OTP' } } });
    up.serverSend({ serverContent: { turnComplete: true } });
    const end = await waitFor(() => ws.texts.find((m) => m.type === 'end'), 2000, 'end by deadline');
    assert.equal(end.reason, 'scam');
    await waitFor(() => up.closed, 1000, 'upstream closed');
  } finally { await h.close(); }
});

test('cap: timer frames, closing at cap−lead, hard close at cap even if upstream and client misbehave', async () => {
  const h = await harness({ maxSeconds: 1.2, closingLeadMs: 600, tickMs: 100 });
  try {
    const { ws, up } = await h.ready();
    const t0 = Date.now();
    const pump = setInterval(() => { if (ws.readyState === 1) ws.send(Buffer.alloc(320)); }, 50); // client keeps streaming
    await waitFor(() => ws.texts.find((m) => m.type === 'timer'), 1000, 'timer');
    await waitFor(() => up.texts().length >= 2, 1500, 'cap closing control');
    assert.ok(Date.now() - t0 >= 400, 'closing not before cap−lead');
    const end = await waitFor(() => ws.texts.find((m) => m.type === 'end'), 2000, 'end at cap');
    clearInterval(pump);
    assert.equal(end.reason, 'cap');
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2000, `server enforced the cap (${elapsed}ms)`);
    const timers = ws.texts.filter((m) => m.type === 'timer').map((m) => m.remainingMs);
    assert.ok(timers.length >= 3);
    assert.ok(timers.every((v, i) => i === 0 || v <= timers[i - 1]), 'remainingMs counts down');
    await waitFor(() => up.closed, 1000, 'upstream closed');
    await ws.closedP;
  } finally { await h.close(); }
});

test('idle: no speech activity → end reason idle, upstream closed', async () => {
  const h = await harness({ idleMs: 300, tickMs: 50 });
  try {
    const { ws, up } = await h.ready();
    const end = await waitFor(() => ws.texts.find((m) => m.type === 'end'), 2000, 'idle end');
    assert.equal(end.reason, 'idle');
    await waitFor(() => up.closed, 1000, 'upstream closed');
  } finally { await h.close(); }
});

test('idle: an open caller utterance (VAD ACTIVITY_START) is not idle — Gemini only transcribes at its end', async () => {
  const h = await harness({ idleMs: 300, maxUtteranceMs: 5000, tickMs: 50 });
  try {
    const { ws, up } = await h.ready();
    up.serverSend({ voiceActivity: { type: 'ACTIVITY_START', audioOffset: '1s' } });
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(!ws.texts.find((m) => m.type === 'end'), 'a long monologue is not idle');
    up.serverSend({ voiceActivity: { type: 'ACTIVITY_END', audioOffset: '2s' } });
    const end = await waitFor(() => ws.texts.find((m) => m.type === 'end'), 2000, 'idle after the caller stops');
    assert.equal(end.reason, 'idle');
  } finally { await h.close(); }
});

test('idle: a VAD stuck open (noise / looping audio) still ends after maxUtteranceMs', async () => {
  const h = await harness({ idleMs: 200, maxUtteranceMs: 500, tickMs: 50 });
  try {
    const { ws, up } = await h.ready();
    const t0 = Date.now();
    up.serverSend({ voiceActivity: { type: 'ACTIVITY_START', audioOffset: '1s' } });
    const end = await waitFor(() => ws.texts.find((m) => m.type === 'end'), 3000, 'stuck VAD ends');
    assert.equal(end.reason, 'idle');
    assert.ok(Date.now() - t0 >= 450, 'held while within maxUtteranceMs');
    await waitFor(() => up.closed, 1000, 'upstream closed');
  } finally { await h.close(); }
});

test('cleanup: client disconnect closes upstream and frees the slot', async () => {
  const h = await harness();
  try {
    const { ws, up } = await h.ready();
    assert.equal(h.live.stats().active, 1);
    ws.terminate();
    await waitFor(() => up.closed, 2000, 'upstream closed');
    await waitFor(() => h.live.stats().active === 0, 2000, 'slot freed');
  } finally { await h.close(); }
});

test('cleanup: client {type:end} ends with reason client', async () => {
  const h = await harness();
  try {
    const { ws, up } = await h.ready();
    ws.send(JSON.stringify({ type: 'end' }));
    const end = await waitFor(() => ws.texts.find((m) => m.type === 'end'), 2000, 'end');
    assert.equal(end.reason, 'client');
    await waitFor(() => up.closed, 1000, 'upstream closed');
  } finally { await h.close(); }
});

test('failure: upstream dies before setupComplete → end error live-unavailable', async () => {
  const h = await harness();
  try {
    const { ws, up } = await h.start();
    up.emit('error', new Error('boom'));
    up.close();
    const end = await waitFor(() => ws.texts.find((m) => m.type === 'end'), 2000, 'end');
    assert.equal(end.reason, 'error');
    assert.equal(end.code, 'live-unavailable');
    await ws.closedP;
  } finally { await h.close(); }
});

test('failure: setup timeout → end error live-unavailable, upstream closed', async () => {
  const h = await harness({ setupTimeoutMs: 150 });
  try {
    const { ws, up } = await h.start();
    const end = await waitFor(() => ws.texts.find((m) => m.type === 'end'), 2000, 'end');
    assert.equal(end.code, 'live-unavailable');
    await waitFor(() => up.closed, 1000, 'upstream closed');
  } finally { await h.close(); }
});

test('abuse: mic audio faster than real time is dropped (input token budget)', async () => {
  const h = await harness();
  try {
    const { ws, up } = await h.ready();
    for (let i = 0; i < 40; i++) ws.send(Buffer.alloc(32000)); // 40 s of audio in one burst
    await new Promise((r) => setTimeout(r, 200));
    const bytes = up.sent.filter((m) => m.realtimeInput?.audio)
      .reduce((n, m) => n + Buffer.from(m.realtimeInput.audio.data, 'base64').length, 0);
    assert.ok(bytes <= 32000 * 4, `forwarded ${bytes} bytes`);
    ws.close();
  } finally { await h.close(); }
});

test('privacy: no client frame ever carries the key; client module never names Gemini endpoints', async () => {
  const h = await harness({
    judge: async () => ({ verdict: 'SCAM', confidence: 0.99, signals: {}, reasonTh: 'x', reasonEn: 'x', engine: 'rule', latencyMs: 1 }),
  });
  try {
    const { ws, up } = await h.ready();
    up.serverSend({ serverContent: { inputTranscription: { text: 'โอนเงินมา' } } });
    up.serverSend({ serverContent: { turnComplete: true } });
    await waitFor(() => up.texts().length >= 2, 2000, 'closing control');
    up.serverSend({ serverContent: { outputTranscription: { text: 'สวัสดีค่ะ' } } });
    up.serverSend({ serverContent: { turnComplete: true } });
    await waitFor(() => ws.texts.find((m) => m.type === 'end'), 3000, 'end');
    assert.ok(ws.raw.length > 0);
    for (const frame of ws.raw) assert.ok(!frame.includes(FAKE_KEY));
  } finally { await h.close(); }
  const src = readFileSync(new URL('../public/demo-live.js', import.meta.url), 'utf8');
  assert.ok(!/generativelanguage|GEMINI_API_KEY|x-goog-api-key/i.test(src));
});

// ---------- binding + abuse (rev-live review) ----------

test('binding: session id only upgrades with the ka_live cookie of the browser that created it (IP may change)', async () => {
  const h = await harness();
  try {
    const a = await h.issue(undefined, '198.51.100.20');
    assert.match(a.setCookie, /^ka_live=[A-Za-z0-9_-]{20,};/);
    assert.match(a.setCookie, /Path=\/ws\/live/);
    assert.match(a.setCookie, /HttpOnly/);
    assert.match(a.setCookie, /SameSite=Strict/);
    // dual-stack / mobile: the upgrade may arrive from another address — the cookie is the binding
    const moved = await h.open(a.sessionId, { ip: '2001:db8::21', cookie: a.cookie });
    moved.close();
    const b = await h.issue(undefined, '198.51.100.22');
    await assert.rejects(h.open(b.sessionId, { ip: b.ip }), 'missing cookie refused');
    const c = await h.issue(undefined, '198.51.100.23');
    await assert.rejects(h.open(c.sessionId, { ip: c.ip, cookie: a.cookie }), 'cookie of another visitor refused');
    const d = await h.issue(undefined, '198.51.100.24');
    const ws = await h.open(d.sessionId, { ip: d.ip, cookie: d.cookie });
    ws.close();
  } finally { await h.close(); }
});

test('abuse: tiny-frame flood is dropped and the client is closed with 1008', async () => {
  const h = await harness();
  try {
    const { ws, up } = await h.ready();
    up.serverSend({ serverContent: { turnComplete: true } }); // greeting done → mic would be live
    for (let i = 0; i < 2000 && ws.readyState === 1; i++) ws.send(Buffer.alloc(2));
    assert.equal(await ws.closedP, 1008);
    assert.equal(up.sent.filter((m) => m.realtimeInput?.audio).length, 0, 'no tiny frame reached Gemini');
    const end = ws.texts.find((m) => m.type === 'end');
    assert.equal(end.reason, 'error');
    assert.equal(end.code, 'abuse');
    await waitFor(() => up.closed, 3000, 'upstream closed');
  } finally { await h.close(); }
});

test('abuse: text flood and oversized text frames are ignored, then closed with 1008', async () => {
  const h = await harness();
  try {
    const { ws, up } = await h.ready();
    ws.send(JSON.stringify({ type: 'end', pad: 'x'.repeat(400) })); // > 256 B: never parsed
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(!ws.texts.find((m) => m.type === 'end'), 'oversized text frame ignored');
    const big = 'x'.repeat(1000);
    for (let i = 0; i < 1000 && ws.readyState === 1; i++) ws.send(big);
    assert.equal(await ws.closedP, 1008);
    await waitFor(() => up.closed, 3000, 'upstream closed');
  } finally { await h.close(); }
});

test('abuse: mic frames are rate-limited (~20/s, burst 40) even within the byte budget', async () => {
  const h = await harness();
  try {
    const { ws, up } = await h.ready();
    up.serverSend({ serverContent: { turnComplete: true } });
    for (let i = 0; i < 120; i++) ws.send(Buffer.alloc(320, 5)); // 1.2 s of audio in one burst
    await new Promise((r) => setTimeout(r, 200));
    const n = up.sent.filter((m) => m.realtimeInput?.audio).length;
    assert.ok(n > 0 && n <= 45, `forwarded ${n} frames`);
    assert.equal(ws.readyState, 1, 'one burst is not yet abuse');
    ws.close();
  } finally { await h.close(); }
});

test('cleanup: an upstream that never acks close is terminated after the grace period', async () => {
  const h = await harness({ upstreamCloseGraceMs: 100 }, { upstreamIgnoresClose: true });
  try {
    const { ws, up } = await h.ready();
    ws.send(JSON.stringify({ type: 'end' }));
    await waitFor(() => up.closeCalls >= 1, 2000, 'close attempted');
    assert.equal(up.terminated, false);
    await waitFor(() => up.terminated, 1000, 'terminated after grace');
  } finally { await h.close(); }
});

// ---------- client helper ----------

test('client: CSP-safe — the mic worklet is a same-origin file, never a blob: module', () => {
  const src = readFileSync(new URL('../public/demo-live.js', import.meta.url), 'utf8');
  assert.ok(!/createObjectURL|new Blob\(/.test(src), 'no blob: script (strict script-src \'self\')');
  assert.match(src, /new URL\('\.\/demo-live-worklet\.js', import\.meta\.url\)/);
});

test('client: demo-live-worklet.js registers krai-mic-tap and posts a copy of each mic block', () => {
  const code = readFileSync(new URL('../public/demo-live-worklet.js', import.meta.url), 'utf8');
  const registered = {};
  const posted = [];
  class AudioWorkletProcessor { constructor() { this.port = { postMessage: (d) => posted.push(d) }; } }
  vm.runInNewContext(code, { AudioWorkletProcessor, registerProcessor: (name, cls) => { registered[name] = cls; } });
  const Tap = registered['krai-mic-tap'];
  assert.ok(Tap, 'registered as krai-mic-tap');
  const tap = new Tap();
  const block = new Float32Array([0.1, -0.2, 0.3]);
  assert.equal(tap.process([[block]]), true, 'keeps processing');
  assert.equal(tap.process([[]]), true, 'no input (mic muted) is fine');
  assert.equal(posted.length, 1);
  assert.notEqual(posted[0], block, 'posts a copy (the render buffer is reused)');
  assert.deepEqual(Array.from(posted[0]), Array.from(block));
});

test('client: downsampleToPcm16 converts 48 kHz float to 16 kHz PCM16 with clipping', () => {
  const input = new Float32Array(480).fill(0.5);
  input[0] = 2; // clipped
  const out = downsampleToPcm16(input, 48000);
  assert.ok(out instanceof Int16Array);
  assert.equal(out.length, 160);
  assert.ok(Math.abs(out[80] - Math.round(0.5 * 32767)) <= 1);
  assert.ok(out[0] <= 32767);
  const same = downsampleToPcm16(new Float32Array([0, -1, 1]), 16000);
  assert.deepEqual(Array.from(same), [0, -32768, 32767]);
});
