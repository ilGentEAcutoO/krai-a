// Local-only live-session recorder (TASK-041). Enabled ONLY by the
// LIVE_RECORD_DIR env var on the developer's machine — never from a URL,
// query or header — and deploy-cloudrun.sh refuses to ship with it set.
// Per session it writes <dir>/<ISO-stamp>-<lang>/:
//   caller.wav   mic PCM exactly as received (16 kHz mono)
//   ai.wav       Gemini audio as sent to the browser (its own rate)
//   events.jsonl {t: ms since session start, type, ...} one per line
// so app/scripts/live-report.mjs / live-analyze.mjs can rebuild the call.
import fs from 'node:fs';
import path from 'node:path';

const MIC_RATE = 16000;
const WINDOW_SAMPLES = MIC_RATE / 10; // RMS per 100 ms

function wavHeader(dataBytes, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(dataBytes, 40);
  return h;
}

// PCM16 WAV written incrementally; the header is patched with the real size on close.
function wavWriter(file, rate) {
  const fd = fs.openSync(file, 'w');
  let bytes = 0;
  fs.writeSync(fd, wavHeader(0, rate));
  return {
    rate,
    write(buf) { fs.writeSync(fd, buf); bytes += buf.length; },
    close() { fs.writeSync(fd, wavHeader(bytes, rate), 0, 44, 0); fs.closeSync(fd); },
  };
}

const stamp = (d) => d.toISOString().replace(/[:.]/g, '-');

export function liveRecordDir(env = process.env) {
  return String(env.LIVE_RECORD_DIR || '').trim();
}

// Returns null when recording is off, so callers do `rec?.event(...)`.
export function createRecorder({ dir, lang, now = Date.now, log = console.log } = {}) {
  if (!dir) return null;
  const t0 = now();
  let folder = path.join(dir, `${stamp(new Date(t0))}-${lang}`);
  for (let i = 2; fs.existsSync(folder); i++) folder = path.join(dir, `${stamp(new Date(t0))}-${lang}-${i}`);
  fs.mkdirSync(folder, { recursive: true });
  const ev = fs.openSync(path.join(folder, 'events.jsonl'), 'w');
  const caller = wavWriter(path.join(folder, 'caller.wav'), MIC_RATE);
  let ai = null;
  let closed = false;
  // RMS window over the caller's mic; tWin = arrival time of the window's first sample.
  let winSum = 0, winPeak = 0, winN = 0, winT = null, winMuted = false;

  const event = (type, data = {}) => {
    if (closed) return;
    fs.writeSync(ev, `${JSON.stringify({ t: now() - t0, type, ...data })}\n`);
  };
  const flushWindow = () => {
    if (!winN) return;
    const rms = Math.sqrt(winSum / winN) / 32768;
    event('mic', { at: winT, ms: Math.round((winN / MIC_RATE) * 1000), rms: +rms.toFixed(5), peak: +(winPeak / 32768).toFixed(4), ...(winMuted ? { muted: true } : {}) });
    winSum = 0; winPeak = 0; winN = 0; winT = null; winMuted = false;
  };

  log(`[live-rec] recording session to ${folder}`);
  return {
    folder,
    event,
    // muted: the server is replacing this audio with silence upstream (greeting/closing).
    caller(buf, { muted = false } = {}) {
      if (closed) return;
      caller.write(buf);
      const t = now() - t0;
      for (let i = 0; i + 1 < buf.length; i += 2) {
        if (winT == null) winT = t;
        const v = buf.readInt16LE(i);
        winSum += v * v;
        if (Math.abs(v) > winPeak) winPeak = Math.abs(v);
        if (muted) winMuted = true;
        if (++winN >= WINDOW_SAMPLES) flushWindow();
      }
    },
    ai(buf, rate) {
      if (closed) return;
      if (!ai) ai = wavWriter(path.join(folder, 'ai.wav'), rate);
      ai.write(buf);
      event('ai-audio', { bytes: buf.length, rate, ms: Math.round((buf.length / 2 / rate) * 1000) });
    },
    close(data = {}) {
      if (closed) return;
      flushWindow();
      event('session-end', data);
      closed = true;
      try { caller.close(); } catch (e) { log('[live-rec] caller.wav close failed:', e.message); }
      try { ai?.close(); } catch (e) { log('[live-rec] ai.wav close failed:', e.message); }
      fs.closeSync(ev);
    },
  };
}
