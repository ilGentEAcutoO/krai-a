// SITE_MODE (TASK-027): one codebase, two roles. demo = the hackathon site
// (call demo at /, live talk, public stats/status only — every member, pay,
// LINE, Twilio, OTP and Stripe route is 404, product pages bounce to the
// business host). product = the full business app (default).
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { siteMode, productBaseUrl, demoAllows, siteModeGate, persistDoc } from '../src/siteMode.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const saved = { mode: process.env.SITE_MODE, base: process.env.PRODUCT_BASE_URL, doc: process.env.PERSIST_DOC };
const restore = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
afterEach(() => { restore('SITE_MODE', saved.mode); restore('PRODUCT_BASE_URL', saved.base); restore('PERSIST_DOC', saved.doc); });

describe('siteMode()', () => {
  it('is product unless SITE_MODE=demo (read per call)', () => {
    delete process.env.SITE_MODE;
    assert.equal(siteMode(), 'product');
    process.env.SITE_MODE = 'demo';
    assert.equal(siteMode(), 'demo');
    process.env.SITE_MODE = ' DEMO ';
    assert.equal(siteMode(), 'demo');
    process.env.SITE_MODE = 'nonsense';
    assert.equal(siteMode(), 'product');
  });

  it('product base defaults to krai-a.com and drops a trailing slash', () => {
    delete process.env.PRODUCT_BASE_URL;
    assert.equal(productBaseUrl(), 'https://krai-a.com');
    process.env.PRODUCT_BASE_URL = 'https://x.run.app/';
    assert.equal(productBaseUrl(), 'https://x.run.app');
  });

  it('persists each role to its own Firestore doc (PERSIST_DOC overrides, "off" disables)', () => {
    delete process.env.PERSIST_DOC;
    delete process.env.SITE_MODE;
    assert.equal(persistDoc(), 'krai/snapshot');
    process.env.SITE_MODE = 'demo';
    assert.equal(persistDoc(), 'krai/hackathon');
    process.env.PERSIST_DOC = 'krai/other';
    assert.equal(persistDoc(), 'krai/other');
    process.env.PERSIST_DOC = 'off';
    assert.equal(persistDoc(), null);
    process.env.PERSIST_DOC = '../evil';
    assert.equal(persistDoc(), null, 'only collection/doc ids');
  });
});

describe('demoAllows(path)', () => {
  it('allows the demo, live talk, public stats and status APIs', () => {
    for (const p of ['/api/live/session', '/api/status', '/api/stats', '/api/demo/scripts', '/api/demo/call',
      '/api/analyze', '/api/calls', '/api/calls/abc', '/api/tts', '/api/csp-report', '/API/Status/', '//api//live//session']) {
      assert.ok(demoAllows(p), p);
    }
  });
  it('blocks member, pay, LINE, Twilio, OTP and Stripe routes in any spelling', () => {
    for (const p of ['/api/members', '/api/me', '/api/me/household', '/API/ME', '/api/me/', '//api/me', '/api/auth/request-otp',
      '/api/auth/line-verify', '/api/plans', '/api/billing/checkout', '/api/billing/webhook', '/api/withdraw',
      '/api/withdraw/request-otp', '/api/watchers/link', '/voice/incoming', '/VOICE/status', '/line/webhook',
      '/api/statusx', '/api/livex', '/api']) {
      assert.equal(demoAllows(p), false, p);
    }
  });
});

describe('siteModeGate()', () => {
  let server; let base; let dir;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitemode-'));
    fs.writeFileSync(path.join(dir, 'index.html'), 'BUSINESS');
    fs.writeFileSync(path.join(dir, 'demo.html'), 'HACKATHON');
    fs.writeFileSync(path.join(dir, 'pricing.html'), 'PRICING');
    fs.writeFileSync(path.join(dir, 'site.css'), 'body{}');
    const app = express();
    app.use(siteModeGate({ publicDir: dir }));
    app.get('/health', (req, res) => res.json({ ok: true }));
    app.all(/^\/(api|voice|line)\//i, (req, res) => res.json({ reached: req.path }));
    app.get('/features.html', (req, res) => res.redirect(301, '/#family'));
    app.use(express.static(dir));
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const get = (p, method = 'GET') => fetch(`${base}${p}`, { method, redirect: 'manual' });

  it('product mode changes nothing: / is the business page, /demo.html keeps working, APIs reach their routers', async () => {
    delete process.env.SITE_MODE;
    assert.equal(await (await get('/')).text(), 'BUSINESS');
    assert.equal(await (await get('/demo.html')).text(), 'HACKATHON');
    assert.equal(await (await get('/pricing.html')).text(), 'PRICING');
    assert.deepEqual(await (await get('/api/me')).json(), { reached: '/api/me' });
    assert.deepEqual(await (await get('/voice/incoming', 'POST')).json(), { reached: '/voice/incoming' });
  });

  it('demo mode serves the hackathon page at / (GET and HEAD) and at /demo.html', async () => {
    process.env.SITE_MODE = 'demo';
    const r = await get('/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.equal(await r.text(), 'HACKATHON');
    assert.equal((await get('/', 'HEAD')).status, 200);
    assert.equal(await (await get('/demo.html')).text(), 'HACKATHON');
    assert.equal(await (await get('/site.css')).text(), 'body{}', 'assets still served');
    assert.equal((await get('/health')).status, 200);
  });

  it('demo mode 404s every member/pay/LINE/Twilio route in JSON, before any router runs', async () => {
    process.env.SITE_MODE = 'demo';
    for (const [p, m] of [['/api/members', 'GET'], ['/api/me', 'GET'], ['/API/me/household', 'GET'], ['/api/auth/request-otp', 'POST'],
      ['/api/billing/webhook', 'POST'], ['/voice/incoming', 'POST'], ['/line/webhook', 'POST'], ['/api/plans', 'GET']]) {
      const r = await get(p, m);
      assert.equal(r.status, 404, p);
      assert.deepEqual(await r.json(), { error: 'not found' }, p);
    }
    assert.deepEqual(await (await get('/api/status')).json(), { reached: '/api/status' });
    assert.deepEqual(await (await get('/api/live/session', 'POST')).json(), { reached: '/api/live/session' });
  });

  it('demo mode sends product pages to the business host, same path + query', async () => {
    process.env.SITE_MODE = 'demo';
    delete process.env.PRODUCT_BASE_URL;
    for (const p of ['/pricing.html', '/start.html?plan=family-199', '/dashboard.html', '/index.html', '/liff.html',
      '/withdraw.html', '/features.html', '/Pricing.HTML']) {
      const r = await get(p);
      assert.equal(r.status, 302, p);
      assert.equal(r.headers.get('location'), `https://krai-a.com${p}`, p);
    }
  });

  it('the redirect never leaves the business host', async () => {
    process.env.SITE_MODE = 'demo';
    const r = await get('//evil.example/pricing.html');
    if (r.status === 302) assert.ok(r.headers.get('location').startsWith('https://krai-a.com/'), r.headers.get('location'));
  });
});

describe('server wiring', () => {
  const src = fs.readFileSync(path.join(HERE, '../src/server.js'), 'utf8');
  it('mounts the gate before Twilio, LINE, the API routers and static files', () => {
    const gate = src.indexOf('app.use(siteModeGate(');
    assert.ok(gate > 0, 'siteModeGate mounted');
    for (const later of ["app.use('/voice'", "app.post('/line/webhook'", "app.use('/api', demoRouter", 'app.use(express.static']) {
      assert.ok(src.indexOf(later) > gate, `${later} after the gate`);
    }
  });
  it('demo mode skips member jobs', () => {
    assert.match(src, /siteMode\(\) === 'product'[^\n]*startJobs\(\)|if \(siteMode\(\) === 'product'\) startJobs\(\)/);
  });
});

describe('persistence follows the role', () => {
  it('boot load and flush use only the role doc', async () => {
    const { _setDb } = await import('../src/persist/firestore.js');
    const { bootLoad, flush } = await import('../src/persist/index.js');
    const touched = [];
    _setDb({ doc: (p) => ({ get: async () => { touched.push(`get ${p}`); return { exists: false }; }, set: async () => { touched.push(`set ${p}`); } }) });
    try {
      process.env.SITE_MODE = 'demo';
      delete process.env.PERSIST_DOC;
      await bootLoad();
      await flush();
      assert.deepEqual(touched, ['get krai/hackathon', 'set krai/hackathon']);
      process.env.PERSIST_DOC = 'off';
      await bootLoad();
      await flush();
      assert.equal(touched.length, 2, 'off = no Firestore at all');
    } finally { _setDb(null); }
  });
});
