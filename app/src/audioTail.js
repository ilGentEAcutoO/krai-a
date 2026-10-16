// Clean ends for Gemini TTS clips (pure, no I/O — test/demo-audio.test.js).
// Used by src/tts.js (live + phone audio) and scripts/render-demo.mjs.
//
// The "crackle" after every demo line was not speech: Gemini returns WAV
// with a trailing RIFF chunk ('C2PA', ~6 KB of content-credential metadata)
// after the audio data. Reading everything past the 44-byte header as PCM
// plays that metadata as ~130 ms of full-scale noise. So:
//   1. stripTrailingChunks — drop RIFF chunks glued after the samples;
//   2. trimTail — safety net: cut at the last silence, keep a little air,
//      pad to a fixed tail of silence and fade out, so no clip ever ends on
//      a burst even if the API changes shape again;
//   3. tailPeakDb — the check render-demo asserts (< -30 dBFS) on every clip.
// PCM is signed 16-bit little-endian mono (Buffer or Uint8Array).

// Chunk ids we accept as metadata: known RIFF ones, or 4 upper-case
// letters/digits ('C2PA'). Strict on purpose: bare PCM must never be
// mistaken for a chunk (that would cut real speech).
const KNOWN = new Set(['LIST', 'JUNK', 'id3 ', 'ID3 ', 'bext', 'iXML', 'fact', 'cue ', 'smpl', 'PEAK']);
const isId = (b, p) => {
  const id = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
  return KNOWN.has(id) || /^[A-Z][A-Z0-9]{3}$/.test(id);
};

// Removes RIFF chunks appended after the samples: a 4-char ASCII id + a
// uint32 size that runs exactly to the end of the buffer (word-pad allowed).
// Repeats for several glued chunks. Returns a view, never copies.
export function stripTrailingChunks(pcm, { maxScan = 64 * 1024 } = {}) {
  let buf = pcm;
  for (let round = 0; round < 4; round += 1) {
    const n = buf.length;
    let cut = -1;
    for (let p = Math.max(0, n - maxScan); p <= n - 8; p += 1) {
      if (!isId(buf, p)) continue;
      const size = (buf[p + 4] | (buf[p + 5] << 8) | (buf[p + 6] << 16) | (buf[p + 7] << 24)) >>> 0;
      const rest = n - p - 8;
      if (size === rest || size + 1 === rest) { cut = p; break; }
    }
    if (cut < 0) break;
    buf = buf.subarray(0, cut - (cut % 2)); // stay on a sample boundary
  }
  return buf;
}

const sampleAt = (b, i) => {
  const v = b[2 * i] | (b[2 * i + 1] << 8);
  return v >= 0x8000 ? v - 0x10000 : v;
};
const toDb = (peak) => (peak <= 0 ? -Infinity : 20 * Math.log10(peak / 32768));

// Peak of the last `ms` milliseconds, in dBFS.
export function tailPeakDb(pcm, rate = 24000, ms = 150) {
  const n = Math.floor(pcm.length / 2);
  const from = Math.max(0, n - Math.round((rate * ms) / 1000));
  let peak = 0;
  for (let i = from; i < n; i += 1) peak = Math.max(peak, Math.abs(sampleAt(pcm, i)));
  return toDb(peak);
}

// Cut at the start of the last silence (≥ minSilenceMs below thresholdDb)
// when what follows it is short (≤ maxTailMs: a burst, a click, a breath),
// keep `keepMs` of that silence and fade it out, then pad with digital
// silence to `airMs` of quiet in total. Returns a new Buffer.
export function trimTail(pcm, {
  rate = 24000, thresholdDb = -45, minSilenceMs = 50, maxTailMs = 400, keepMs = 60, airMs = 200, fadeMs = 60, windowMs = 10,
} = {}) {
  const n = Math.floor(pcm.length / 2);
  const win = Math.max(1, Math.round((rate * windowMs) / 1000));
  const nWin = Math.floor(n / win);
  const quiet = [];
  for (let w = 0; w < nWin; w += 1) {
    let peak = 0;
    for (let i = w * win; i < (w + 1) * win; i += 1) peak = Math.max(peak, Math.abs(sampleAt(pcm, i)));
    quiet.push(toDb(peak) < thresholdDb);
  }
  const minRun = Math.ceil(minSilenceMs / windowMs);
  const maxTail = Math.ceil(maxTailMs / windowMs);
  let end = n; // samples kept
  // Walk back over a short loud tail to the silence before it.
  let w = nWin - 1;
  while (w >= 0 && quiet[w]) w -= 1;            // trailing silence (fine as is)
  const tailEnd = w;
  while (w >= 0 && !quiet[w]) w -= 1;           // the loud bit at the end
  const loudLen = tailEnd - w;
  let run = 0;
  let s = w;
  while (s >= 0 && quiet[s]) { run += 1; s -= 1; }
  if (tailEnd >= 0 && loudLen > 0 && loudLen <= maxTail && run >= minRun && s >= 0) {
    end = Math.min(n, (s + 1) * win + Math.round((rate * keepMs) / 1000)); // keep a little of the silence
  } else if (tailEnd >= 0) {
    end = Math.min(n, (tailEnd + 1) * win + Math.round((rate * keepMs) / 1000)); // normal end: speech, then air
  }
  // Fade the kept end (it is the quiet `keepMs` already), then pad with
  // digital silence so every clip ends on the same short breath.
  const pad = Math.max(0, Math.round((rate * (airMs - keepMs)) / 1000));
  const out = Buffer.alloc((end + pad) * 2);
  Buffer.from(pcm.buffer, pcm.byteOffset, end * 2).copy(out);
  const fade = Math.min(end, Math.round((rate * fadeMs) / 1000));
  for (let i = end - fade; i < end; i += 1) {
    const g = (end - i) / fade;
    out.writeInt16LE(Math.round(out.readInt16LE(2 * i) * g * g), 2 * i);
  }
  return out;
}

// Both steps, as render-demo uses them.
export function cleanTts(pcm, opts) {
  return trimTail(stripTrailingChunks(pcm), opts);
}
