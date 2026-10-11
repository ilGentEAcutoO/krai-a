// LINE webhook + ID-token verify: signature rejection (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.LINE_CHANNEL_SECRET = 'x'.repeat(32);
process.env.LINE_LOGIN_CHANNEL_ID = '2008922436';
const { lineWebhookHandler } = await import('../src/line/webhook.js');
const { verifyLineIdToken } = await import('../src/line/verify.js');

function req(body, sig) {
  const raw = Buffer.from(body);
  return { rawBody: raw, body: JSON.parse(body), headers: { 'x-line-signature': sig } };
}
function res() {
  return { code: 0, json(o) { this.body = o; return this; }, status(c) { this.code = c; return this; } };
}

test('LINE webhook: bad signature rejected', async () => {
  const body = JSON.stringify({ events: [] });
  const r = res();
  await lineWebhookHandler(req(body, 'bogus'), r);
  assert.equal(r.code, 401);
});

test('LINE webhook: missing signature rejected', async () => {
  const body = JSON.stringify({ events: [] });
  const r = res();
  await lineWebhookHandler({ rawBody: Buffer.from(body), body: JSON.parse(body), headers: {} }, r);
  assert.equal(r.code, 401);
});

test('LINE webhook: valid empty events 200', async () => {
  const body = JSON.stringify({ events: [] });
  const sig = crypto.createHmac('sha256', 'x'.repeat(32)).update(body).digest('base64');
  const r = res();
  await lineWebhookHandler(req(body, sig), r);
  assert.equal(r.body.ok, true);
});

test('verifyLineIdToken: missing token fails closed', async () => {
  const r = await verifyLineIdToken('');
  assert.equal(r.ok, false);
});

test('config: liffId default matches Pa-Nual LIFF', async () => {
  const { config } = await import('../src/config.js');
  assert.equal(config.liffId, '2008922436-G2kWQbrj');
});
