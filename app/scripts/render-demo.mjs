#!/usr/bin/env node
// Records the public demo ONCE from the real engine and freezes it as static
// files, so visitors replay it with zero API calls:
//   public/demo/scenarios.json + public/demo/audio/<scenario>-NN.mp3
//   public/voice-audio/prompts.json + <prompt>.mp3 (8 kHz, real phone calls)
// Per scenario: caller lines come from src/demoScripts.js; after every caller
// line the REAL judgeTurn rules on the call so far; the REAL personaReply
// answers; the call ends on the engine's own policy. Then every line is voiced
// with Gemini TTS, loudness-normalised to mono mp3 with ffmpeg and timed with
// ffprobe. Optional check: each clip is transcribed and Jev confirms the audio
// says the scripted words; a failed take is re-rendered.
//
// Run from app/:  node scripts/render-demo.mjs [--only id,id] [--dry] [--stub] [--no-verify] [--prompts-only]
// --dry records the conversations and prints them (engine only, no TTS, no files).
// Local only (needs ffmpeg/ffprobe + GEMINI_API_KEY; TypeSafe key from .env or ~/.typesafe.env).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(APP);
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

// Local TypeSafe key fallback (machine key is for local work like this only).
if (!process.env.TYPESAFE_API_KEY) {
  const envKey = /^TYPESAFE_API_KEY=(.*)$/m.exec(fs.readFileSync(path.join(APP, '.env'), 'utf8'))?.[1]?.trim();
  const home = path.join(os.homedir(), '.typesafe.env');
  const homeKey = fs.existsSync(home) ? /^TYPESAFE_API_KEY=(.*)$/m.exec(fs.readFileSync(home, 'utf8'))?.[1]?.trim() : '';
  if (!envKey && homeKey) process.env.TYPESAFE_API_KEY = homeKey.replace(/^["']|["']$/g, '');
}

const { config } = await import('../src/config.js');
const { synth, ttsModel, AI_VOICE, AI_STYLE } = await import('../src/tts.js');
const { SCRIPTS, displayPhone } = await import('../src/demoScripts.js');

const OUT_DEMO = path.join(APP, 'public', 'demo');
const OUT_AUDIO = path.join(OUT_DEMO, 'audio');
const OUT_PHONE = path.join(APP, 'public', 'voice-audio');
const CACHE = path.resolve(APP, '..', 'agent-temp', 'tts-cache');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'krai-render-'));
const TEXT_MODEL = process.env.RENDER_TEXT_MODEL || 'gemini-3.8-flash';
const API = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_TOTAL_BYTES = 3 * 1024 * 1024;

const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const ffprobe = process.env.FFPROBE || 'ffprobe';

// ---------- engine ----------
async function loadEngine() {
  if (!flag('--stub')) {
    try {
      const m = await import('../src/judge/index.js');
      return { ...m, stub: false };
    } catch (e) {
      console.error(`src/judge/index.js not loadable (${e.message}). Re-run with --stub for a pipeline dry-run.`);
      process.exit(2);
    }
  }
  // Stub with the judge contract's signatures, built on the legacy modules.
  const { judge, shouldEndNow } = await import('../src/verdict.js');
  const ai = await import('../src/ai.js');
  const asCall = (turns) => ({ turns: turns.map((t) => ({ role: t.role === 'caller' ? 'caller' : 'assistant', text: t.text })) });
  return {
    stub: true,
    shouldEndNow,
    async judgeTurn({ turns }) {
      const t0 = Date.now();
      const v = await judge({ call: asCall(turns), member: {}, isWhitelistedCaller: false });
      const sig = new Set(v.pressureSignals || []);
      return {
        verdict: v.verdict, confidence: v.confidence,
        signals: { authority: +sig.has('authority'), urgency: +sig.has('urgency'), secrecy: +sig.has('secrecy'), moneyTransfer: 0, otpRequest: 0, appInstall: 0, identityProbe: 0 },
        reasonTh: v.reason, reasonEn: v.reasonEn, engine: v.engine === 'hard-rule' ? 'rule' : 'rules-fallback', latencyMs: Date.now() - t0,
      };
    },
    async personaReply({ turns }) {
      const callerTurns = turns.filter((t) => t.role === 'caller').length;
      if (!callerTurns) return { text: ai.openingLine(), engine: 'canned', latencyMs: 0 };
      const r = await ai.personaReply(turns.map((t) => `${t.role === 'caller' ? 'caller' : 'assistant'}: ${t.text}`).join('\n'), callerTurns);
      return { text: r.text, engine: r.engine === 'gemini' ? 'gemini' : 'canned', latencyMs: 0 };
    },
  };
}

// Closing when the script runs out while the policy would still continue:
// the caller has nothing more to say, so the receptionist wraps up.
const closeAction = (verdict) => (verdict.verdict === 'SCAM' ? 'hangup' : 'take-message');

// ---------- Gemini text helpers (generation only: subtitles + owner summary) ----------
const textCache = path.join(CACHE, 'text');
async function geminiJson(prompt, schema) {
  const key = createHash('sha1').update(TEXT_MODEL + JSON.stringify(schema) + prompt).digest('hex');
  const file = path.join(textCache, `${key}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const res = await fetch(`${API}/models/${TEXT_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': config.geminiApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: schema },
    }),
  });
  if (!res.ok) throw new Error(`gemini text ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const out = JSON.parse(j.candidates[0].content.parts.map((p) => p.text || '').join(''));
  fs.mkdirSync(textCache, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

async function translate(linesTh) {
  if (!linesTh.length) return [];
  const out = await geminiJson(
    `Translate each Thai phone-call line into natural, concise English for on-screen subtitles. Keep names, numbers and politeness; no notes.\n${JSON.stringify(linesTh)}`,
    { type: 'ARRAY', items: { type: 'STRING' } },
  );
  if (!Array.isArray(out) || out.length !== linesTh.length) throw new Error('translation count mismatch');
  return out;
}

// The LINE card body (demo-stage draws the title): ONE sentence that leads
// with what Krai-a did, then the gist of the call.
const LEAD = {
  SCAM: ['ตัดสายแล้ว — ', 'Hung up — '],
  LEGIT: ['ฝากข้อความแล้ว — ', 'Message taken — '],
  UNSURE: ['รอคุณตัดสิน — ', 'Your call — '],
};
async function lineAlert(turns, verdict) {
  const transcript = turns.map((t) => `${t.role === 'caller' ? 'Caller' : 'AI receptionist'}: ${t.textTh}`).join('\n');
  const g = await geminiJson(
    `An AI receptionist screened this call for its owner (final verdict: ${verdict}). Write the gist the owner reads in a LINE alert: who called, what they claimed or wanted, and the callback number if one was given. Short phrases, no subject pronoun, no accusation, no emoji. Thai max 70 characters, English max 90 characters.\n\n${transcript}`,
    { type: 'OBJECT', properties: { th: { type: 'STRING' }, en: { type: 'STRING' } }, required: ['th', 'en'] },
  );
  const [th, en] = LEAD[verdict] || LEAD.UNSURE;
  const out = { lineTh: th + g.th.trim().replace(/[.。]$/, ''), lineEn: en + g.en.trim() };
  if (out.lineTh.length > 95) console.warn(`  !! lineTh is ${out.lineTh.length} chars: ${out.lineTh}`);
  return out;
}

// ---------- audio ----------
const run = (bin, a) => execFileSync(bin, a, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
function encodeMp3(wavBuf, outFile, { rate = 24000, kbps = 40 } = {}) {
  const tmp = path.join(WORK, `${path.basename(outFile)}.wav`);
  fs.writeFileSync(tmp, wavBuf);
  // Trim TTS lead/tail silence, keep 80 ms of air, normalise speech loudness.
  const af = [
    'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.08',
    'areverse', 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.12', 'areverse',
    'loudnorm=I=-16:TP=-1.5:LRA=11',
  ].join(',');
  run(ffmpeg, ['-y', '-loglevel', 'error', '-i', tmp, '-af', af, '-ac', '1', '-ar', String(rate), '-c:a', 'libmp3lame', '-b:a', `${kbps}k`, outFile]);
  const ms = Math.round(Number(run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', outFile]).trim()) * 1000);
  return { ms, bytes: fs.statSync(outFile).size };
}

async function transcribe(wavBuf) {
  const res = await fetch(`${API}/models/${TEXT_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': config.geminiApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ inlineData: { mimeType: 'audio/wav', data: wavBuf.toString('base64') } }, { text: 'Transcribe exactly what is spoken, in the language spoken. Output only the transcript.' }] }],
      generationConfig: { temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(`transcribe ${res.status}`);
  const j = await res.json();
  return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
}

// Jev: one Noul per clip — does the audio say the scripted words?
async function jevMatches(pairs) {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key || !pairs.length) return null;
  const questions = {};
  pairs.forEach((p, i) => {
    questions[`clip_${i}`] = {
      type: 'noul',
      instructions: `Does \`clips[${i}].heard\` (a speech-to-text transcript of a synthetic voice clip) say the same Thai words as \`clips[${i}].script\`? Ignore punctuation, spacing, how digits or abbreviations are written, and polite particles spelled differently.`,
      criteria: { true: 'Same words and meaning; nothing skipped, added or spoken in another language', false: 'Words skipped, added, garbled, repeated, or another language spoken' },
    };
  });
  const res = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.JEV_MODEL || 'jev-latest', state: { clips: pairs }, questions }),
  });
  if (!res.ok) { console.warn(`  jev verify skipped (${res.status})`); return null; }
  const j = await res.json();
  return pairs.map((_, i) => j.answers?.[`clip_${i}`]?.noul ?? null);
}

async function voiceAll(items, { verify, rate, kbps }) {
  // items: [{ say, voice, style, file }] -> adds { ms, bytes, wav, take }
  for (const it of items) {
    it.take = 0;
    it.wav = (await synth(it.say, { voice: it.voice, style: it.style, cacheDir: CACHE, variant: 0 })).wav;
  }
  if (verify) {
    for (let round = 0; round < 2; round += 1) {
      const pending = items.filter((it) => !it.verified);
      if (!pending.length) break;
      const heard = [];
      for (const it of pending) heard.push(await transcribe(it.wav).catch(() => ''));
      const p = await jevMatches(pending.map((it, i) => ({ script: it.say, heard: heard[i] })));
      if (!p) break;
      for (let i = 0; i < pending.length; i += 1) {
        const it = pending[i];
        it.match = p[i];
        if (p[i] != null && p[i] >= 0.5) { it.verified = true; continue; }
        console.warn(`  retake ${path.basename(it.file)} (match=${p[i]?.toFixed(2)}): heard "${heard[i]}"`);
        it.take += 1;
        it.wav = (await synth(it.say, { voice: it.voice, style: it.style, cacheDir: CACHE, variant: it.take })).wav;
      }
    }
  }
  for (const it of items) {
    if (verify && it.match != null && !it.verified) console.warn(`  !! UNVERIFIED ${path.basename(it.file)} after ${it.take + 1} takes — reword the line`);
    Object.assign(it, encodeMp3(it.wav, it.file, { rate, kbps }));
  }
}

// ---------- scenarios ----------
async function recordScenario(engine, s) {
  const turns = []; // { role, textTh, say?, verdict, engine }
  const flat = () => turns.map((t) => ({ role: t.role, text: t.textTh }));
  const greet = await engine.personaReply({ turns: [], verdict: null, lang: 'th' });
  turns.push({ role: 'ai', textTh: greet.text, verdict: null, engine: greet.engine });
  console.log(`  ai (greeting): ${greet.text} [${greet.engine}]`);
  let last = null;
  let closed = false;
  for (let i = 0; i < s.turns.length && !closed; i += 1) {
    const c = s.turns[i];
    turns.push({ role: 'caller', textTh: c.th, textEn: c.en, say: c.say, verdict: null });
    const v = await engine.judgeTurn({ turns: flat(), callerText: c.th, lang: 'th', explain: 'always' });
    last = v;
    turns[turns.length - 1].verdict = { verdict: v.verdict, confidence: Math.round(v.confidence * 100) / 100, reasonTh: v.reasonTh, reasonEn: v.reasonEn, engine: v.engine };
    console.log(`  caller ${i + 1}: ${v.verdict} ${v.confidence.toFixed(2)} [${v.engine}${v.escalated ? ' escalated' : ''}] ${v.reasonEn || ''}`);
    // The persona applies the engine's call policy: a closing line ends the call.
    const outOfLines = i === s.turns.length - 1;
    let r = await engine.personaReply({ turns: flat(), verdict: v, lang: 'th' });
    if (!r.closing && outOfLines) r = await engine.personaReply({ turns: flat(), verdict: v, lang: 'th', action: closeAction(v) });
    turns.push({ role: 'ai', textTh: r.text, verdict: null, engine: r.engine });
    closed = Boolean(r.closing);
    console.log(`  ai${closed ? ' (closing)' : ''}: ${r.text} [${r.engine}]`);
  }
  return { turns, final: last };
}

async function main() {
  const only = (opt('--only') || '').split(',').filter(Boolean);
  const verify = !flag('--no-verify');
  if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY missing in app/.env');
  fs.mkdirSync(CACHE, { recursive: true });
  fs.mkdirSync(OUT_AUDIO, { recursive: true });
  fs.mkdirSync(OUT_PHONE, { recursive: true });

  if (!flag('--prompts-only')) {
    const engine = await loadEngine();
    const manifestPath = path.join(OUT_DEMO, 'scenarios.json');
    const prev = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
    const scenarios = [];
    const judgeEngines = new Set();
    const personaEngines = new Set();
    let mismatch = 0;
    for (const s of SCRIPTS) {
      if (only.length && !only.includes(s.id)) {
        const kept = prev?.scenarios?.find((x) => x.id === s.id);
        if (kept) scenarios.push(kept);
        continue;
      }
      console.log(`\n# ${s.id} (expect ${s.expected})`);
      const { turns, final } = await recordScenario(engine, s);
      if (flag('--dry')) { console.log(`  => final ${final.verdict} ${final.confidence} (expect ${s.expected}) · ${turns.length} turns`); continue; }
      const aiIdx = turns.map((t, i) => (t.role === 'ai' ? i : -1)).filter((i) => i >= 0);
      const en = await translate(aiIdx.map((i) => turns[i].textTh));
      aiIdx.forEach((ti, k) => { turns[ti].textEn = en[k]; });
      const alert = await lineAlert(turns, final.verdict);
      for (const f of fs.readdirSync(OUT_AUDIO)) if (f.startsWith(`${s.id}-`)) fs.unlinkSync(path.join(OUT_AUDIO, f));
      const items = turns.map((t, i) => ({
        say: t.say || t.textTh,
        voice: t.role === 'ai' ? AI_VOICE : s.voice,
        style: t.role === 'ai' ? AI_STYLE : s.style,
        file: path.join(OUT_AUDIO, `${s.id}-${String(i).padStart(2, '0')}.mp3`),
      }));
      await voiceAll(items, { verify, rate: 24000, kbps: 40 });
      const totalMs = items.reduce((a, it) => a + it.ms, 0);
      if (final.verdict !== s.expected) { mismatch += 1; console.warn(`  !! final ${final.verdict} != expected ${s.expected}`); }
      console.log(`  ${turns.length} turns · ${(totalMs / 1000).toFixed(1)} s · final ${final.verdict} ${final.confidence.toFixed(2)}`);
      scenarios.push({
        id: s.id, expected: s.expected, titleTh: s.titleTh, titleEn: s.titleEn,
        callerTh: s.callerTh, callerEn: s.callerEn, callerPhone: displayPhone(s.callerPhone), icon: s.icon,
        callerVoice: s.voice, totalMs,
        turns: turns.map((t, i) => ({
          role: t.role, textTh: t.textTh, textEn: t.textEn,
          audio: `/demo/audio/${path.basename(items[i].file)}`, ms: items[i].ms, verdict: t.verdict,
          ...(t.role === 'ai' ? { engine: t.engine } : {}),
        })),
        final: {
          verdict: final.verdict, confidence: Math.round(final.confidence * 100) / 100,
          reasonTh: final.reasonTh, reasonEn: final.reasonEn, ...alert,
        },
      });
    }
    // Engine metadata from every scenario in the file (kept ones included).
    const kept = SCRIPTS.map((s) => scenarios.find((x) => x.id === s.id)).filter(Boolean);
    for (const sc of kept) {
      for (const t of sc.turns) {
        if (t.role === 'caller' && t.verdict) judgeEngines.add(t.verdict.engine);
        if (t.role === 'ai' && t.engine) personaEngines.add(t.engine);
      }
    }
    const manifest = {
      version: 1,
      recordedAt: new Date().toISOString(),
      engine: {
        judge: engine.stub ? 'stub (legacy rules)' : (judgeEngines.has('jev') ? config.jevModel || 'jev-latest' : [...judgeEngines].join('+')),
        judgeEngines: [...judgeEngines].filter(Boolean),
        persona: personaEngines.has('gemini') ? config.geminiModel : 'canned',
        personaEngines: [...personaEngines].filter(Boolean),
        tts: ttsModel(),
      },
      voices: {
        ai: AI_VOICE,
        callerMale: SCRIPTS.find((x) => x.id === 'scam-police').voice,
        callerFemale: SCRIPTS.find((x) => x.id === 'scam-parcel').voice,
        hospital: SCRIPTS.find((x) => x.id === 'legit-hospital').voice,
        survey: SCRIPTS.find((x) => x.id === 'unsure-survey').voice,
      },
      scenarios: kept,
    };
    if (flag('--dry')) return;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const total = fs.readdirSync(OUT_AUDIO).reduce((a, f) => a + fs.statSync(path.join(OUT_AUDIO, f)).size, 0);
    console.log(`\nscenarios.json written · audio ${(total / 1048576).toFixed(2)} MB${total > MAX_TOTAL_BYTES ? ' — OVER 3 MB BUDGET' : ''}`);
    if (mismatch) console.warn(`${mismatch} scenario(s) ended on a different verdict than expected — refine the caller lines, don't fake the verdict.`);
  }

  if (!only.length || flag('--prompts-only')) await renderPhonePrompts(verify);
  fs.rmSync(WORK, { recursive: true, force: true });
}

// Fixed phone lines, 8 kHz mono for Twilio <Play>. voice.js plays a file only
// while its text still equals the line the server would say; otherwise <Say>.
async function renderPhonePrompts(verify) {
  const ai = await import('../src/ai.js');
  const { PHONE_LINES } = await import('../src/twilio/voice.js');
  const lines = {
    record: config.recordNotice,
    greeting: ai.openingLine(),
    gather: PHONE_LINES.gather,
    noSpeech: PHONE_LINES.noSpeech,
    'closing-scam': ai.closingLine('SCAM'),
    'closing-legit': ai.closingLine('LEGIT'),
    'closing-unsure': ai.closingLine('UNSURE'),
  };
  for (const f of fs.readdirSync(OUT_PHONE)) if (f.endsWith('.mp3')) fs.unlinkSync(path.join(OUT_PHONE, f));
  const items = Object.entries(lines).map(([id, text]) => ({ id, text, say: text, voice: AI_VOICE, style: AI_STYLE, file: path.join(OUT_PHONE, `${id}.mp3`) }));
  console.log('\n# phone prompts');
  await voiceAll(items, { verify, rate: 8000, kbps: 32 });
  const prompts = Object.fromEntries(items.map((it) => [it.id, { text: it.text, file: `/voice-audio/${it.id}.mp3`, ms: it.ms }]));
  fs.writeFileSync(path.join(OUT_PHONE, 'prompts.json'), `${JSON.stringify({ version: 1, recordedAt: new Date().toISOString(), tts: ttsModel(), voice: AI_VOICE, prompts }, null, 2)}\n`);
  for (const it of items) console.log(`  ${it.id.padEnd(15)} ${it.ms} ms ${(it.bytes / 1024).toFixed(1)} KB  ${it.text}`);
}

await main();
