// Shared reader for recorded live sessions (TASK-041/042): turns a session
// folder written by src/liveRecorder.js into a timeline model and the
// code-side metrics (talk-over, response latency, interruptions, length).
// Used by live-report.mjs (timeline.html) and live-analyze.mjs (analysis.json).
import fs from 'node:fs';
import path from 'node:path';

export const WIN_MS = 100;

export function readEvents(dir) {
  const txt = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
  const out = [];
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn last line from a crash */ }
  }
  return out.sort((a, b) => a.t - b.t); // stable: same-ms events keep their order
}

// PCM16 mono data of a WAV written by the recorder (fixed 44-byte header).
export function readWav(file) {
  if (!fs.existsSync(file)) return null;
  const b = fs.readFileSync(file);
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF') return null;
  const rate = b.readUInt32LE(24);
  let data = b.subarray(44);
  if (data.length % 2) data = data.subarray(0, data.length - 1);
  return { rate, data };
}

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const median = (arr) => (arr.length ? pct(arr, 0.5) : null);

// The browser plays AI chunks gaplessly and flushes its queue on
// `interrupted`, so playback = a queue fed at each chunk's arrival time.
export function aiPlayback(events) {
  const segs = [];
  let head = 0, offset = 0;
  for (const e of events) {
    if (e.type === 'ai-audio') {
      const start = Math.max(e.t, head);
      segs.push({ start, end: start + e.ms, offset, bytes: e.bytes, rate: e.rate, arrived: e.t });
      head = start + e.ms;
      offset += e.bytes;
    } else if (e.type === 'interrupted' || (e.type === 'session-end')) {
      // flush: whatever was still queued after this instant never plays
      for (const s of segs) {
        if (s.start >= e.t) { s.end = s.start; s.cut = true; } else if (s.end > e.t) { s.end = e.t; s.cut = true; }
      }
      head = e.t;
    }
  }
  return segs.filter((s) => s.end > s.start);
}

// RMS per 100 ms of the AI audio at its modelled playback time.
function aiWindows(segs, wav) {
  const out = [];
  if (!wav) return out;
  for (const s of segs) {
    const bytesPerMs = (s.rate * 2) / 1000;
    for (let t = s.start; t < s.end; t += WIN_MS) {
      const a = s.offset + Math.floor((t - s.start) * bytesPerMs / 2) * 2;
      const b = Math.min(s.offset + s.bytes, a + Math.floor(Math.min(WIN_MS, s.end - t) * bytesPerMs / 2) * 2);
      let sum = 0, n = 0;
      for (let i = a; i + 1 < b && i + 1 < wav.data.length; i += 2) { const v = wav.data.readInt16LE(i); sum += v * v; n++; }
      out.push({ t, ms: Math.min(WIN_MS, s.end - t), rms: n ? Math.sqrt(sum / n) / 32768 : 0 });
    }
  }
  return out;
}

const overlapsAny = (t0, t1, segs) => segs.some((s) => s.start < t1 && s.end > t0);

export function loadSession(dir) {
  const events = readEvents(dir);
  const start = events.find((e) => e.type === 'session-start') || {};
  const endEv = events.findLast((e) => e.type === 'session-end');
  const durationMs = endEv?.durationMs ?? endEv?.t ?? events.at(-1)?.t ?? 0;
  const mic = events.filter((e) => e.type === 'mic').map((e) => ({ t: e.at ?? e.t, ms: e.ms || WIN_MS, rms: e.rms, peak: e.peak, muted: !!e.muted }));
  const segs = aiPlayback(events);
  const ai = aiWindows(segs, readWav(path.join(dir, 'ai.wav')));

  // Ambient floor = a quiet-ish percentile of the open mic; "caller sound" is above it.
  const open = mic.filter((w) => !w.muted).map((w) => w.rms);
  const floor = Math.max(0.006, pct(open, 0.2) * 2.5);
  for (const w of mic) w.loud = !w.muted && w.rms > floor;

  // Talk-over: AI audio playing while the open mic is above the floor.
  const overlapWins = mic.filter((w) => w.loud && overlapsAny(w.t, w.t + w.ms, segs));
  const overlaps = [];
  for (const w of overlapWins) {
    const last = overlaps.at(-1);
    if (last && w.t - last.end <= 300) last.end = w.t + w.ms;
    else overlaps.push({ start: w.t, end: w.t + w.ms });
  }
  const talkOver = overlaps.filter((o) => o.end - o.start >= 200);

  // Turns from the server's own finalised transcripts.
  const aiTurns = [];
  const callerTurns = [];
  let aiChunkStart = null, callerChunkStart = null, segIdx = 0;
  const callerChunks = [];
  for (const e of events) {
    if (e.type === 'output-transcription') aiChunkStart ??= e.t;
    if (e.type === 'input-transcription') { callerChunkStart ??= e.t; callerChunks.push({ t: e.t, text: e.text }); }
    if (e.type === 'ai-final') {
      const mine = [];
      while (segIdx < segs.length && segs[segIdx].arrived <= e.t) mine.push(segs[segIdx++]);
      aiTurns.push({
        index: aiTurns.length, t: e.t, text: e.text, firstText: aiChunkStart,
        playStart: mine[0]?.start ?? aiChunkStart ?? e.t, playEnd: mine.at(-1)?.end ?? e.t,
        interrupted: mine.some((s) => s.cut),
      });
      aiChunkStart = null;
    }
    if (e.type === 'caller-final') {
      callerTurns.push({ index: callerTurns.length, t: e.t, text: e.text, firstText: callerChunkStart ?? e.t });
      callerChunkStart = null;
    }
  }

  // Response latency: from the caller's last loud window before an AI turn
  // (and after the previous AI turn) to when that AI turn starts playing.
  const latencies = [];
  for (let i = 1; i < aiTurns.length; i++) {
    const a = aiTurns[i], prevEnd = aiTurns[i - 1].playEnd;
    const lastLoud = mic.filter((w) => w.loud && w.t >= prevEnd && w.t + w.ms <= a.playStart + WIN_MS).at(-1);
    if (lastLoud) latencies.push({ turn: i, ms: Math.max(0, Math.round(a.playStart - (lastLoud.t + lastLoud.ms))) });
  }

  const closingBegin = events.find((e) => e.type === 'closing-begin');
  const controls = events.filter((e) => e.type === 'control');
  return {
    dir, name: path.basename(dir), events, lang: start.lang || '?', start, end: endEv, durationMs,
    mic, ai, segs, floor, talkOver, aiTurns, callerTurns, callerChunks, latencies, controls,
    verdicts: events.filter((e) => e.type === 'verdict'),
    actions: events.filter((e) => e.type === 'action'),
    closingBegin,
  };
}

export function codeMetrics(s) {
  const lat = s.latencies.map((l) => l.ms);
  return {
    durationMs: Math.round(s.durationMs),
    endReason: s.end?.reason ?? 'unknown (no session-end)',
    closingReason: s.closingBegin?.reason ?? null,
    finalVerdict: s.end?.verdict?.verdict ?? s.verdicts.at(-1)?.verdict ?? null,
    talkOverMs: s.talkOver.reduce((n, o) => n + (o.end - o.start), 0),
    talkOverCount: s.talkOver.length,
    responseLatencyMedianMs: median(lat),
    responseLatencyMaxMs: lat.length ? Math.max(...lat) : null,
    interruptedCount: s.events.filter((e) => e.type === 'interrupted').length,
    aiTurns: s.aiTurns.length,
    callerTurns: s.callerTurns.length,
    controlCount: s.controls.length,
    noiseFloorRms: +s.floor.toFixed(4),
  };
}

export function listSessions(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'events.jsonl')))
    .map((d) => path.join(root, d.name))
    .sort();
}

// `<sessionDir>` or `--all <dir>` → list of session folders.
export function sessionArgs(argv) {
  const i = argv.indexOf('--all');
  if (i >= 0) {
    const root = argv[i + 1];
    if (!root) throw new Error('usage: --all <dir>');
    return { root: path.resolve(root), dirs: listSessions(path.resolve(root)) };
  }
  const dir = argv.find((a) => !a.startsWith('--'));
  if (!dir) throw new Error('usage: <sessionDir> | --all <dir>');
  return { root: path.dirname(path.resolve(dir)), dirs: [path.resolve(dir)] };
}
