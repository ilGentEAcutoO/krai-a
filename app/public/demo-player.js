// Scenario playback engine for /demo — pure (no DOM), so node:test can run it.
// One line at a time: a line's audio plays to its END, then a fixed gap, then
// the next line. Voices never overlap and nothing is cut off mid-sentence.
// demo.js supplies the audio output and renders the events.
//
// audio adapter: { play(url, { onStart }) → Promise (resolves when the clip
// ends or is stopped, rejects when it cannot play; calls onStart once sound
// actually begins), stop(), pause(), resume() }.
//
// A clip must never hold the story hostage: if it does not start within
// LOAD_TIMEOUT_MS, or its 'ended' never arrives END_MARGIN_MS after its
// recorded length, the line carries on with subtitles and the call still
// reaches its verdict and LINE card.
//
// Phases: ring (the incoming call) → transfer (optional: "transferring to
// the KRAI-A assistant", transferMs > 0) → line / gap … → done. beforeLine
// (optional) runs before every line and returns how long to wait first —
// call-demo plays its turn-switch tone there; that wait pauses like any other.
//
// Pause freezes everything: the clip, the ring/transfer/gap/subtitle waits and both
// watchdogs. Resume continues exactly where it stopped. A finished call never
// chains into another one.

export const GAP_MS = 600;
export const RING_MS = 1400;
export const LOAD_TIMEOUT_MS = 3000;
export const END_MARGIN_MS = 1500;
const MIN_SUBTITLE_MS = 1200; // a line whose audio gave up still stays readable

// Rough Thai/English speaking time when a clip cannot play (no `ms` given).
export function estimateMs(text = '') {
  return Math.max(1800, Math.min(9000, String(text).length * 75));
}

// Latest verdict recorded at or before turn `index` (null = still listening).
export function verdictAt(scenario, index) {
  let v = null;
  for (let i = 0; i <= index && i < (scenario?.turns?.length || 0); i += 1) {
    if (scenario.turns[i].verdict) v = scenario.turns[i].verdict;
  }
  return v;
}

// The verdict the call ends on: the recorded final, else the last one heard.
export function finalOf(scenario) {
  return scenario?.final?.verdict ? scenario.final : verdictAt(scenario, (scenario?.turns?.length || 0) - 1);
}

// A hidden tab pauses the call; only the visitor resumes it.
export function autoPauseOnHidden(player, doc, onPaused = () => {}) {
  const handler = () => { if (doc.hidden && player.pause()) onPaused(); };
  doc.addEventListener('visibilitychange', handler);
  return () => doc.removeEventListener('visibilitychange', handler);
}

export function createPlayer({
  audio, gapMs = GAP_MS, ringMs = RING_MS, transferMs = 0, loadTimeoutMs = LOAD_TIMEOUT_MS, endMarginMs = END_MARGIN_MS,
  now = () => Date.now(), onEvent = () => {}, beforeLine = null,
}) {
  let run = 0;          // bumped by every start/stop: stale continuations bail out
  let interrupt = null; // ends the wait or clip in progress (skip/stop)
  let scenario = null;
  let phase = 'idle';   // idle | ring | transfer | line | gap | done
  let index = -1;
  let paused = false;
  let audioFailed = false;
  const timers = new Set(); // every pending timer, so pause can freeze them all
  const timeline = [];      // [{ index, role, start, end, skipped, cut, pausedMs }] — measured, for QA
  let pausedAt = 0;

  const emit = (e) => { try { onEvent(e); } catch (err) { console.error(err); } };

  // setTimeout that pause() can freeze and resume() can continue.
  function timer(ms, fn) {
    const t = { left: ms, at: 0, id: 0 };
    t.start = () => {
      t.at = now();
      t.id = setTimeout(() => { timers.delete(t); fn(); }, t.left);
    };
    t.freeze = () => {
      if (!t.id) return;
      clearTimeout(t.id);
      t.id = 0;
      t.left = Math.max(0, t.left - (now() - t.at));
    };
    t.cancel = () => { clearTimeout(t.id); t.id = 0; timers.delete(t); };
    timers.add(t);
    if (!paused) t.start();
    return t;
  }

  function wait(ms) {
    return new Promise((resolve) => {
      const done = () => {
        t.cancel();
        if (interrupt === done) interrupt = null;
        resolve();
      };
      const t = timer(ms, done);
      interrupt = done;
    });
  }

  // Resolves with how the clip ended: 'ended' | 'skip' | 'error' | 'no-start' | 'no-end'.
  function playClip(turn, ms, rec) {
    return new Promise((resolve) => {
      let started = false;
      let settled = false;
      let watchdog = null;
      const finish = (how) => {
        if (settled) return;
        settled = true;
        watchdog?.cancel();
        if (interrupt === stopNow) interrupt = null;
        resolve(how);
      };
      const giveUp = (how) => { audio.stop(); finish(how); };
      const stopNow = () => { rec.skipped = true; giveUp('skip'); };
      const onStart = () => {
        if (started || settled) return;
        started = true;
        watchdog?.cancel();
        watchdog = timer(ms + endMarginMs, () => giveUp('no-end'));
      };
      interrupt = stopNow;
      watchdog = timer(loadTimeoutMs, () => { if (!started) giveUp('no-start'); });
      Promise.resolve()
        .then(() => audio.play(turn.audio, { onStart }))
        .then(() => finish('ended'), () => finish('error'));
    });
  }

  async function speak(turn, id, rec) {
    const ms = turn.ms || estimateMs(turn.textTh);
    const how = await playClip(turn, ms, rec);
    if (id !== run || how === 'ended' || how === 'skip') return;
    if (how === 'no-end') { rec.cut = 'no-end'; return; } // it played its full length
    rec.cut = how;
    if (!audioFailed) { audioFailed = true; emit({ type: 'audio-error', index }); }
    // No sound for this line: keep the subtitle up for the rest of its length
    // (time spent paused does not count as reading time).
    const shown = now() - rec.start - rec.pausedMs;
    await wait(Math.max(MIN_SUBTITLE_MS, ms - shown));
  }

  async function go(sc, id) {
    phase = 'ring';
    emit({ type: 'ring', scenario: sc });
    await wait(ringMs);
    if (id !== run) return;
    if (transferMs > 0) {
      phase = 'transfer';
      emit({ type: 'transfer', scenario: sc });
      await wait(transferMs);
    }
    const turns = Array.isArray(sc?.turns) ? sc.turns : [];
    for (let i = 0; i < turns.length; i += 1) {
      if (id !== run) return;
      const turn = turns[i];
      if (beforeLine) {
        let lead = 0;
        try { lead = Number(beforeLine(turn, turns[i - 1] || null, i)) || 0; } catch (err) { console.error(err); }
        if (lead > 0) await wait(lead);
        if (id !== run) return;
      }
      phase = 'line';
      index = i;
      const rec = { index: i, role: turn.role, start: now(), end: null, skipped: false, pausedMs: 0 };
      timeline.push(rec);
      emit({ type: 'line', index: i, turn, scenario: sc });
      try {
        await speak(turn, id, rec);
      } catch (err) {
        console.error(err); // never let one line stop the call short of its verdict
      }
      if (id !== run) return;
      rec.end = now();
      emit({ type: 'line-end', index: i, turn, skipped: rec.skipped });
      if (turn.verdict) emit({ type: 'verdict', index: i, verdict: turn.verdict });
      if (i < turns.length - 1) {
        phase = 'gap';
        await wait(gapMs);
      }
    }
    if (id !== run) return;
    phase = 'done'; // the end of this call; nothing starts another one
    emit({ type: 'final', final: finalOf(sc), scenario: sc });
  }

  function halt() {
    run += 1;
    const f = interrupt;
    interrupt = null;
    if (f) f();
    for (const t of [...timers]) t.cancel();
    paused = false; // the adapter's stop() clears its own pause too
    pausedAt = 0;
    audio.stop();
  }

  const active = () => phase === 'ring' || phase === 'transfer' || phase === 'line' || phase === 'gap';

  const player = {
    start(sc) {
      halt();
      scenario = sc;
      index = -1;
      audioFailed = false;
      timeline.length = 0;
      go(sc, run);
    },
    // Skip = end the current line (or ring/gap) now; the next one follows.
    // A skip while paused is a "go on": it resumes first.
    skip() {
      if (paused) player.resume();
      if (interrupt) interrupt();
    },
    pause() {
      if (paused || !active()) return false;
      paused = true;
      pausedAt = now();
      for (const t of timers) t.freeze();
      audio.pause?.();
      emit({ type: 'paused' });
      return true;
    },
    resume() {
      if (!paused) return false;
      paused = false;
      const rec = timeline.at(-1);
      if (rec && rec.end === null) rec.pausedMs += now() - pausedAt;
      pausedAt = 0;
      for (const t of timers) if (!t.id) t.start();
      audio.resume?.();
      emit({ type: 'resumed' });
      return true;
    },
    stop() {
      halt();
      phase = 'idle';
      index = -1;
      emit({ type: 'stopped' });
    },
    get phase() { return phase; },
    get index() { return index; },
    get paused() { return paused; },
    get scenario() { return scenario; },
    get timeline() { return timeline.map((r) => ({ ...r })); },
  };
  return player;
}

// Risk meter 0..1 from a per-turn verdict (null = still listening):
// SCAM fills from the middle up with its confidence, LEGIT drains down, UNSURE sits mid.
export function riskOf(v) {
  if (!v?.verdict) return null;
  const c = Math.max(0, Math.min(1, Number(v.confidence) || 0));
  if (v.verdict === 'SCAM') return 0.5 + c / 2;
  if (v.verdict === 'LEGIT') return 0.5 - c / 2;
  return 0.5;
}

// The recording for one case in one language: English calls live in
// `scenariosEn` (a separate real run in English). Without one, the Thai
// recording plays with English subtitles (audioLang tells the UI which).
export function scenarioFor(manifest, id, lang = 'th') {
  const th = manifest?.scenarios?.find((s) => s.id === id) || null;
  if (lang === 'en') {
    const en = manifest?.scenariosEn?.find((s) => s.id === id);
    if (en) return { scenario: en, audioLang: 'en' };
  }
  return { scenario: th, audioLang: 'th' };
}
