// Engine health from REAL outcomes: every live Jev/Gemini call and every
// probe records ok/fail here. "ok" means the last thing we observed worked,
// not that a key exists. Error strings are our own codes (no URLs, no keys).
export const PROBE_EVERY_MS = 10 * 60_000;

export function createStatus({ now, describe }) {
  const rec = {
    jev: { lastOkAt: null, lastErrorAt: null, lastError: null, latencyMs: null, last: null },
    gemini: { lastOkAt: null, lastErrorAt: null, lastError: null, latencyMs: null, last: null },
  };
  const iso = (t) => (t == null ? null : new Date(t).toISOString());

  return {
    ok(engine, latencyMs = null) {
      rec[engine].lastOkAt = now();
      rec[engine].last = 'ok';
      if (latencyMs != null) rec[engine].latencyMs = latencyMs;
    },
    fail(engine, err) {
      rec[engine].lastErrorAt = now();
      rec[engine].last = 'fail';
      rec[engine].lastError = String(err?.message || err || 'error').slice(0, 80);
    },
    // Last time we learned anything about this engine (call or probe).
    checkedAt(engine) {
      const r = rec[engine];
      return Math.max(r.lastOkAt ?? -Infinity, r.lastErrorAt ?? -Infinity);
    },
    snapshot() {
      const d = describe(); // { jev:{model,configured}, gemini:{model,configured} }
      const one = (engine) => {
        const r = rec[engine];
        const healthy = r.last === 'ok'; // order of outcomes, not ms timestamps (they tie)
        return {
          model: d[engine].model,
          configured: d[engine].configured,
          ok: Boolean(d[engine].configured && healthy),
          lastOkAt: iso(r.lastOkAt),
          lastError: d[engine].configured ? r.lastError : 'not-configured',
          lastErrorAt: iso(r.lastErrorAt),
          latencyMs: r.latencyMs,
        };
      };
      const jev = one('jev');
      const gemini = one('gemini');
      const mode = jev.ok && gemini.ok ? 'live' : jev.ok || gemini.ok ? 'degraded' : 'rules';
      return { mode, jev, gemini, checkedAt: new Date(now()).toISOString() };
    },
  };
}
