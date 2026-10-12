// Gemini TTS (gemini-3.8-flash-tts, Interactions API) with a disk cache.
// Docs: https://ai.google.dev/gemini-api/docs/speech-generation
// The public demo is pre-rendered by scripts/render-demo.mjs; at runtime this
// only voices server-generated lines (see ttsRoutes.js). Every clip is keyed
// sha1(model|voice|style|text), so a line is paid for once, then served from
// disk. The key travels in a header, never in a URL that could be logged.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';
export const SAMPLE_RATE = 24000; // Gemini TTS output: 24 kHz mono s16le

export const AI_VOICE = 'Achernar';
export const AI_STYLE = 'calm, warm Thai female receptionist, unhurried, clear';

const DEFAULT_CACHE_DIR = process.env.TTS_CACHE_DIR || path.join(os.tmpdir(), 'krai-a-tts');
const inflight = new Map(); // cache key -> Promise, so a burst of the same line costs one call

export const ttsModel = () => process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts';

// `variant` only forces a fresh take (render retries); it is never sent.
export function cacheKey({ model, voice, style, text, variant }) {
  const parts = [model, voice, style || '', text];
  if (variant) parts.push(`v${variant}`);
  return createHash('sha1').update(parts.join('|')).digest('hex');
}

export function pcmToWav(pcm, rate = SAMPLE_RATE) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Unary responses are audio/wav (RIFF); strip any header to get bare PCM.
const stripRiff = (b) => (b.subarray(0, 4).toString() === 'RIFF' ? b.subarray(44) : b);

function findAudio(o, acc = []) {
  if (!o || typeof o !== 'object') return acc;
  if (Array.isArray(o)) { o.forEach((x) => findAudio(x, acc)); return acc; }
  if (o.type === 'audio' && typeof o.data === 'string') acc.push(o.data);
  if (o.inlineData?.data) acc.push(o.inlineData.data);
  for (const k of Object.keys(o)) if (k !== 'data' && k !== 'inlineData') findAudio(o[k], acc);
  return acc;
}

async function post(url, body, { fetchImpl, timeoutMs, apiKey }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`tts-http-${res.status}`);
    const audio = findAudio(await res.json());
    if (!audio.length) throw new Error('tts-no-audio');
    return stripRiff(Buffer.concat(audio.map((d) => stripRiff(Buffer.from(d, 'base64')))));
  } finally {
    clearTimeout(t);
  }
}

// Interactions API: the only surface with a per-turn `speech_metadata.style`.
const viaInteractions = ({ model, voice, style, text }, opts) => post(`${API}/interactions`, {
  model,
  input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: style ? [{ type: 'speech_metadata', style }] : [] }] }],
  response_format: { type: 'audio' },
  generation_config: { speech_config: [{ voice }] },
}, opts);

// generateContent fallback: same model and voice, no style channel.
const viaGenerateContent = ({ model, voice, text }, opts) => post(`${API}/models/${model}:generateContent`, {
  contents: [{ parts: [{ text }] }],
  generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
}, opts);

export class TtsUnavailable extends Error {}

// synth(text, opts) -> { pcm, wav, sampleRate, cached, api, latencyMs }
export async function synth(text, {
  voice = AI_VOICE, style = AI_STYLE, model = ttsModel(), cacheDir = DEFAULT_CACHE_DIR, variant = 0,
  fetchImpl = globalThis.fetch, apiKey = config.geminiApiKey, timeoutMs = 25000,
} = {}) {
  const clean = String(text || '').trim();
  if (!clean) throw new TypeError('tts: empty text');
  const key = cacheKey({ model, voice, style, text: clean, variant });
  const file = path.join(cacheDir, `${key}.pcm`);
  const t0 = Date.now();
  try {
    const pcm = await fs.readFile(file);
    return { pcm, wav: pcmToWav(pcm), sampleRate: SAMPLE_RATE, cached: true, api: 'cache', latencyMs: Date.now() - t0 };
  } catch { /* miss */ }

  if (!inflight.has(key)) {
    inflight.set(key, (async () => {
      if (!apiKey) throw new TtsUnavailable('tts: no GEMINI_API_KEY');
      const opts = { fetchImpl, timeoutMs, apiKey };
      const req = { model, voice, style, text: clean };
      let pcm; let api = 'interactions';
      try {
        pcm = await viaInteractions(req, opts);
      } catch (e1) {
        try {
          pcm = await viaGenerateContent(req, opts);
          api = 'generateContent';
        } catch (e2) {
          throw new TtsUnavailable(`tts failed: ${e1.message} / ${e2.message}`);
        }
      }
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(file, pcm);
      return { pcm, api };
    })().finally(() => inflight.delete(key)));
  }
  const { pcm, api } = await inflight.get(key);
  return { pcm, wav: pcmToWav(pcm), sampleRate: SAMPLE_RATE, cached: false, api, latencyMs: Date.now() - t0 };
}

// WAV header for `dataBytes` of PCM; the default (max size) suits a stream
// whose length isn't known yet — browsers play it as it arrives.
export function wavHeader(dataBytes = 0xffffffff - 36, rate = SAMPLE_RATE) {
  const h = pcmToWav(Buffer.alloc(0), rate);
  h.writeUInt32LE(dataBytes + 36, 4);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

// Low-latency path for live turns: generateContent SSE streams PCM (~1.4 s
// to first audio vs ~7 s unary, measured 2026-10-12). This surface has no
// style channel, so it is keyed with an empty style. onChunk(pcm, { complete })
// gets the whole clip at once on a cache hit (complete: true).
export async function synthStream(text, onChunk, {
  voice = AI_VOICE, model = ttsModel(), cacheDir = DEFAULT_CACHE_DIR,
  fetchImpl = globalThis.fetch, apiKey = config.geminiApiKey, timeoutMs = 25000,
} = {}) {
  const clean = String(text || '').trim();
  if (!clean) throw new TypeError('tts: empty text');
  const file = path.join(cacheDir, `${cacheKey({ model, voice, style: '', text: clean })}.pcm`);
  const t0 = Date.now();
  try {
    const pcm = await fs.readFile(file);
    onChunk(pcm, { complete: true });
    return { cached: true, api: 'cache', firstChunkMs: Date.now() - t0, bytes: pcm.length };
  } catch { /* miss */ }
  if (!apiKey) throw new TtsUnavailable('tts: no GEMINI_API_KEY');

  const parts = [];
  let firstChunkMs = null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${API}/models/${model}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: clean }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`tts-sse-http-${res.status}`);
    const dec = new TextDecoder();
    let buf = '';
    const emit = (event) => {
      const data = event.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (!data.startsWith('{')) return;
      for (const b64 of findAudio(JSON.parse(data))) {
        const pcm = stripRiff(Buffer.from(b64, 'base64'));
        if (!pcm.length) continue;
        if (firstChunkMs == null) firstChunkMs = Date.now() - t0;
        parts.push(pcm);
        onChunk(pcm, { complete: false });
      }
    };
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true }).replace(/\r/g, '');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) { emit(buf.slice(0, i)); buf = buf.slice(i + 2); }
    }
    if (buf.trim()) emit(buf);
  } catch (e) {
    if (parts.length) throw e; // mid-stream failure: caller already played part of it
  } finally {
    clearTimeout(timer);
  }

  if (!parts.length) {
    // Stream unavailable: one unary attempt (same voice, no style), whole clip at once.
    const out = await synth(clean, { voice, style: '', model, cacheDir, fetchImpl, apiKey, timeoutMs });
    onChunk(out.pcm, { complete: true });
    return { cached: out.cached, api: out.api, firstChunkMs: Date.now() - t0, bytes: out.pcm.length };
  }
  const pcm = Buffer.concat(parts);
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(file, pcm);
  return { cached: false, api: 'stream', firstChunkMs, bytes: pcm.length };
}
