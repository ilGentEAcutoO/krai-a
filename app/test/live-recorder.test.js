// Local-only live-session recorder (TASK-041): off unless LIVE_RECORD_DIR is
// set; with it, one folder per session holding caller.wav, ai.wav and a
// timestamped events.jsonl. Gemini is a fake upstream; the browser is a real
// `ws` client so the actual upgrade path is exercised.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import WebSocket from 'ws';
import { createLiveVoice, LIVE_WS_PATH } from '../src/liveVoice.js';
import { createRecorder, liveRecordDir } from '../src/liveRecorder.js';
import { resetLimits } from '../src/ratelimit.js';

const FAKE_KEY = 'test-gemini-key-never-leaves-the-server';

class FakeUpstream extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.readyState = 0;
    setImmediate(() => { this.readyState = 1; this.emit('open'); });
  }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', 1000, Buffer.from('')); }
  serverSend(obj) { this.emit('message', Buffer.from(JSON.stringify(obj)), true); }
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

async function harness(opts = {}) {
  resetLimits();
  const upstreams = [];
  const live = createLiveVoice({
    apiKey: FAKE_KEY,
    available: () => true,
    connectUpstream: () => { const u = new FakeUpstream(); upstreams.push(u); return u; },
    judge: async () => ({ verdict: 'UNSURE', confidence: 0.4, signals: { authority: 0.1 }, reasonTh: 'ยังไม่แน่ใจ', reasonEn: 'Not sure yet', engine: 'jev', latencyMs: 7 }),
    decideAction: async () => 'continue',
    log: () => {},
    ...opts,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/live', live.router);
  const server = createServer(app);
  server.on('upgrade', (req, socket, head) => live.handleUpgrade(req, socket, head));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `127.0.0.1:${server.address().port}`;
  const start = async (lang = 'th') => {
    const res = await fetch(`http://${base}/api/live/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang }),
    });
    assert.equal(res.status, 200);
    const { sessionId } = await res.json();
    const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
    const ws = new WebSocket(`ws://${base}${LIVE_WS_PATH}?session=${encodeURIComponent(sessionId)}`, { headers: { Cookie: cookie } });
    ws.closedP = new Promise((r) => ws.on('close', r));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const up = await waitFor(() => upstreams.at(-1), 2000, 'upstream');
    await waitFor(() => up.sent.length >= 1, 2000, 'setup frame');
    return { ws, up };
  };
  const close = async () => { live.close(); await new Promise((r) => server.close(r)); };
  return { start, close };
}

const tone = (samples, amp) => {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(Math.sin(i / 5) * amp), i * 2);
  return b;
};

test('recorder: off unless LIVE_RECORD_DIR is set (env only)', () => {
  assert.equal(liveRecordDir({}), '');
  assert.equal(liveRecordDir({ LIVE_RECORD_DIR: '  ' }), '');
  assert.equal(liveRecordDir({ LIVE_RECORD_DIR: '/tmp/x' }), '/tmp/x');
  assert.equal(createRecorder({ dir: '', lang: 'th' }), null);
  // the test runner itself never has it on, so a default createLiveVoice records nothing
  assert.equal(liveRecordDir(), '', 'LIVE_RECORD_DIR must not be set while running the test suite');
});

test('recorder: a live session without recordDir writes no files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-rec-off-'));
  const h = await harness({ recordDir: '' });
  try {
    const { ws, up } = await h.start();
    up.serverSend({ setupComplete: {} });
    ws.send(tone(1600, 8000));
    ws.send(JSON.stringify({ type: 'end' }));
    await ws.closedP;
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { await h.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('recorder: with recordDir a session writes caller.wav, ai.wav and events.jsonl', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-rec-on-'));
  const h = await harness({ recordDir: dir });
  try {
    const { ws, up } = await h.start('en');
    up.serverSend({ setupComplete: {} });
    const ai = tone(2400, 4000);
    up.serverSend({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: ai.toString('base64') } }] }, outputTranscription: { text: 'Hello, who is calling?' } } });
    up.serverSend({ serverContent: { turnComplete: true } }); // greeting done → mic unmuted
    ws.send(tone(1600, 8000)); // 100 ms of loud caller audio
    ws.send(tone(1600, 0)); // 100 ms of silence
    up.serverSend({ serverContent: { inputTranscription: { text: 'This is Ann from the clinic' } } });
    up.serverSend({ serverContent: { interrupted: true } });
    up.serverSend({ serverContent: { turnComplete: true } }); // flushes the caller turn → judge
    up.serverSend({ usageMetadata: { promptTokenCount: 10, responseTokenCount: 5, totalTokenCount: 15 } });
    await new Promise((r) => setTimeout(r, 150));
    ws.send(JSON.stringify({ type: 'end' }));
    await ws.closedP;

    const [folder] = await waitFor(() => { const f = fs.readdirSync(dir); return f.length ? f : null; }, 2000, 'session folder');
    assert.match(folder, /^\d{4}-\d{2}-\d{2}T[\d-]+Z-en$/);
    const sdir = path.join(dir, folder);
    await waitFor(() => fs.readFileSync(path.join(sdir, 'events.jsonl'), 'utf8').includes('session-end'), 2000, 'session-end');
    assert.deepEqual(fs.readdirSync(sdir).sort(), ['ai.wav', 'caller.wav', 'events.jsonl']);

    const callerWav = fs.readFileSync(path.join(sdir, 'caller.wav'));
    assert.equal(callerWav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(callerWav.readUInt32LE(24), 16000);
    assert.equal(callerWav.readUInt32LE(40), 6400, 'header patched with the real data size');
    assert.equal(callerWav.length, 44 + 6400);
    const aiWav = fs.readFileSync(path.join(sdir, 'ai.wav'));
    assert.equal(aiWav.readUInt32LE(24), 24000);
    assert.ok(aiWav.subarray(44).equals(ai), 'ai.wav holds the audio exactly as sent');

    const events = fs.readFileSync(path.join(sdir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const types = new Set(events.map((e) => e.type));
    for (const t of ['session-start', 'setup', 'setup-complete', 'control', 'output-transcription', 'ai-audio', 'turnComplete',
      'mic', 'input-transcription', 'interrupted', 'caller-final', 'ai-final', 'judge-start', 'verdict', 'action', 'usage', 'client-end', 'session-end']) {
      assert.ok(types.has(t), `events.jsonl has ${t}`);
    }
    assert.ok(events.every((e) => Number.isFinite(e.t) && e.t >= 0), 'every event has ms since start');
    const mics = events.filter((e) => e.type === 'mic');
    assert.equal(mics.length, 2, 'one RMS window per 100 ms');
    assert.ok(mics[0].rms > 0.1 && mics[1].rms === 0, 'RMS reflects speech vs silence');
    const verdict = events.find((e) => e.type === 'verdict');
    assert.equal(verdict.verdict, 'UNSURE');
    assert.deepEqual(verdict.signals, { authority: 0.1 });
    assert.equal(events.find((e) => e.type === 'action').act, 'continue');
    const setup = events.find((e) => e.type === 'setup').setup;
    assert.equal(setup.model, 'models/gemini-3.8-live');
    assert.ok(!fs.readFileSync(path.join(sdir, 'events.jsonl'), 'utf8').includes(FAKE_KEY), 'the API key is never recorded');
    assert.equal(events.at(-1).type, 'session-end');
    assert.equal(events.at(-1).reason, 'client');
  } finally { await h.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- analyzer + timeline report (scripts/live-*.mjs) ----------

// A synthetic recorded call on a fake clock: AI greets, caller speaks over the
// AI's second turn (talk-over + interrupted), TV line, then a goodbye.
function fakeSession(dir) {
  let clock = 1_760_000_000_000;
  const t0 = clock;
  const rec = createRecorder({ dir, lang: 'th', now: () => clock, log: () => {} });
  const at = (ms) => { clock = t0 + ms; };
  const pcm = (ms, amp, rate) => tone(Math.round((rate * ms) / 1000), amp);
  at(0); rec.event('session-start', { lang: 'th', model: 'gemini-3.8-live' });
  rec.event('setup', { setup: { model: 'models/gemini-3.8-live' } });
  rec.event('control', { text: '⟦ระบบ⟧ ทักทาย' });
  const ai = (startMs, n, text) => {
    for (let i = 0; i < n; i++) { at(startMs + i * 20); rec.ai(pcm(500, 5000, 24000), 24000); }
    at(startMs); rec.event('output-transcription', { text });
  };
  ai(100, 2, 'สวัสดีค่ะ ขอทราบชื่อและธุระค่ะ');
  at(1100); rec.event('turnComplete'); rec.event('ai-final', { text: 'สวัสดีค่ะ ขอทราบชื่อและธุระค่ะ' });
  at(1500); rec.event('input-transcription', { text: 'ผมโทรจากคลินิกครับ' });
  at(2500); rec.event('caller-final', { text: 'ผมโทรจากคลินิกครับ' });
  rec.event('verdict', { seq: 1, verdict: 'UNSURE', confidence: 0.5, engine: 'jev', signals: {} });
  rec.event('action', { seq: 1, act: 'continue' });
  ai(3000, 4, 'ขอทราบชื่อและธุระค่ะ');
  at(4000); rec.event('interrupted'); rec.event('ai-final', { text: 'ขอทราบชื่อและธุระค่ะ' });
  at(4300); rec.event('input-transcription', { text: 'ข่าวภาคค่ำวันนี้ฝนตกหนัก' });
  at(5000); rec.event('caller-final', { text: 'ข่าวภาคค่ำวันนี้ฝนตกหนัก' });
  rec.event('closing-begin', { reason: 'message' });
  ai(5200, 2, 'จะแจ้งเจ้าของเบอร์ค่ะ');
  at(6200); rec.event('turnComplete'); rec.event('ai-final', { text: 'จะแจ้งเจ้าของเบอร์ค่ะ' });
  // mic: loud 1.3–2.4 s (answer) and 3.5–4.5 s (over the AI), quiet elsewhere
  for (let t = 0; t < 6500; t += 100) {
    at(t);
    const loud = (t >= 1300 && t < 2400) || (t >= 3500 && t < 4500);
    rec.caller(tone(1600, loud ? 9000 : 150));
  }
  at(6500); rec.close({ reason: 'message', durationMs: 6500, verdict: { verdict: 'UNSURE' } });
  return rec.folder;
}

test('analyzer: code metrics + ONE Jev request with the typed question set → analysis.json', async () => {
  const { analyze } = await import('../scripts/live-analyze.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-an-'));
  try {
    const folder = fakeSession(dir);
    const calls = [];
    const fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      const answers = {};
      for (const [id, q] of Object.entries(body.questions)) {
        if (q.type === 'choice') answers[id] = { type: 'choice', choice: id.endsWith('_1') ? 'BACKGROUND' : 'ADDRESSED', probabilities: {} };
        else answers[id] = { type: 'noul', noul: id === 'repeat_ai_1' || id === 'got_organisation' ? 0.9 : 0.1 };
      }
      return new Response(JSON.stringify({ answers, model: 'jev-test' }), { status: 200 });
    };
    const a = await analyze(folder, { fetch, apiKey: 'test-typesafe-key' });
    assert.equal(calls.length, 1, 'exactly one Jev request per session');
    assert.match(calls[0].url, /typesafe\.ai\/v1\/systemone/);
    assert.deepEqual(Object.keys(calls[0].body.questions).sort(), [
      'addressed_caller_0', 'addressed_caller_1', 'final_repeat', 'got_callback', 'got_name', 'got_organisation', 'got_purpose', 'repeat_ai_1', 'repeat_ai_2',
    ]);
    assert.equal(calls[0].body.state.call.turns.length, 5, 'transcript is state; question text never carries caller words');
    for (const q of Object.values(calls[0].body.questions)) assert.ok(!JSON.stringify(q).includes('คลินิก'));
    assert.equal(a.metrics.interruptedCount, 1);
    assert.equal(a.metrics.talkOverCount, 1);
    assert.ok(a.metrics.talkOverMs >= 400 && a.metrics.talkOverMs <= 1100, `talk-over ${a.metrics.talkOverMs}`);
    assert.equal(a.metrics.endReason, 'message');
    assert.equal(a.metrics.closingReason, 'message');
    assert.equal(a.metrics.durationMs, 6500);
    assert.ok(a.metrics.responseLatencyMedianMs != null);
    assert.deepEqual(a.summary, { repeatCount: 1, backgroundCount: 1, finalRepeat: false, slotsObtained: 1 });
    assert.ok(fs.existsSync(path.join(folder, 'analysis.json')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('report: timeline.html + mix.wav per session and an index across sessions', async () => {
  const { reportSession, renderIndex } = await import('../scripts/live-report.mjs');
  const { analyze } = await import('../scripts/live-analyze.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-rep-'));
  try {
    const folder = fakeSession(dir);
    await analyze(folder, { jev: false });
    const row = reportSession(folder);
    const html = fs.readFileSync(path.join(folder, 'timeline.html'), 'utf8');
    assert.match(html, /<html lang="th">/);
    assert.match(html, /color-scheme" content="light only"/);
    assert.match(html, /ผู้โทรพูดแทรก/, 'interrupted marker');
    assert.match(html, /CONTROL/, 'control marker');
    assert.match(html, /AI พูดทับ/, 'talk-over band');
    assert.match(html, /ข่าวภาคค่ำวันนี้ฝนตกหนัก/, 'caller transcript placed on the timeline');
    const mix = fs.readFileSync(path.join(folder, 'mix.wav'));
    assert.equal(mix.readUInt16LE(22), 2, 'stereo: caller left, AI right');
    assert.ok(mix.length > 44 + 6 * 16000 * 4);
    const idx = renderIndex(dir, [row]);
    assert.match(idx, new RegExp(`${path.basename(folder)}/timeline.html`));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
