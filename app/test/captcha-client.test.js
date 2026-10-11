// Client captcha helper (public/site.js): token fetch, failure modes, and
// demo-start error copy. DOM/fetch are thin stubs — the logic under test
// (caching, fail-closed '', message mapping) is the real module code.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

let n = 0;
const freshSite = () => import(`../public/site.js?case=${(n += 1)}`);

const realFetch = global.fetch;
const realWindow = global.window;
const realDocument = global.document;
const realLocalStorage = global.localStorage;

function stubBrowser({ siteKey = 'test-key', scriptOk = true, executeImpl = null, statusOk = true } = {}) {
  const seen = { scripts: 0, executed: [] };
  global.fetch = async () => {
    if (!statusOk) throw new Error('offline');
    return { ok: true, json: async () => ({ recaptchaSiteKey: siteKey }) };
  };
  global.window = {};
  global.document = {
    createElement: () => ({ async: false, defer: false, src: '', onload: null, onerror: null }),
    head: {
      appendChild: (el) => {
        seen.scripts += 1;
        queueMicrotask(() => {
          if (scriptOk) {
            global.window.grecaptcha = {
              ready: (cb) => cb(),
              execute: executeImpl || (async (key, { action } = {}) => {
                seen.executed.push({ key, action });
                return `tok-${action}`;
              }),
            };
            el.onload();
          } else {
            el.onerror();
          }
        });
        return el;
      },
    },
  };
  const store = new Map();
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  return seen;
}

beforeEach(() => stubBrowser());

afterEach(() => {
  global.fetch = realFetch;
  global.window = realWindow;
  global.document = realDocument;
  global.localStorage = realLocalStorage;
});

describe('captchaToken', () => {
  it('returns a fresh token per call and passes the action through', async () => {
    const { captchaToken } = await freshSite();
    assert.equal(await captchaToken('demo_call'), 'tok-demo_call');
    assert.equal(await captchaToken('other'), 'tok-other');
  });

  it('loads the challenge script once across calls', async () => {
    const seen = stubBrowser();
    const { captchaToken } = await freshSite();
    await captchaToken('demo_call');
    await captchaToken('demo_call');
    assert.equal(seen.scripts, 1);
    assert.equal(seen.executed.length, 2); // but executes (single-use tokens) every time
  });

  it('returns empty without touching the DOM when the gate is disabled', async () => {
    const seen = stubBrowser({ siteKey: '' });
    const { captchaToken } = await freshSite();
    assert.equal(await captchaToken('demo_call'), '');
    assert.equal(seen.scripts, 0);
  });

  it('fails closed to empty on script error, execute throw, and offline status', async () => {
    stubBrowser({ scriptOk: false });
    assert.equal(await (await freshSite()).captchaToken('demo_call'), '');
    stubBrowser({ executeImpl: async () => { throw new Error('denied'); } });
    assert.equal(await (await freshSite()).captchaToken('demo_call'), '');
    stubBrowser({ statusOk: false });
    assert.equal(await (await freshSite()).captchaToken('demo_call'), '');
  });
});

describe('demoStartMessage', () => {
  it('maps rate-limit and captcha failures to honest copy (th/en)', async () => {
    const { demoStartMessage } = await freshSite();
    assert.match(demoStartMessage({ data: { error: 'demo-rate-limited' } }), /โควตาชั่วโมงนี้/);
    assert.match(demoStartMessage({ data: { error: 'captcha-required' } }), /adblock/);
    assert.match(demoStartMessage({ data: { error: 'captcha-score' } }), /บอท/);
    assert.equal(demoStartMessage({ data: { error: 'boom' } }), null);
    assert.equal(demoStartMessage(null), null);
    global.localStorage.setItem('krai-a_lang', 'en');
    assert.match(demoStartMessage({ data: { error: 'demo-rate-limited' } }), /quota is full/);
    assert.match(demoStartMessage({ data: { error: 'captcha-failed' } }), /bot/);
  });
});
