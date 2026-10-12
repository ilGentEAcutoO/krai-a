// Truthful engine status: the UI pill reflects REAL outcomes (boot probe +
// every live call), never "a key exists". Mocked fetch, injected clock.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createJudge } from '../src/judge/index.js';

const KEY_T = 'ts_status_key_never_in_output_0123456789';
const KEY_G = 'gm_status_key_never_in_output_0123456789';
const cfg = (over = {}) => ({
  geminiApiKey: KEY_G, geminiModel: 'gemini-3.8-flash', geminiTimeoutMs: 2000,
  typesafeApiKey: KEY_T, jevModel: 'jev-latest', jevTimeoutMs: 2000, aiOffline: false, maxTurnsPerCall: 12,
  ...over,
});

function mockFetch(state) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    const which = String(url).includes('typesafe') ? 'jev' : 'gemini';
    if (state[which] === 'throw') throw new Error('network-unreachable');
    if (state[which] !== 'ok') return new Response('{}', { status: state[which] });
    if ((init.method || 'GET') === 'GET') return new Response('{"models":[]}', { status: 200 });
    if (which === 'jev') {
      const body = JSON.parse(init.body);
      const answers = {};
      for (const [id, q] of Object.entries(body.questions)) {
        answers[id] = q.type === 'choice'
          ? { type: 'choice', choice: 'UNSURE', probabilities: { UNSURE: 0.9, LEGIT: 0.05, SCAM: 0.05 }, confidence: 0.85 }
          : { type: 'noul', noul: 0.02 };
      }
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers }), { status: 200 });
    }
    const schema = JSON.parse(init.body).generationConfig.responseJsonSchema;
    const text = schema.properties.verdict ? '{"verdict":"UNSURE","reasonTh":"ยังไม่ชัด","reasonEn":"Unclear."}' : '{"text":"สวัสดีค่ะ"}';
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
  };
  return { fetch, calls, probes: () => calls.filter((c) => c.method === 'GET') };
}

const turns = [{ role: 'ai', text: 'สวัสดีค่ะ' }, { role: 'caller', text: 'สวัสดีครับ ขอสอบถามหน่อยครับ' }];

describe('getEngineStatus()', () => {
  it('probes both engines on first use and reports live when both answer', async () => {
    const m = mockFetch({ jev: 'ok', gemini: 'ok' });
    const j = createJudge({ fetch: m.fetch, config: cfg() });
    const s = await j.getEngineStatus();
    assert.equal(s.mode, 'live');
    assert.equal(s.gemini.ok, true);
    assert.equal(s.jev.ok, true);
    assert.equal(s.gemini.model, 'gemini-3.8-flash');
    assert.equal(s.jev.model, 'jev-latest');
    assert.equal(m.probes().length, 2);
  });

  it('reports degraded with the error after a real Jev failure', async () => {
    const state = { jev: 'ok', gemini: 'ok' };
    const m = mockFetch(state);
    const j = createJudge({ fetch: m.fetch, config: cfg() });
    await j.getEngineStatus();
    state.jev = 503;
    await j.judgeTurn({ turns });
    const s = await j.getEngineStatus();
    assert.equal(s.jev.ok, false);
    assert.match(s.jev.lastError, /503/);
    assert.equal(s.mode, 'degraded');
  });

  it('recovers to live after the next successful real call', async () => {
    const state = { jev: 503, gemini: 'ok' };
    const m = mockFetch(state);
    const j = createJudge({ fetch: m.fetch, config: cfg() });
    assert.equal((await j.getEngineStatus()).mode, 'degraded');
    state.jev = 'ok';
    await j.judgeTurn({ turns });
    assert.equal((await j.getEngineStatus()).mode, 'live');
  });

  it('reports rules without any network call when no key is configured', async () => {
    const m = mockFetch({ jev: 'ok', gemini: 'ok' });
    const j = createJudge({ fetch: m.fetch, config: cfg({ geminiApiKey: '', typesafeApiKey: '' }) });
    const s = await j.getEngineStatus();
    assert.equal(s.mode, 'rules');
    assert.equal(s.gemini.configured, false);
    assert.equal(s.gemini.ok, false);
    assert.equal(m.calls.length, 0);
  });

  it('reports rules when both probes fail (wrong model id / network)', async () => {
    const m = mockFetch({ jev: 'throw', gemini: 404 });
    const j = createJudge({ fetch: m.fetch, config: cfg() });
    const s = await j.getEngineStatus();
    assert.equal(s.mode, 'rules');
    assert.match(s.gemini.lastError, /404/);
  });

  it('returns the cached snapshot at once with noWait and probes in the background', async () => {
    const m = mockFetch({ jev: 'ok', gemini: 'ok' });
    const j = createJudge({ fetch: m.fetch, config: cfg() });
    const first = await j.getEngineStatus({ noWait: true });
    assert.equal(first.mode, 'rules');
    assert.equal(m.probes().length, 2);
    await j.getEngineStatus({ wait: true });
    assert.equal((await j.getEngineStatus()).mode, 'live');
  });

  it('re-probes at most every 10 minutes', async () => {
    let t = 1_000_000;
    const m = mockFetch({ jev: 'ok', gemini: 'ok' });
    const j = createJudge({ fetch: m.fetch, config: cfg(), now: () => t });
    await j.getEngineStatus();
    t += 9 * 60_000;
    await j.getEngineStatus();
    assert.equal(m.probes().length, 2);
    t += 2 * 60_000;
    await j.getEngineStatus({ wait: true });
    assert.equal(m.probes().length, 4);
  });

  it('never exposes key values', async () => {
    const m = mockFetch({ jev: 401, gemini: 403 });
    const j = createJudge({ fetch: m.fetch, config: cfg() });
    const json = JSON.stringify(await j.getEngineStatus());
    assert.ok(!json.includes(KEY_T) && !json.includes(KEY_G));
  });

  it('marks an engine down when it answers 200 with a malformed body', async () => {
    const m = mockFetch({ jev: 'ok', gemini: 'ok' });
    const fetch = async (url, init = {}) => (String(url).includes('typesafe') && init.method === 'POST'
      ? new Response('{"answers":{}}', { status: 200 })
      : m.fetch(url, init));
    const j = createJudge({ fetch, config: cfg() });
    await j.getEngineStatus();
    const v = await j.judgeTurn({ turns });
    assert.notEqual(v.engine, 'jev');
    const s = await j.getEngineStatus();
    assert.equal(s.jev.ok, false);
    assert.match(s.jev.lastError, /bad/);
  });

  it('records the engine that answered on each verdict', async () => {
    const m = mockFetch({ jev: 'ok', gemini: 'ok' });
    const j = createJudge({ fetch: m.fetch, config: cfg() });
    const v = await j.judgeTurn({ turns });
    assert.equal(v.engine, 'jev');
    const s = await j.getEngineStatus();
    assert.ok(s.jev.lastOkAt);
  });
});
