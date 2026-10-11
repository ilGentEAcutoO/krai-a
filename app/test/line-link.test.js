// LINE link flow: /auth/line-verify needsLink + POST /me/link-line.
// HTTP-level over an ephemeral port; LINE verify API is mocked via fetch.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { demoRouter } from '../src/routes.js';
import { addMember, listMembers, getMemberById } from '../src/store.js';
import { createSession } from '../src/auth.js';
import { assignNumber } from '../src/numbers.js';

const realFetch = global.fetch;
// idToken "tok-<sub>" verifies as LINE user <sub>; anything else is rejected.
global.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.line.me/oauth2/v2.1/verify')) {
    const idToken = new URLSearchParams(opts?.body?.toString() || '').get('id_token') || '';
    if (idToken.startsWith('tok-') && idToken.length > 4) {
      const sub = idToken.slice(4);
      return { ok: true, json: async () => ({ sub, name: 'Test', picture: '' }) };
    }
    return { ok: false, status: 400, json: async () => ({ error: 'invalid_token' }) };
  }
  return realFetch(url, opts);
};

let base = '';
let server;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', demoRouter(() => {}));
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  global.fetch = realFetch;
  await new Promise((r) => server.close(r));
});

const post = async (path, body, token) => {
  const r = await realFetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, json: await r.json() };
};

async function freshMember(phone) {
  const num = await assignNumber();
  assert.ok(num.ok);
  return addMember({ ownerPhone: phone, aiNumber: num.number });
}

describe('line-verify + link-line', () => {
  it('unknown LINE id returns needsLink and creates no orphan member', async () => {
    const beforeN = listMembers().length;
    const r = await post('/api/auth/line-verify', { idToken: 'tok-U_NEWBIE' });
    assert.equal(r.status, 200);
    assert.equal(r.json.needsLink, true);
    assert.equal(r.json.token, undefined);
    assert.equal(listMembers().length, beforeN); // no orphan with empty ownerPhone
  });

  it('link-line binds LINE id to the current phone member', async () => {
    const m = await freshMember('+66810001111');
    const token = createSession(m.id);
    const r = await post('/api/me/link-line', { idToken: 'tok-U_LINKME' }, token);
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.member.lineUserId, 'U_LINKME');
    assert.equal(getMemberById(m.id).lineUserId, 'U_LINKME');
    // Same LINE id now logs straight in.
    const login = await post('/api/auth/line-verify', { idToken: 'tok-U_LINKME' });
    assert.equal(login.status, 200);
    assert.ok(login.json.token);
    assert.equal(login.json.member.id, m.id);
  });

  it('link-line 409 when the LINE id belongs to a different member', async () => {
    const a = await freshMember('+66810002222');
    const b = await freshMember('+66810003333');
    const tokA = createSession(a.id);
    const tokB = createSession(b.id);
    assert.equal((await post('/api/me/link-line', { idToken: 'tok-U_TAKEN' }, tokA)).status, 200);
    const r = await post('/api/me/link-line', { idToken: 'tok-U_TAKEN' }, tokB);
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'line-already-linked');
    assert.equal(getMemberById(b.id).lineUserId, ''); // loser keeps no binding
  });

  it('link-line re-link by the same member is idempotent', async () => {
    const m = await freshMember('+66810004444');
    const token = createSession(m.id);
    assert.equal((await post('/api/me/link-line', { idToken: 'tok-U_SAME' }, token)).status, 200);
    assert.equal((await post('/api/me/link-line', { idToken: 'tok-U_SAME' }, token)).status, 200);
  });

  it('link-line requires phone session and a valid idToken', async () => {
    const m = await freshMember('+66810005555');
    const token = createSession(m.id);
    assert.equal((await post('/api/me/link-line', { idToken: 'tok-U_X' })).status, 401);
    assert.equal((await post('/api/me/link-line', {}, token)).status, 401);
    assert.equal((await post('/api/me/link-line', { idToken: 'bogus' }, token)).status, 401);
  });
});
