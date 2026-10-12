// /demo playback engine (public/demo-player.js): sequential lines with a
// gap, no overlapping audio, skip/stop/restart, the no-audio fallback, and
// watchdogs for clips that never start or never fire 'ended'.
// Real timers with tiny durations — the fake audio only stands in for <audio>.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPlayer, verdictAt, finalOf, estimateMs, autoPauseOnHidden } from '../public/demo-player.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Clip durations come from the URL (`/a/40` = 40 ms). Broken clips:
// `/fail` rejects, `/throw` throws synchronously, `/hang` never starts,
// `/noend` starts but never fires 'ended' (the QA flake: a stuck <audio>).
function fakeAudio() {
  const log = [];
  let pending = null;
  let paused = false;
  return {
    log,
    get playing() { return !!pending && !paused; },
    get paused() { return paused; },
    // Pause keeps the clip's remaining time, like a paused <audio>.
    pause() {
      paused = true;
      if (pending?.t) { clearTimeout(pending.t); pending.t = 0; pending.left -= Date.now() - pending.at; }
    },
    resume() {
      paused = false;
      if (pending && pending.left !== undefined && !pending.t) {
        const p = pending;
        p.at = Date.now();
        p.t = setTimeout(() => { pending = null; p.resolve(); }, Math.max(0, p.left));
      }
    },
    play(url, { onStart } = {}) {
      if (pending) throw new Error(`overlap: ${url} started while ${pending.url} still playing`);
      if (url.endsWith('/fail')) return Promise.reject(new Error('NotSupportedError'));
      if (url.endsWith('/throw')) throw new Error('boom');
      log.push({ url, at: Date.now() });
      if (url.endsWith('/hang') || url.endsWith('/noend')) {
        if (url.endsWith('/noend')) onStart?.();
        return new Promise((resolve) => { pending = { url, resolve, t: 0 }; });
      }
      const ms = Number(url.split('/').pop());
      onStart?.();
      return new Promise((resolve) => {
        pending = { url, resolve, t: 0, left: ms, at: Date.now() };
        if (!paused) pending.t = setTimeout(() => { pending = null; resolve(); }, ms);
      });
    },
    stop() {
      paused = false;
      if (!pending) return;
      clearTimeout(pending.t);
      const { resolve } = pending;
      pending = null;
      resolve();
    },
  };
}

const V = (verdict, confidence) => ({ verdict, confidence, reasonTh: 'r', reasonEn: 'r', engine: 'jev' });
const scenario = (ms = [30, 30, 30, 30]) => ({
  id: 's',
  turns: ms.map((d, i) => ({
    role: i % 2 ? 'caller' : 'ai',
    textTh: `line ${i}`,
    textEn: `line ${i}`,
    audio: typeof d === 'string' ? d : `/a/${d}`,
    ms: 40,
    verdict: i === 1 ? V('UNSURE', 0.55) : i === 3 ? V('SCAM', 0.94) : null,
  })),
  final: { verdict: 'SCAM', confidence: 0.94, lineTh: 'x', lineEn: 'x' },
});

function rig(opts = {}) {
  const audio = fakeAudio();
  const events = [];
  const player = createPlayer({ audio, gapMs: 25, ringMs: 10, loadTimeoutMs: 120, endMarginMs: 60, onEvent: (e) => events.push({ ...e, at: Date.now() }), ...opts });
  const finished = () => new Promise((resolve) => {
    const iv = setInterval(() => {
      if (events.some((e) => e.type === 'final')) { clearInterval(iv); resolve(); }
    }, 5);
  });
  return { audio, events, player, finished };
}

describe('demo player', () => {
  it('plays every line to the end, then the gap, then the next — never overlapping', async () => {
    const { events, player, finished } = rig();
    player.start(scenario());
    await finished();
    const tl = player.timeline;
    assert.equal(tl.length, 4);
    for (let i = 1; i < tl.length; i += 1) {
      assert.ok(tl[i].start >= tl[i - 1].end + 20, `line ${i} starts ${tl[i].start - tl[i - 1].end} ms after the previous ended`);
    }
    for (const r of tl) assert.ok(r.end - r.start >= 25, 'clip played to its end');
    assert.deepEqual(events.map((e) => e.type), [
      'ring', 'line', 'line-end', 'line', 'line-end', 'verdict', 'line', 'line-end', 'line', 'line-end', 'verdict', 'final',
    ]);
    assert.equal(events.at(-1).final.verdict, 'SCAM');
  });

  it('updates the verdict only after the caller line has finished speaking', async () => {
    const { events, player, finished } = rig();
    player.start(scenario());
    await finished();
    const firstVerdict = events.findIndex((e) => e.type === 'verdict');
    assert.equal(events[firstVerdict - 1].type, 'line-end');
    assert.equal(events[firstVerdict].index, 1);
  });

  it('skip ends the current line now and moves on (verdict still recorded)', async () => {
    const { events, player, finished } = rig();
    player.start(scenario([30, 400, 30, 30]));
    while (!(player.index === 1 && player.phase === 'line')) await sleep(5); // into line 1
    await sleep(20);
    player.skip();
    await finished();
    const tl = player.timeline;
    assert.equal(tl[1].skipped, true);
    assert.ok(tl[1].end - tl[1].start < 200, 'long clip was cut by skip');
    assert.ok(events.some((e) => e.type === 'verdict' && e.index === 1));
  });

  it('stop silences audio and emits nothing more', async () => {
    const { audio, events, player } = rig();
    player.start(scenario([30, 300, 30, 30]));
    await sleep(80);
    player.stop();
    const n = events.length;
    assert.equal(audio.playing, false);
    await sleep(400);
    assert.equal(events.length, n);
    assert.equal(events.at(-1).type, 'stopped');
    assert.equal(player.phase, 'idle');
  });

  it('restarting mid-line never plays two clips at once and drops the old run', async () => {
    const { events, player, finished } = rig();
    player.start(scenario([200, 200, 200, 200]));
    await sleep(60);
    player.start(scenario()); // fake audio throws on overlap
    await finished();
    assert.equal(events.filter((e) => e.type === 'final').length, 1);
    assert.equal(player.timeline.length, 4);
  });

  it('keeps the story moving on subtitles when a clip cannot play', async () => {
    const { events, player, finished } = rig();
    player.start(scenario([30, '/a/fail', 30, 30]));
    await finished();
    assert.equal(events.filter((e) => e.type === 'audio-error').length, 1);
    const tl = player.timeline;
    assert.ok(tl[1].end - tl[1].start >= 35, 'waited the recorded line length instead');
  });
});

describe('demo player never gets stuck', () => {
  it("moves on when a clip starts but 'ended' never fires, and still reaches the verdict", async () => {
    const { audio, events, player, finished } = rig();
    player.start(scenario([30, '/a/noend', 30, '/a/noend']));
    await finished();
    const tl = player.timeline;
    assert.equal(tl[1].cut, 'no-end');
    assert.ok(tl[1].end - tl[1].start >= 40 + 60 - 5, 'waited its recorded length + margin');
    assert.ok(tl[1].end - tl[1].start < 400, 'but not forever');
    assert.equal(audio.playing, false, 'the stuck clip was stopped');
    assert.deepEqual(events.filter((e) => e.type === 'verdict').map((e) => e.verdict.verdict), ['UNSURE', 'SCAM']);
    assert.equal(events.at(-1).type, 'final');
    assert.equal(events.at(-1).final.verdict, 'SCAM');
    assert.equal(events.filter((e) => e.type === 'audio-error').length, 0, 'it did play, just never said so');
  });

  it('carries on with subtitles when a clip never starts', async () => {
    const { events, player, finished } = rig();
    player.start(scenario(['/a/hang', 30, '/a/hang', 30]));
    await finished();
    const tl = player.timeline;
    assert.equal(tl[0].cut, 'no-start');
    assert.ok(tl[0].end - tl[0].start >= 115, 'gave the clip its load window');
    assert.equal(events.filter((e) => e.type === 'audio-error').length, 1);
    assert.equal(events.at(-1).final.verdict, 'SCAM');
  });

  it('survives an audio output that throws instead of rejecting', async () => {
    const { events, player, finished } = rig();
    player.start(scenario([30, '/a/throw', 30, 30]));
    await finished();
    assert.equal(player.timeline[1].cut, 'error');
    assert.equal(events.at(-1).type, 'final');
  });

  it('does not cut a clip that runs a little past its recorded length', async () => {
    const { player, finished } = rig();
    const sc = scenario([30, 30, 30, 30]);
    sc.turns[1].audio = '/a/75'; // recorded ms is 40; plays 75 (< 40 + 60 margin)
    player.start(sc);
    await finished();
    assert.equal(player.timeline[1].cut, undefined);
    assert.ok(player.timeline[1].end - player.timeline[1].start >= 70);
  });

  it('ends on the last heard verdict when the manifest has no final', async () => {
    const { events, player, finished } = rig();
    const sc = scenario();
    delete sc.final;
    player.start(sc);
    await finished();
    assert.equal(events.at(-1).final.verdict, 'SCAM');
  });

  it('every scenario still ends in a verdict when every clip is stuck', async () => {
    const { events, player, finished } = rig();
    player.start(scenario(['/a/noend', '/a/hang', '/a/noend', '/a/hang']));
    await finished();
    assert.equal(events.filter((e) => e.type === 'final').length, 1);
    assert.equal(events.at(-1).final.verdict, 'SCAM');
  });
});

describe('pause / resume / stop', () => {
  const until = async (fn) => { while (!fn()) await sleep(5); };

  it('pause mid-line freezes the clip and the timeline; resume continues exactly', async () => {
    const { audio, events, player, finished } = rig();
    player.start(scenario([60, 60, 60, 60]));
    await until(() => player.index === 1 && player.phase === 'line');
    await sleep(20);
    assert.equal(player.pause(), true);
    assert.equal(player.paused, true);
    assert.equal(audio.paused, true);
    const n = events.length;
    await sleep(350); // far longer than the clip + the end watchdog (60 + 60)
    assert.equal(events.length, n + 0, 'no line-end, verdict or next line while paused');
    assert.equal(player.index, 1);
    assert.equal(events.at(-1).type, 'paused');
    assert.equal(player.resume(), true);
    await finished();
    const line = player.timeline[1];
    assert.equal(line.cut, undefined, 'the watchdog did not fire during the pause');
    assert.ok(line.pausedMs >= 340);
    assert.ok(line.end - line.start - line.pausedMs >= 55, 'the clip still played its full length');
    assert.deepEqual(events.filter((e) => e.type === 'verdict').map((e) => e.verdict.verdict), ['UNSURE', 'SCAM']);
  });

  it('pause freezes the gap between lines and the ring', async () => {
    const { player, events } = rig({ gapMs: 80 });
    player.start(scenario([30, 30, 30, 30]));
    await until(() => player.phase === 'gap');
    player.pause();
    const at = { index: player.index, n: events.length };
    await sleep(250);
    assert.equal(player.phase, 'gap');
    assert.equal(player.index, at.index);
    assert.equal(events.length, at.n);
    player.resume();
    await until(() => player.index === at.index + 1);
    player.stop();
  });

  it("pause freezes a stuck clip's watchdog too", async () => {
    const { player, finished } = rig();
    player.start(scenario([30, '/a/noend', 30, 30]));
    await until(() => player.index === 1 && player.phase === 'line');
    player.pause();
    await sleep(300); // > 40 ms + 60 ms margin
    assert.equal(player.phase, 'line');
    assert.equal(player.timeline[1].end, null);
    player.resume();
    await finished();
    assert.equal(player.timeline[1].cut, 'no-end');
  });

  it('stop resets to idle, silences audio and emits nothing more', async () => {
    const { audio, events, player } = rig();
    player.start(scenario([200, 200, 200, 200]));
    await until(() => player.phase === 'line');
    player.pause();
    player.stop();
    assert.equal(player.phase, 'idle');
    assert.equal(player.paused, false);
    assert.equal(audio.playing, false);
    assert.equal(events.at(-1).type, 'stopped');
    const n = events.length;
    await sleep(300);
    assert.equal(events.length, n);
    assert.equal(events.some((e) => e.type === 'final'), false, 'a stopped call shows no LINE card');
  });

  it('skip while paused resumes and moves to the next line', async () => {
    const { player, finished } = rig();
    player.start(scenario([300, 30, 30, 30]));
    await until(() => player.index === 0 && player.phase === 'line');
    player.pause();
    player.skip();
    assert.equal(player.paused, false);
    await finished();
    assert.equal(player.timeline[0].skipped, true);
  });

  it('pause is a no-op when nothing is playing, and a finished call never chains', async () => {
    const { events, player, finished } = rig();
    assert.equal(player.pause(), false);
    player.start(scenario());
    await finished();
    assert.equal(player.pause(), false);
    await sleep(200);
    assert.equal(events.filter((e) => e.type === 'ring').length, 1);
    assert.equal(player.phase, 'done');
  });

  it('a hidden tab pauses the call; coming back does not resume it', async () => {
    const { player } = rig();
    const doc = new EventTarget();
    let autoPaused = 0;
    const unbind = autoPauseOnHidden(player, doc, () => { autoPaused += 1; });
    player.start(scenario([300, 30, 30, 30]));
    await until(() => player.phase === 'line');
    doc.hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    assert.equal(player.paused, true);
    assert.equal(autoPaused, 1);
    doc.hidden = false;
    doc.dispatchEvent(new Event('visibilitychange'));
    assert.equal(player.paused, true, 'only the visitor resumes');
    unbind();
    player.stop();
  });
});

describe('verdictAt / finalOf / estimateMs', () => {
  it('finalOf prefers the recorded final', () => {
    assert.equal(finalOf(scenario()).confidence, 0.94);
    assert.equal(finalOf(null), null);
  });

  it('returns the latest verdict up to a turn', () => {
    const sc = scenario();
    assert.equal(verdictAt(sc, 0), null);
    assert.equal(verdictAt(sc, 2).verdict, 'UNSURE');
    assert.equal(verdictAt(sc, 3).verdict, 'SCAM');
    assert.equal(verdictAt(null, 3), null);
  });
  it('clamps the fallback speaking time', () => {
    assert.equal(estimateMs(''), 1800);
    assert.equal(estimateMs('x'.repeat(1000)), 9000);
  });
});
