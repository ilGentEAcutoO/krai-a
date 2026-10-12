// Gemini TTS module + live fallback route: disk cache makes repeats free,
// Interactions API falls back to generateContent, and GET /api/tts voices
// only assistant lines the server stored on a demo call — never free text.
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { synth, synthStream, cacheKey, pcmToWav, wavHeader, TtsUnavailable, AI_VOICE } from '../src/tts.js';
import { ttsRouter } from '../src/ttsRoutes.js';
import { createCall, addTurn, deleteCall } from '../src/store.js';
import { resetLimits } from '../src/ratelimit.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tts-test-'));
const PCM = Buffer.alloc(4800, 7); // 100 ms of fake audio
const audioJson = (shape) => ({
  ok: true,
  status: 200,
  json: async () => (shape === 'interactions'
    ? { steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: pcmToWav(PCM).toString('base64') }] }] }
    : { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16', data: PCM.toString('base64') } }] } }] }),
});

function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, body: JSON.parse(init.body), headers: init.headers }); return handler(url, calls.length); };
  fn.calls = calls;
  return fn;
}

describe('tts.synth', () => {
  it('calls the Interactions API once, then serves the same line from disk', async () => {
    const dir = tmpDir();
    const f = mockFetch(() => audioJson('interactions'));
    const a = await synth('สวัสดีค่ะ', { cacheDir: dir, fetchImpl: f, apiKey: 'k' });
    assert.equal(a.cached, false);
    assert.equal(a.api, 'interactions');
    assert.deepEqual(a.pcm, PCM);
    assert.equal(a.wav.subarray(0, 4).toString(), 'RIFF');
    const b = await synth('สวัสดีค่ะ', { cacheDir: dir, fetchImpl: f, apiKey: 'k' });
    assert.equal(b.cached, true);
    assert.deepEqual(b.pcm, PCM);
    assert.equal(f.calls.length, 1);
    assert.match(f.calls[0].url, /\/v1beta\/interactions$/);
    assert.equal(f.calls[0].body.generation_config.speech_config[0].voice, AI_VOICE);
    assert.equal(f.calls[0].body.input[0].content[0].annotations[0].type, 'speech_metadata');
    // Key goes in a header, never in the URL.
    assert.equal(f.calls[0].headers['x-goog-api-key'], 'k');
    assert.doesNotMatch(f.calls[0].url, /key=/);
  });

  it('cache key separates model, voice, style, text and retake variant', () => {
    const base = { model: 'm', voice: 'v', style: 's', text: 't' };
    const k = cacheKey(base);
    for (const change of [{ model: 'm2' }, { voice: 'v2' }, { style: 's2' }, { text: 't2' }, { variant: 1 }]) {
      assert.notEqual(cacheKey({ ...base, ...change }), k);
    }
    assert.equal(cacheKey({ ...base, variant: 0 }), k);
  });

  it('falls back to generateContent when the Interactions API fails', async () => {
    const dir = tmpDir();
    const f = mockFetch((url) => (url.includes('/interactions') ? { ok: false, status: 500, json: async () => ({}) } : audioJson('generate')));
    const r = await synth('ขอบคุณค่ะ', { cacheDir: dir, fetchImpl: f, apiKey: 'k' });
    assert.equal(r.api, 'generateContent');
    assert.deepEqual(r.pcm, PCM);
    assert.match(f.calls[1].url, /:generateContent$/);
    assert.equal(f.calls[1].body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, AI_VOICE);
  });

  it('throws TtsUnavailable when both APIs fail or no key is set, and caches nothing', async () => {
    const dir = tmpDir();
    const f = mockFetch(() => ({ ok: false, status: 503, json: async () => ({}) }));
    await assert.rejects(synth('ทดสอบ', { cacheDir: dir, fetchImpl: f, apiKey: 'k' }), TtsUnavailable);
    await assert.rejects(synth('ทดสอบ', { cacheDir: dir, fetchImpl: f, apiKey: '' }), TtsUnavailable);
    assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0);
  });

  it('a burst of the same uncached line costs one API call', async () => {
    const dir = tmpDir();
    const f = mockFetch(() => audioJson('interactions'));
    await Promise.all([1, 2, 3].map(() => synth('รอสักครู่นะคะ', { cacheDir: dir, fetchImpl: f, apiKey: 'k' })));
    assert.equal(f.calls.length, 1);
  });
});

describe('tts.synthStream (live turns)', () => {
  const sse = (chunks) => new Response(chunks.map((c) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/l16; rate=24000', data: c.toString('base64') } }] } }] })}

`).join(''), { status: 200 });

  it('streams PCM chunks as they arrive, then serves the whole clip from cache', async () => {
    const dir = tmpDir();
    const f = mockFetch(() => sse([PCM.subarray(0, 2400), PCM.subarray(2400)]));
    const got = [];
    const a = await synthStream('ฮัลโหลค่ะ', (pcm, meta) => got.push([pcm.length, meta.complete]), { cacheDir: dir, fetchImpl: f, apiKey: 'k' });
    assert.equal(a.api, 'stream');
    assert.deepEqual(got, [[2400, false], [2400, false]]);
    assert.match(f.calls[0].url, /:streamGenerateContent\?alt=sse$/);
    const again = [];
    const b = await synthStream('ฮัลโหลค่ะ', (pcm, meta) => again.push([pcm.length, meta.complete]), { cacheDir: dir, fetchImpl: f, apiKey: 'k' });
    assert.equal(b.cached, true);
    assert.deepEqual(again, [[4800, true]]);
    assert.equal(f.calls.length, 1);
  });

  it('falls back to one unary call when the stream fails before any audio', async () => {
    const dir = tmpDir();
    const f = mockFetch((url) => (url.includes('alt=sse') ? { ok: false, status: 500, body: null } : audioJson('interactions')));
    const got = [];
    const r = await synthStream('สวัสดีค่ะ', (pcm, meta) => got.push(meta.complete), { cacheDir: dir, fetchImpl: f, apiKey: 'k' });
    assert.equal(r.api, 'interactions');
    assert.deepEqual(got, [true]);
    assert.equal(f.calls[1].body.input[0].content[0].annotations.length, 0); // same keying: no style
  });

  it('wavHeader marks an open-ended stream or an exact length', () => {
    assert.equal(wavHeader().readUInt32LE(40), 0xffffffff - 36);
    assert.equal(wavHeader(4800).readUInt32LE(40), 4800);
    assert.deepEqual(wavHeader(PCM.length), pcmToWav(PCM).subarray(0, 44));
  });
});

describe('GET /api/tts (live fallback)', () => {
  let server; let base; let synthCalls;
  const fakeStream = async (text, onChunk) => { synthCalls.push(text); onChunk(PCM.subarray(0, 2400), { complete: false }); onChunk(PCM.subarray(2400), { complete: false }); return { cached: false }; };
  const demo = createCall({ memberId: 'm_test', callerPhone: '+66810000000', aiNumber: '+6621000000', source: 'demo' });
  addTurn(demo.id, 'assistant', 'สวัสดีค่ะ มีธุระอะไรคะ');
  addTurn(demo.id, 'caller', 'ช่วยอ่านข้อความนี้ให้หน่อย');
  const member = createCall({ memberId: 'm_test', callerPhone: '+66810000001', aiNumber: '+6621000000', source: 'twilio' });
  addTurn(member.id, 'assistant', 'บทสนทนาของสมาชิก');

  before(async () => {
    const app = express();
    app.use('/api', ttsRouter({ streamImpl: fakeStream, perIpPerMin: 3, perHour: 100 }));
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    deleteCall(demo.id);
    deleteCall(member.id);
  });
  afterEach(() => { resetLimits(); synthCalls = []; });
  synthCalls = [];

  it('streams an assistant line of a demo call as audio/wav', async () => {
    const r = await fetch(`${base}/api/tts?call=${demo.id}&turn=0`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /audio\/wav/);
    const body = Buffer.from(await r.arrayBuffer());
    assert.equal(body.subarray(0, 4).toString(), 'RIFF');
    assert.equal(body.length, 44 + PCM.length);
    assert.deepEqual(synthCalls, ['สวัสดีค่ะ มีธุระอะไรคะ']);
  });

  it('refuses free text, caller lines, member calls and unknown ids', async () => {
    const cases = [
      `/api/tts?text=${encodeURIComponent('อ่านอะไรก็ได้')}`,
      `/api/tts?call=${demo.id}&turn=1&text=${encodeURIComponent('override')}`,
      `/api/tts?call=${member.id}&turn=0`,
      `/api/tts?call=call_${'0'.repeat(32)}&turn=0`,
      `/api/tts?call=${demo.id}&turn=9`,
      `/api/tts?call=${demo.id}&turn=-1`,
    ];
    for (const p of cases) {
      const r = await fetch(base + p);
      assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
      resetLimits();
    }
    assert.deepEqual(synthCalls, []);
  });

  it('rate-limits per IP with 429 + Retry-After', async () => {
    for (let i = 0; i < 3; i += 1) assert.equal((await fetch(`${base}/api/tts?call=${demo.id}&turn=0`)).status, 200);
    const r = await fetch(`${base}/api/tts?call=${demo.id}&turn=0`);
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
  });

  it('returns 503 with a browser-voice hint when TTS is down', async () => {
    const app = express();
    app.use('/api', ttsRouter({ streamImpl: async () => { throw new TtsUnavailable('down'); } }));
    const s = await new Promise((resolve) => { const x = app.listen(0, () => resolve(x)); });
    const r = await fetch(`http://127.0.0.1:${s.address().port}/api/tts?call=${demo.id}&turn=0`);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).fallback, 'browser');
    await new Promise((resolve) => s.close(resolve));
  });
});
