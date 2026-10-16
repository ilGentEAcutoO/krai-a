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
// Every call is recorded twice, in Thai and in English (a separate real run
// per language: `scenarios` + `scenariosEn`). Jev reads every AI line for
// persona rules (sounds like a person answering a phone, never names itself,
// never claims a line problem, never re-asks what the caller already said);
// a run that breaks one is recorded again (--takes N, default 3) — the lines
// are never edited by hand.
// Clip ends: Gemini WAV carries a trailing 'C2PA' metadata chunk that used to
// play as a ~130 ms burst. src/audioTail.js strips it, cuts at the
// last silence and fades out; every mp3's last 150 ms must stay < -30 dBFS.
//
// Run from app/:  node scripts/render-demo.mjs [--only id,id] [--lang th,en] [--takes N] [--dry] [--stub] [--no-verify] [--prompts-only]
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
const { synth, ttsModel, pcmToWav, SAMPLE_RATE, AI_VOICE, AI_STYLE } = await import('../src/tts.js');
const { cleanTts, tailPeakDb } = await import('../src/audioTail.js');
const { SCRIPTS, scriptFor, displayPhone } = await import('../src/demoScripts.js');

const OUT_DEMO = path.join(APP, 'public', 'demo');
const OUT_AUDIO = path.join(OUT_DEMO, 'audio');
const OUT_PHONE = path.join(APP, 'public', 'voice-audio');
const CACHE = path.resolve(APP, '..', 'agent-temp', 'tts-cache');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'krai-render-'));
const TEXT_MODEL = process.env.RENDER_TEXT_MODEL || 'gemini-3.8-flash';
const API = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const TAIL_MAX_DB = -30; // last 150 ms of every clip
const AI_STYLE_EN = 'calm, warm female receptionist answering a phone, unhurried, clear natural English';
const LANGS = (opt('--lang') || 'th,en').split(',').filter((l) => l === 'th' || l === 'en');
const TAKES = Math.max(1, Number(opt('--takes')) || 3);

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

async function translate(lines, to = 'en', who = 'ai') {
  if (!lines.length) return [];
  const ask = to === 'en'
    ? 'Translate each Thai phone-call line into natural, concise English for on-screen subtitles. Keep names, numbers and politeness; no notes.'
    : who === 'caller'
      ? "Translate each English phone-call line (said by the caller) into natural spoken Thai for on-screen subtitles, keeping the caller's tone. Keep names, numbers and currencies as they are; no notes."
      : 'Translate each English phone-call line into natural spoken Thai for on-screen subtitles, as a polite woman (ค่ะ/คะ). Keep names and numbers; no notes.';
  const out = await geminiJson(`${ask}\n${JSON.stringify(lines)}`, { type: 'ARRAY', items: { type: 'STRING' } });
  if (!Array.isArray(out) || out.length !== lines.length) throw new Error('translation count mismatch');
  return out;
}

// The LINE card body (demo-stage draws the title): ONE sentence that leads
// with what Krai-a did, then the gist of the call.
const LEAD = {
  SCAM: ['ตัดสายแล้ว — ', 'Hung up — '],
  LEGIT: ['ฝากข้อความแล้ว — ', 'Message taken — '],
  UNSURE: ['รอคุณตัดสิน — ', 'Your call — '],
};
async function lineAlert(turns, verdict, lang = 'th') {
  const transcript = turns.map((t) => `${t.role === 'caller' ? 'Caller' : 'AI receptionist'}: ${lang === 'en' ? t.textEn : t.textTh}`).join('\n');
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
// Decoded tail check on the finished mp3 (what visitors actually hear).
function mp3TailDb(file, ms = 150) {
  const pcm = execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', '24000', '-'], { maxBuffer: 64 * 1024 * 1024 });
  return tailPeakDb(pcm, 24000, ms);
}

function encodeMp3(pcm, outFile, { rate = 24000, kbps = 40 } = {}) {
  const tmp = path.join(WORK, `${path.basename(outFile)}.wav`);
  // Strip the trailing metadata chunk, end on the last silence + a faded
  // breath (src/audioTail.js); ffmpeg only trims the lead and sets loudness.
  fs.writeFileSync(tmp, pcmToWav(cleanTts(pcm, { rate: SAMPLE_RATE }), SAMPLE_RATE));
  const af = [
    'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.08',
    'loudnorm=I=-16:TP=-1.5:LRA=11',
  ].join(',');
  run(ffmpeg, ['-y', '-loglevel', 'error', '-i', tmp, '-af', af, '-ac', '1', '-ar', String(rate), '-c:a', 'libmp3lame', '-b:a', `${kbps}k`, outFile]);
  const ms = Math.round(Number(run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', outFile]).trim()) * 1000);
  const tail = mp3TailDb(outFile);
  if (tail >= TAIL_MAX_DB) throw new Error(`${path.basename(outFile)}: tail peak ${tail.toFixed(1)} dBFS (must be < ${TAIL_MAX_DB})`);
  return { ms, bytes: fs.statSync(outFile).size, tailDb: Math.round(tail * 10) / 10 };
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
async function jevMatches(pairs, lang = 'th') {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key || !pairs.length) return null;
  const questions = {};
  pairs.forEach((p, i) => {
    questions[`clip_${i}`] = {
      type: 'noul',
      instructions: `Does \`clips[${i}].heard\` (a speech-to-text transcript of a synthetic voice clip) say the same ${lang === 'en' ? 'English' : 'Thai'} words as \`clips[${i}].script\`? Ignore punctuation, spacing, how digits or abbreviations are written, and polite particles spelled differently.`,
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

// Gemini TTS answers 429 when the per-minute quota is spent: wait and retry
// (30 s, 60 s, ... up to ~7.5 min in all) instead of losing the run.
async function synthRetry(text, opts) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await synth(text, opts);
    } catch (e) {
      if (!/429/.test(e.message) || attempt >= 5) throw e;
      const ms = 30000 * attempt;
      console.warn(`  tts 429 — waiting ${ms / 1000} s (try ${attempt + 1}/5)`);
      await new Promise((r) => setTimeout(r, ms));
    }
  }
}

async function voiceAll(items, { verify, rate, kbps, lang = 'th' }) {
  // items: [{ say, voice, style, file }] -> adds { ms, bytes, pcm, take }
  const take = async (it) => {
    it.pcm = (await synthRetry(it.say, { voice: it.voice, style: it.style, cacheDir: CACHE, variant: it.take })).pcm;
    it.wav = pcmToWav(cleanTts(it.pcm, { rate: SAMPLE_RATE }), SAMPLE_RATE); // the transcriber hears what ships
  };
  for (const it of items) {
    it.take = 0;
    await take(it);
  }
  if (verify) {
    for (let round = 0; round < 2; round += 1) {
      const pending = items.filter((it) => !it.verified);
      if (!pending.length) break;
      const heard = [];
      for (const it of pending) heard.push(await transcribe(it.wav).catch(() => ''));
      const p = await jevMatches(pending.map((it, i) => ({ script: it.say, heard: heard[i] })), lang);
      if (!p) break;
      for (let i = 0; i < pending.length; i += 1) {
        const it = pending[i];
        it.match = p[i];
        if (p[i] != null && p[i] >= 0.5) { it.verified = true; continue; }
        console.warn(`  retake ${path.basename(it.file)} (match=${p[i]?.toFixed(2)}): heard "${heard[i]}"`);
        it.take += 1;
        await take(it);
      }
    }
  }
  for (const it of items) {
    if (verify && it.match != null && !it.verified) console.warn(`  !! UNVERIFIED ${path.basename(it.file)} after ${it.take + 1} takes — reword the line`);
    Object.assign(it, encodeMp3(it.pcm, it.file, { rate, kbps }));
  }
}

// ---------- scenarios ----------
// One real run of the engine in one language. Caller lines come from the
// script; every judge verdict and every AI line is the engine's own.
async function recordScenario(engine, base, lang = 'th') {
  const en = lang === 'en';
  const s = scriptFor(base, lang);
  const turns = []; // { role, textTh, textEn, say?, verdict, engine }
  const spoken = (t) => (en ? t.textEn : t.textTh);
  const flat = () => turns.map((t) => ({ role: t.role, text: spoken(t) }));
  const aiTurn = (text, eng) => (en ? { role: 'ai', textEn: text, verdict: null, engine: eng } : { role: 'ai', textTh: text, verdict: null, engine: eng });
  const greet = await engine.personaReply({ turns: [], verdict: null, lang });
  turns.push(aiTurn(greet.text, greet.engine));
  console.log(`  ai (greeting): ${greet.text} [${greet.engine}]`);
  let last = null;
  let closed = false;
  for (let i = 0; i < s.turns.length && !closed; i += 1) {
    const c = s.turns[i];
    turns.push({ role: 'caller', textTh: c.th, textEn: c.en, say: en ? c.sayEn : c.say, verdict: null });
    const v = await engine.judgeTurn({ turns: flat(), callerText: en ? c.en : c.th, lang, explain: 'always' });
    last = v;
    turns[turns.length - 1].verdict = { verdict: v.verdict, confidence: Math.round(v.confidence * 100) / 100, reasonTh: v.reasonTh, reasonEn: v.reasonEn, engine: v.engine };
    console.log(`  caller ${i + 1}: ${v.verdict} ${v.confidence.toFixed(2)} [${v.engine}${v.escalated ? ' escalated' : ''}] ${v.reasonEn || ''}`);
    // The persona applies the engine's call policy: a closing line ends the call.
    const outOfLines = i === s.turns.length - 1;
    let r = await engine.personaReply({ turns: flat(), verdict: v, lang });
    if (!r.closing && outOfLines) r = await engine.personaReply({ turns: flat(), verdict: v, lang, action: closeAction(v) });
    turns.push(aiTurn(r.text, r.engine));
    closed = Boolean(r.closing);
    console.log(`  ai${closed ? ' (closing)' : ''}: ${r.text} [${r.engine}]`);
  }
  return { turns, final: last };
}

// Jev reads every AI line of a recorded call against the persona rules.
// Returns one { ok, scores } per AI line (null when Jev can't answer).
const PERSONA_RULES = {
  natural: ['Does `lines[%i]` sound like something a calm, polite person would naturally say out loud when answering a phone for someone else — plain, warm, conversational (not stiff, robotic, bureaucratic or awkwardly translated)?',
    'Sounds natural and human on a phone call.', 'Sounds stiff, robotic, bureaucratic, odd or awkwardly worded.'],
  namesSelf: ['Does `lines[%i]` give the receptionist a personal name (e.g. "ดิฉันชื่อ…", "This is Mary")? Generic words such as "ผู้ช่วย", "assistant" or "receptionist" are not names.',
    'The line names the receptionist.', 'The line does not name the receptionist.'],
  lineProblem: ['Does `lines[%i]` claim a technical problem or describe call conditions (bad signal, cannot hear, line breaking up, hold, transfer, system error)?',
    'The line claims a line, technical or system problem.', 'No claim about the line or system.'],
  reasks: ['Looking at `transcript`, does `lines[%i]` ask the caller again for something the caller had ALREADY clearly given before that line (e.g. asking for a name the caller already said)?',
    'It asks again for information the caller already gave.', 'It only asks for what is still missing, or asks nothing.'],
};
async function personaCheck(turns, lang) {
  const key = process.env.TYPESAFE_API_KEY;
  const ai = turns.map((t, i) => ({ t, i })).filter((x) => x.t.role === 'ai');
  if (!key || !ai.length) return null;
  const say = (t) => (lang === 'en' ? t.textEn : t.textTh);
  const lines = ai.map((x) => say(x.t));
  const transcript = ai.map((x) => turns.slice(0, x.i).map((t) => `${t.role === 'caller' ? 'Caller' : 'Receptionist'}: ${say(t)}`).join('\n'));
  const questions = {};
  ai.forEach((_, k) => {
    for (const [name, [q, yes, no]] of Object.entries(PERSONA_RULES)) {
      questions[`${name}_${k}`] = {
        type: 'noul',
        instructions: q.replaceAll('%i', String(k)).replace('`transcript`', `\`transcript[${k}]\` (the call before this line)`),
        criteria: { true: yes, false: no },
      };
    }
  });
  try {
    const res = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.JEV_MODEL || 'jev-latest', state: { lang, lines, transcript }, questions }),
    });
    if (!res.ok) { console.warn(`  persona check skipped (jev ${res.status})`); return null; }
    const j = await res.json();
    return ai.map((_, k) => {
      const p = (n) => j.answers?.[`${n}_${k}`]?.noul ?? null;
      const scores = { natural: p('natural'), namesSelf: p('namesSelf'), lineProblem: p('lineProblem'), reasks: p('reasks') };
      const ok = (scores.natural ?? 1) >= 0.5 && (scores.namesSelf ?? 0) < 0.5 && (scores.lineProblem ?? 0) < 0.5 && (scores.reasks ?? 0) < 0.5;
      return { ok, scores, line: lines[k] };
    });
  } catch (e) {
    console.warn(`  persona check skipped (${e.message})`);
    return null;
  }
}

// Up to TAKES real runs; keep the first whose verdict matches and whose AI
// lines all pass, else the best one (verdict match first, then fewest flags).
async function bestRun(engine, s, lang) {
  let best = null;
  for (let k = 0; k < TAKES; k += 1) {
    if (k) console.log(`  -- take ${k + 1}`);
    const rec = await recordScenario(engine, s, lang);
    const checks = await personaCheck(rec.turns, lang);
    const flagged = (checks || []).filter((c) => !c.ok);
    for (const c of flagged) console.warn(`  persona flag: ${JSON.stringify(c.scores)} "${c.line}"`);
    const score = (rec.final?.verdict === s.expected ? 0 : 100) + flagged.length;
    if (!best || score < best.score) best = { ...rec, score, flagged: flagged.length };
    if (score === 0) break;
  }
  if (best.flagged) console.warn(`  !! ${best.flagged} AI line(s) still flagged after ${TAKES} takes — tune the persona prompt, not the line`);
  return best;
}

// Thai keeps the original file names; English clips get an -en- infix.
const clipName = (id, lang, i) => `${id}-${lang === 'en' ? 'en-' : ''}${String(i).padStart(2, '0')}.mp3`;
const isClipOf = (f, id, lang) => (lang === 'en' ? new RegExp(`^${id}-en-\\d\\d\\.mp3$`) : new RegExp(`^${id}-\\d\\d\\.mp3$`)).test(f);

async function renderScenario(engine, base, lang, verify) {
  const en = lang === 'en';
  const s = scriptFor(base, lang);
  console.log(`\n# ${s.id} [${lang}]${s.ownEn ? ' (own EN case)' : ''} (expect ${s.expected})`);
  const { turns, final } = await bestRun(engine, base, lang);
  if (flag('--dry')) { console.log(`  => final ${final.verdict} ${final.confidence} (expect ${s.expected}) · ${turns.length} turns`); return null; }
  // Subtitles in the other language for the AI lines (caller lines are scripted in both).
  const aiIdx = turns.map((t, i) => (t.role === 'ai' ? i : -1)).filter((i) => i >= 0);
  const other = await translate(aiIdx.map((i) => (en ? turns[i].textEn : turns[i].textTh)), en ? 'th' : 'en');
  aiIdx.forEach((ti, k) => { turns[ti][en ? 'textTh' : 'textEn'] = other[k]; });
  // An own-EN case has no scripted Thai caller lines: Thai subtitles for those too.
  const callerIdx = turns.map((t, i) => (t.role === 'caller' && !t.textTh ? i : -1)).filter((i) => i >= 0);
  const callerTh = await translate(callerIdx.map((i) => turns[i].textEn), 'th', 'caller');
  callerIdx.forEach((ti, k) => { turns[ti].textTh = callerTh[k]; });
  const alert = await lineAlert(turns, final.verdict, lang);
  // Voice into the work dir; the shipped clips are swapped only once every
  // clip of the call is done, so a failed run never leaves a call half-voiced.
  const items = turns.map((t, i) => ({
    say: t.say || (en ? t.textEn : t.textTh),
    voice: t.role === 'ai' ? AI_VOICE : s.voice,
    style: t.role === 'ai' ? (en ? AI_STYLE_EN : AI_STYLE) : (en ? s.styleEn || `${s.style}; speaking English with a light Thai accent` : s.style),
    file: path.join(WORK, clipName(s.id, lang, i)),
  }));
  await voiceAll(items, { verify, rate: 24000, kbps: 40, lang });
  for (const f of fs.readdirSync(OUT_AUDIO)) if (isClipOf(f, s.id, lang)) fs.unlinkSync(path.join(OUT_AUDIO, f));
  for (const it of items) {
    const out = path.join(OUT_AUDIO, path.basename(it.file));
    fs.copyFileSync(it.file, out);
    it.file = out;
  }
  const totalMs = items.reduce((a, it) => a + it.ms, 0);
  console.log(`  ${turns.length} turns · ${(totalMs / 1000).toFixed(1)} s · final ${final.verdict} ${final.confidence.toFixed(2)} · tails ${items.map((it) => it.tailDb).join(' ')} dBFS`);
  return {
    id: s.id, expected: s.expected, lang, titleTh: s.titleTh, titleEn: s.titleEn, ...(s.ownEn ? { ownEn: true } : {}),
    callerTh: s.callerTh, callerEn: s.callerEn, callerPhone: s.phoneDisplay || displayPhone(s.callerPhone), icon: s.icon,
    callerVoice: s.voice, tts: ttsModel(), totalMs,
    turns: turns.map((t, i) => ({
      role: t.role, textTh: t.textTh, textEn: t.textEn,
      audio: `/demo/audio/${path.basename(items[i].file)}`, ms: items[i].ms, verdict: t.verdict,
      ...(t.role === 'ai' ? { engine: t.engine } : {}),
    })),
    final: {
      verdict: final.verdict, confidence: Math.round(final.confidence * 100) / 100,
      reasonTh: final.reasonTh, reasonEn: final.reasonEn, ...alert,
    },
  };
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
    const out = { th: [], en: [] };
    const prevOf = { th: prev?.scenarios || [], en: prev?.scenariosEn || [] };
    const judgeEngines = new Set();
    const personaEngines = new Set();
    let mismatch = 0;
    for (const lang of ['th', 'en']) {
      for (const s of SCRIPTS) {
        if ((only.length && !only.includes(s.id)) || !LANGS.includes(lang)) {
          const kept = prevOf[lang].find((x) => x.id === s.id);
          if (kept) out[lang].push(kept);
          continue;
        }
        const sc = await renderScenario(engine, s, lang, verify);
        if (!sc) continue;
        if (sc.final.verdict !== s.expected) { mismatch += 1; console.warn(`  !! final ${sc.final.verdict} != expected ${s.expected}`); }
        out[lang].push(sc);
      }
    }
    // Engine metadata from every scenario in the file (kept ones included).
    const order = (list) => SCRIPTS.map((s) => list.find((x) => x.id === s.id)).filter(Boolean);
    const kept = order(out.th);
    const keptEn = order(out.en);
    for (const sc of [...kept, ...keptEn]) {
      for (const t of sc.turns) {
        if (t.role === 'caller' && t.verdict) judgeEngines.add(t.verdict.engine);
        if (t.role === 'ai' && t.engine) personaEngines.add(t.engine);
      }
    }
    const manifest = {
      version: 2,
      recordedAt: new Date().toISOString(),
      engine: {
        judge: engine.stub ? 'stub (legacy rules)' : (judgeEngines.has('jev') ? config.jevModel || 'jev-latest' : [...judgeEngines].join('+')),
        judgeEngines: [...judgeEngines].filter(Boolean),
        persona: personaEngines.has('gemini') ? config.geminiModel : 'canned',
        personaEngines: [...personaEngines].filter(Boolean),
        // Per language: an --lang en run (e.g. on another TTS model when the
        // daily quota is spent) must not relabel the Thai set.
        tts: LANGS.includes('th') ? ttsModel() : prev?.engine?.tts || ttsModel(),
        ttsEn: LANGS.includes('en') ? ttsModel() : prev?.engine?.ttsEn || prev?.engine?.tts || ttsModel(),
      },
      voices: {
        ai: AI_VOICE,
        callerMale: SCRIPTS.find((x) => x.id === 'scam-police').voice,
        callerFemale: SCRIPTS.find((x) => x.id === 'scam-parcel').voice,
        hospital: SCRIPTS.find((x) => x.id === 'legit-hospital').voice,
        survey: SCRIPTS.find((x) => x.id === 'unsure-survey').voice,
      },
      scenarios: kept,
      scenariosEn: keptEn,
    };
    if (flag('--dry')) return;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const total = fs.readdirSync(OUT_AUDIO).reduce((a, f) => a + fs.statSync(path.join(OUT_AUDIO, f)).size, 0);
    console.log(`\nscenarios.json written · audio ${(total / 1048576).toFixed(2)} MB${total > MAX_TOTAL_BYTES ? ' — OVER BUDGET' : ''}`);
    if (mismatch) console.warn(`${mismatch} scenario(s) ended on a different verdict than expected — refine the caller lines, don't fake the verdict.`);
  }

  // The phone prompts are Thai: only a full run (no --only / --lang) or --prompts-only redoes them.
  if ((!only.length && !opt('--lang')) || flag('--prompts-only')) await renderPhonePrompts(verify);
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
