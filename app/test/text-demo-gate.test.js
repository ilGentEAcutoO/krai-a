// Owner's rule: the public demo spends AI money ONLY in the capped live
// session. The text/turn API (/api/demo/*, /api/analyze, /api/calls,
// /api/tts) is off unless DEMO_TEXT_API=1 — then 404, in any spelling.
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { config } from '../src/config.js';
import { addMember } from '../src/store.js';
import { resetLimits } from '../src/ratelimit.js';
import { demoRouter } from '../src/routes.js';
import { ttsRouter } from '../src/ttsRoutes.js';
import { textDemoGate } from '../src/textDemoGate.js';

config.recaptchaApiKey = '';
config.demoNumber = '';
addMember({ ownerPhone: config.seedMemberPhone, aiNumber: '+66210005501', plan: 'family-149', counted: false });

const savedFlag = process.env.DEMO_TEXT_API;
let server; let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use(textDemoGate());
  app.use('/api', demoRouter(() => {}));
  const fakeTts = async (text, onChunk) => onChunk(Buffer.alloc(32), { complete: true });
  app.use('/api', ttsRouter({ streamImpl: fakeTts }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (savedFlag === undefined) delete process.env.DEMO_TEXT_API;
  else process.env.DEMO_TEXT_API = savedFlag;
  await new Promise((resolve) => server.close(resolve));
});
afterEach(() => resetLimits());

const call = async (method, p, body) => {
  const r = await fetch(`${base}${p}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000),
  });
  return { status: r.status, body: await r.json().catch(() => null), type: r.headers.get('content-type') || '' };
};

describe('DEMO_TEXT_API off (default)', () => {
  it('every text-demo endpoint is 404, in any spelling', async () => {
    delete process.env.DEMO_TEXT_API;
    const probes = [
      ['POST', '/api/demo/call', {}], ['POST', '/api/demo/turn', { callId: 'x', text: 'hi' }],
      ['POST', '/api/demo/end', { callId: 'x' }], ['GET', '/api/demo/scripts'],
      ['POST', '/api/analyze', { text: 'โอนเงินด่วน' }], ['POST', '/api/analyze/', { text: 'โอนเงินด่วน' }],
      ['GET', '/api/calls'], ['GET', '/api/calls/call_x'], ['GET', '/API/Calls'],
      ['GET', '/api/tts?call=call_00000000000000000000000000000000&turn=0'], ['POST', '/API/DEMO/CALL', {}],
    ];
    for (const [m, p, b] of probes) assert.equal((await call(m, p, b)).status, 404, `${m} ${p}`);
  });

  it('everything else still works', async () => {
    delete process.env.DEMO_TEXT_API;
    assert.equal((await call('GET', '/api/status')).status, 200);
    assert.equal((await call('GET', '/api/plans')).status, 200);
    assert.equal((await call('GET', '/api/stats')).status, 200);
  });
});

describe('DEMO_TEXT_API=1', () => {
  it('the text demo, analyze, history and TTS all answer', async () => {
    process.env.DEMO_TEXT_API = '1';
    const start = await call('POST', '/api/demo/call', {});
    assert.equal(start.status, 200);
    const id = start.body.call.id;
    assert.equal((await call('POST', '/api/analyze', { text: 'โอนเงินด่วน' })).status, 200);
    assert.equal((await call('GET', `/api/calls?ids=${id}`)).status, 200);
    const tts = await fetch(`${base}/api/tts?call=${id}&turn=0`, { signal: AbortSignal.timeout(5000) });
    assert.equal(tts.status, 200);
    assert.match(tts.headers.get('content-type'), /audio\/wav/);
  });
});
