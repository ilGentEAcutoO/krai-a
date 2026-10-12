// Public (unauthenticated) API must never leak member data: no member
// listing, no member calls, no cross-visitor demo transcripts, no owner
// LINE id in demo notify results, and demo call ids must be unguessable.
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { config } from '../src/config.js';
import { addMember, createCall, addTurn, getCall, deleteCall } from '../src/store.js';
import { resetLimits } from '../src/ratelimit.js';
import { demoRouter } from '../src/routes.js';
import { attachLiveHub } from '../src/live.js';

// Demo household = SEED_MEMBER_PHONE (routes never pick "first member").
const SEED = addMember({ ownerPhone: config.seedMemberPhone, aiNumber: '+66210009101', plan: 'family-149', counted: false });
const REAL = addMember({ ownerPhone: '+66810009102', aiNumber: '+66210009102' });

let server; let base;
const savedAdapters = [...config.notifyAdapters];
const savedLineTo = config.lineDefaultTo;
const savedLineToken = config.lineChannelAccessToken;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', demoRouter(() => {}));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); });
afterEach(() => {
  resetLimits();
  config.notifyAdapters = [...savedAdapters];
  config.lineDefaultTo = savedLineTo;
  config.lineChannelAccessToken = savedLineToken;
});

const get = async (p) => { const r = await fetch(`${base}${p}`); return { status: r.status, body: await r.json().catch(() => null) }; };
const post = async (p, body) => {
  const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

function memberCall() {
  const c = createCall({ memberId: REAL.id, callerPhone: '+66819009999', aiNumber: REAL.aiNumber, source: 'twilio' });
  addTurn(c.id, 'caller', 'secret member transcript');
  return c;
}

describe('member data is never public', () => {
  it('GET /api/members is gone', async () => {
    const r = await get('/api/members');
    assert.equal(r.status, 404);
  });

  it('GET /api/calls without ids lists nothing (no global feed)', async () => {
    const c = memberCall();
    const r = await get('/api/calls');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.calls, []);
    deleteCall(c.id);
  });

  it('member (non-demo) calls are refused even by exact id', async () => {
    const c = memberCall();
    const list = await get(`/api/calls?ids=${c.id}`);
    assert.deepEqual(list.body.calls, []);
    const one = await get(`/api/calls/${c.id}`);
    assert.equal(one.status, 404);
    assert.doesNotMatch(JSON.stringify([list.body, one.body]), /secret member transcript|\+66819009999/);
    deleteCall(c.id);
  });

  it('demo turn/end endpoints refuse member calls', async () => {
    const c = memberCall();
    const t = await post('/api/demo/turn', { callId: c.id, text: 'injected' });
    assert.equal(t.status, 404);
    assert.equal(getCall(c.id).turns.length, 1);
    const e = await post('/api/demo/end', { callId: c.id });
    assert.equal(e.status, 404);
    assert.equal(getCall(c.id).endedAt, null);
    assert.doesNotMatch(JSON.stringify([t.body, e.body]), /secret member transcript/);
    deleteCall(c.id);
  });
});

describe('demo history is per visitor', () => {
  it('demo call ids are unguessable (128-bit random)', async () => {
    const a = (await post('/api/demo/call', {})).body.call.id;
    const b = (await post('/api/demo/call', {})).body.call.id;
    assert.match(a, /^call_[0-9a-f]{32}$/);
    assert.match(b, /^call_[0-9a-f]{32}$/);
    assert.notEqual(a, b);
    const c = memberCall();
    assert.match(c.id, /^call_[0-9a-f]{32}$/);
    deleteCall(c.id);
  });

  it("visitor A's history never contains visitor B's call", async () => {
    const a = (await post('/api/demo/call', {})).body.call;
    await post('/api/demo/turn', { callId: a.id, text: 'visitor A private text' });
    const startB = await post('/api/demo/call', {});
    const b = startB.body.call;
    // B is another visitor: it neither ends A's open call nor learns A's id.
    assert.equal(startB.body.replacedCallId, undefined);
    assert.equal(startB.body.replaced, false);
    assert.equal(getCall(a.id).endedAt, null);
    assert.doesNotMatch(JSON.stringify(startB.body), new RegExp(a.id));
    const histB = await get(`/api/calls?ids=${b.id}`);
    assert.deepEqual(histB.body.calls.map((c) => c.id), [b.id]);
    assert.doesNotMatch(JSON.stringify(histB.body), /visitor A private text/);
    const histA = await get(`/api/calls?ids=${a.id},${b.id}`);
    assert.deepEqual(histA.body.calls.map((c) => c.id).sort(), [a.id, b.id].sort());
    const one = await get(`/api/calls/${a.id}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.call.id, a.id);
  });

  it('caller-supplied callerPhone is reduced to phone characters', async () => {
    const r = await post('/api/demo/call', { callerPhone: '<img src=x onerror=alert(1)>+66812345678' });
    assert.doesNotMatch(r.body.call.callerPhone, /[<>]/);
  });

  it('demo notify results never expose the owner LINE id (and never push)', async () => {
    config.notifyAdapters = ['line'];
    config.lineDefaultTo = 'Uowner0123456789secret';
    config.lineChannelAccessToken = 'test-token';
    const realFetch = global.fetch;
    const pushed = [];
    global.fetch = async (url, opts) => (String(url).startsWith('https://api.line.me')
      ? (pushed.push(url), { ok: true, json: async () => ({}) })
      : realFetch(url, opts));
    try {
      const start = await realFetch(`${base}/api/demo/call`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      }).then((r) => r.json());
      const end = await realFetch(`${base}/api/demo/end`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId: start.call.id }),
      }).then((r) => r.json());
      assert.equal(end.ended, true);
      assert.equal(end.notify.delivered, false);
      assert.deepEqual(pushed, []);
      assert.doesNotMatch(JSON.stringify(end), /Uowner0123456789secret/);
    } finally {
      global.fetch = realFetch;
    }
  });
});

describe('live hub (/ws) is scoped per call', () => {
  function fakeWss() {
    const handlers = {};
    return { clients: new Set(), on: (ev, fn) => { handlers[ev] = fn; }, connect(ws) { this.clients.add(ws); handlers.connection(ws); } };
  }
  function fakeWs() {
    const handlers = {};
    return {
      readyState: 1, sent: [],
      send(d) { this.sent.push(JSON.parse(d)); },
      on: (ev, fn) => { handlers[ev] = fn; },
      emit: (ev, data) => handlers[ev]?.(data),
    };
  }

  it('delivers updates only to sockets watching that demo call', () => {
    const wss = fakeWss();
    const broadcast = attachLiveHub(wss, { canWatch: (id) => getCall(id)?.source === 'demo' });
    const demoA = createCall({ memberId: SEED.id, callerPhone: '+66819990001', aiNumber: SEED.aiNumber, source: 'demo' });
    const demoB = createCall({ memberId: SEED.id, callerPhone: '+66819990002', aiNumber: SEED.aiNumber, source: 'demo' });
    const real = memberCall();
    const wsA = fakeWs(); const wsIdle = fakeWs(); const wsSnoop = fakeWs();
    wss.connect(wsA); wss.connect(wsIdle); wss.connect(wsSnoop);
    wsA.emit('message', Buffer.from(JSON.stringify({ type: 'watch', callId: demoA.id })));
    wsSnoop.emit('message', Buffer.from(JSON.stringify({ type: 'watch', callId: real.id })));
    wsSnoop.emit('message', Buffer.from('not json'));
    broadcast({ type: 'call-update', call: getCall(demoA.id) });
    broadcast({ type: 'call-update', call: getCall(demoB.id) });
    broadcast({ type: 'call-update', call: getCall(real.id) });
    const updates = (ws) => ws.sent.filter((m) => m.type === 'call-update').map((m) => m.call.id);
    assert.deepEqual(updates(wsA), [demoA.id]);
    assert.deepEqual(updates(wsIdle), []);
    assert.deepEqual(updates(wsSnoop), []);
    [demoA, demoB, real].forEach((c) => deleteCall(c.id));
  });
});
