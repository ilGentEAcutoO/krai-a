// Demo audio ends cleanly. Gemini TTS WAV carries a trailing RIFF 'C2PA'
// metadata chunk; read as samples it played as ~130 ms of full-scale noise
// after every line. src/audioTail.js strips it and fades the end;
// the shipped mp3s are checked here too (decoded with ffmpeg when present).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { stripTrailingChunks, trimTail, cleanTts, tailPeakDb } from '../src/audioTail.js';
import { synth, stripRiff, pcmToWav, wavHeader, cacheKey, ttsModel, AI_VOICE, AI_STYLE } from '../src/tts.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RATE = 24000;

// 16-bit mono PCM: [ms, kind] segments — 'tone' (speech stand-in), 'quiet', 'burst' (full scale).
function pcm(parts) {
  const out = [];
  for (const [ms, kind] of parts) {
    const n = Math.round((RATE * ms) / 1000);
    for (let i = 0; i < n; i += 1) {
      if (kind === 'tone') out.push(Math.round(12000 * Math.sin((2 * Math.PI * 220 * i) / RATE)));
      else if (kind === 'burst') out.push(i % 2 ? 32767 : -32768);
      else out.push(Math.round((Math.random() - 0.5) * 20)); // room noise, ~ -70 dBFS
    }
  }
  const b = Buffer.alloc(out.length * 2);
  out.forEach((v, i) => b.writeInt16LE(v, 2 * i));
  return b;
}

function chunk(id, bytes) {
  const h = Buffer.alloc(8);
  h.write(id, 0, 'ascii');
  h.writeUInt32LE(bytes.length, 4);
  return Buffer.concat([h, bytes]);
}

const c2pa = () => chunk('C2PA', Buffer.concat([Buffer.from('jumb\0\0\0)jumdc2pa'), Buffer.alloc(6000, 0xa7)]));
const ms = (b) => (b.length / 2 / RATE) * 1000;

describe('stripTrailingChunks', () => {
  it('drops the C2PA metadata chunk glued after the samples', () => {
    const voice = pcm([[600, 'tone'], [200, 'quiet']]);
    const raw = Buffer.concat([voice, c2pa()]);
    assert.ok(tailPeakDb(raw) > -3, 'the metadata reads as a full-scale burst');
    const out = stripTrailingChunks(raw);
    assert.equal(out.length, voice.length);
    assert.ok(tailPeakDb(out) < -50);
  });

  it('drops several glued chunks and keeps a sample boundary', () => {
    const voice = pcm([[300, 'tone'], [100, 'quiet']]);
    const raw = Buffer.concat([voice, chunk('LIST', Buffer.alloc(33, 1)), Buffer.alloc(1), c2pa()]);
    const out = stripTrailingChunks(raw);
    assert.equal(out.length, voice.length);
    assert.equal(out.length % 2, 0);
  });

  it('leaves clean PCM untouched', () => {
    const voice = pcm([[500, 'tone'], [100, 'quiet']]);
    assert.equal(stripTrailingChunks(voice).length, voice.length);
  });
});

describe('trimTail', () => {
  it('cuts a burst that follows the last silence and ends on faded air', () => {
    const raw = pcm([[800, 'tone'], [100, 'quiet'], [130, 'burst']]);
    const out = trimTail(raw, { rate: RATE });
    assert.ok(tailPeakDb(out, RATE, 150) < -30, `tail ${tailPeakDb(out, RATE, 150)}`);
    assert.ok(ms(out) < ms(raw), 'burst removed');
    assert.ok(ms(out) >= 800 + 100, 'speech and a short breath stay');
  });

  it('keeps speech that ends without a burst, with a quiet faded tail', () => {
    const raw = pcm([[900, 'tone'], [300, 'quiet']]);
    const out = trimTail(raw, { rate: RATE });
    assert.ok(tailPeakDb(out, RATE, 150) < -30);
    assert.ok(ms(out) >= 900 && ms(out) <= 900 + 260, `ends ~200 ms after speech (got ${ms(out) - 900} ms)`);
  });

  it('never cuts a long loud ending (real speech, not a burst)', () => {
    const raw = pcm([[400, 'tone'], [100, 'quiet'], [900, 'tone']]);
    const out = trimTail(raw, { rate: RATE });
    assert.ok(ms(out) >= 1400, 'the last sentence is kept');
  });

  it('cleanTts = strip + trim: the real Gemini shape comes out silent at the end', () => {
    const raw = Buffer.concat([pcm([[700, 'tone'], [100, 'quiet']]), c2pa()]);
    const out = cleanTts(raw, { rate: RATE });
    assert.ok(tailPeakDb(out, RATE, 150) < -30);
    assert.ok(ms(out) >= 700);
  });
});

describe('tts.js keeps only the audio (live + phone path)', () => {
  const voice = () => pcm([[300, 'tone'], [200, 'quiet']]);

  it('stripRiff returns only the data chunk of a WAV with a trailing C2PA chunk', () => {
    const v = voice();
    const wav = Buffer.concat([pcmToWav(v), c2pa()]);
    const out = stripRiff(wav);
    assert.equal(out.length, v.length);
    assert.ok(tailPeakDb(out) < -50);
  });

  it('stripRiff skips chunks before data and handles a streamed (unknown size) header', () => {
    const v = voice();
    const fmtThenList = pcmToWav(v);
    const withList = Buffer.concat([fmtThenList.subarray(0, 36), chunk('LIST', Buffer.alloc(26, 2)), fmtThenList.subarray(36)]);
    assert.equal(stripRiff(withList).length, v.length);
    assert.equal(stripRiff(Buffer.concat([wavHeader(), v])).length, v.length);
  });

  it('synth drops the C2PA chunk from a fresh take and from an old cache file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-c2pa-'));
    const v = voice();
    const wavB64 = Buffer.concat([pcmToWav(v), c2pa()]).toString('base64');
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: wavB64 }] }] }) });
    const a = await synth('สวัสดีค่ะ', { cacheDir: dir, fetchImpl, apiKey: 'k' });
    assert.equal(a.pcm.length, v.length);
    // A cache file written before the fix still carries the chunk.
    const key = cacheKey({ model: ttsModel(), voice: AI_VOICE, style: AI_STYLE, text: 'ค่ะ' });
    fs.writeFileSync(path.join(dir, `${key}.pcm`), Buffer.concat([v, c2pa()]));
    const b = await synth('ค่ะ', { cacheDir: dir, fetchImpl, apiKey: 'k' });
    assert.equal(b.cached, true);
    assert.equal(b.pcm.length, v.length);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('bare PCM is never mistaken for a chunk', () => {
    for (let k = 0; k < 20; k += 1) {
      const noise = Buffer.alloc(48000);
      for (let i = 0; i < noise.length; i += 1) noise[i] = Math.floor(Math.random() * 256);
      assert.equal(stripTrailingChunks(noise).length, noise.length);
    }
  });
});

// ---- the shipped files ----
const manifestPath = path.join(APP, 'public', 'demo', 'scenarios.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const allScenarios = [...(manifest.scenarios || []), ...(manifest.scenariosEn || [])];
const hasFfmpeg = (() => {
  try { execFileSync(process.env.FFMPEG || 'ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

describe('shipped demo audio', () => {
  it('every scenario exists in Thai and English with the same cases', () => {
    const ids = (list) => (list || []).map((s) => s.id).sort();
    assert.equal(manifest.scenarios.length, 5);
    assert.deepEqual(ids(manifest.scenariosEn), ids(manifest.scenarios));
    for (const s of manifest.scenariosEn) {
      assert.ok(s.turns.every((t) => t.textEn && t.audio.includes(`${s.id}-en-`)), `${s.id}: English lines + English clips`);
    }
  });

  it('every clip in the manifest is on disk', () => {
    for (const s of allScenarios) {
      for (const t of s.turns) assert.ok(fs.existsSync(path.join(APP, 'public', t.audio)), t.audio);
    }
  });

  it('no AI line names itself or claims a line problem', () => {
    const bad = /(ดิฉันชื่อ|ฉันชื่อ|my name is|สัญญาณ|ไม่ได้ยิน|สายหลุด|bad signal|can't hear|cannot hear|line is breaking)/i;
    for (const s of allScenarios) {
      for (const t of s.turns) if (t.role === 'ai') assert.doesNotMatch(t.textEn || '', bad, `${s.id}: ${t.textEn}`);
      for (const t of s.turns) if (t.role === 'ai') assert.doesNotMatch(t.textTh || '', bad, `${s.id}: ${t.textTh}`);
    }
  });

  it('every mp3 ends quietly (last 150 ms < -30 dBFS) and matches its recorded length ±80 ms', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
    for (const s of allScenarios) {
      for (const t of s.turns) {
        const file = path.join(APP, 'public', t.audio);
        const raw = execFileSync(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', String(RATE), '-'], { maxBuffer: 64 * 1024 * 1024 });
        const tail = tailPeakDb(raw, RATE, 150);
        assert.ok(tail < -30, `${t.audio}: tail peak ${tail.toFixed(1)} dBFS`);
        assert.ok(Math.abs(ms(raw) - t.ms) <= 80, `${t.audio}: decoded ${Math.round(ms(raw))} ms vs manifest ${t.ms} ms`);
      }
    }
  });
});


describe('end-of-call card per site', () => {
  it('only the hackathon page (demo.krai-a.com) ends on the neutral result card; the business page keeps LINE', () => {
    const read = (f) => fs.readFileSync(path.join(APP, 'public', f), 'utf8');
    assert.match(read('demo.js'), /notify:\s*'result'/);
    assert.doesNotMatch(read('js/index.js'), /notify:\s*'result'/);
    assert.match(read('js/call-demo.js'), /notify:\s*'line'/, 'LINE stays the default');
    assert.ok(!fs.readdirSync(path.join(APP, 'public', 'demo', 'audio')).some((f) => f.includes('summary')), 'no spoken-summary clips ship');
  });
});

// ---- a slot may carry its own English case (APAC-regional EN demo) ----
describe('per-language demo cases', () => {
  it('scriptFor keeps Thai as the base and swaps in a slot\'s own EN case only for English', async () => {
    const { SCRIPTS, scriptFor, lineEn } = await import('../src/demoScripts.js');
    const base = SCRIPTS[0];
    assert.equal(scriptFor(base, 'th').turns, base.turns);
    assert.equal(scriptFor(base, 'en').ownEn, Boolean(base.en));
    const slot = {
      ...base,
      en: { titleEn: "It's me, Grandma", callerEn: 'Claims to be a grandchild', callerPhone: '+6591234567', icon: 'family', voice: 'Puck', styleEn: 'a panicky young man', turns: [lineEn('Grandma, it is me.'), lineEn('I need money now.', 'I need money, now.')] },
    };
    const th = scriptFor(slot, 'th');
    const en = scriptFor(slot, 'en');
    assert.equal(th.titleEn, base.titleEn);
    assert.equal(th.turns, base.turns);
    assert.equal(en.id, base.id, 'the slot id is shared');
    assert.equal(en.expected, base.expected);
    assert.equal(en.titleEn, "It's me, Grandma");
    assert.equal(en.titleTh, base.titleTh, 'Thai fields stay for the Thai chip');
    assert.equal(en.icon, 'family');
    assert.deepEqual(en.turns.map((t) => t.en), ['Grandma, it is me.', 'I need money now.']);
    assert.equal(en.turns[1].sayEn, 'I need money, now.');
    assert.equal(en.turns[0].th, null);
  });

  it('displayPhone formats Thai numbers locally and keeps other countries international', async () => {
    const { displayPhone } = await import('../src/demoScripts.js');
    assert.equal(displayPhone('+66819990001'), '081-999-0001');
    assert.equal(displayPhone('+6621002003'), '02-100-2003');
    assert.equal(displayPhone('+6591234567'), '+65 9123 4567');
    assert.equal(displayPhone('+85291234567'), '+852 9123 4567');
    assert.equal(displayPhone('+61412345678'), '+61 412 345 678');
  });

  it('the renderer and the phone read each language\'s own case', () => {
    const src = fs.readFileSync(path.join(APP, 'scripts', 'render-demo.mjs'), 'utf8');
    assert.match(src, /const s = scriptFor\(base, lang\)/);
    const ui = fs.readFileSync(path.join(APP, 'public', 'js', 'call-demo.js'), 'utf8');
    assert.match(ui, /const s = scenarioOf\(id\)\.scenario/, 'chips use the current language\'s scenario');
  });
});
