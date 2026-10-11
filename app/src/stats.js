// Public trust stats: cumulative counters + brag-gate thresholds.
//
// Counters are monotonic and live apart from call records, so PDPA
// retention purges (store.purgeCalls) never shrink the public totals.
// Only REAL screened calls (source !== 'demo') feed the public numbers;
// demo sessions are counted separately for ops and never shown.
//
// Display rule: a metric is shown only when it clears its minimum
// (STATS_MIN) — "12 calls screened" would embarrass, not impress — and
// the shown figure is floored to a round tier, always rendered with
// "กว่า" (more than), so the claim stays honest at every size.
const counters = {
  calls: 0, // real ended calls with a verdict
  scams: 0, // verdict SCAM
  legit: 0, // verdict LEGIT
  unsure: 0, // verdict UNSURE (or ended without one)
  minutes: 0, // sum of minutesBilled on real ended calls
  households: 0, // members joined (seed/demo excluded by caller)
  demo: 0, // demo sessions ended — internal only, never public
};

// Brag-gate minimums: the smallest value worth showing per metric.
// Rationale: triple digits prove a real system (calls), mid-double digits
// tell a story for sub-counts (scams/legit/households), and ~8h of talk
// time (minutes) reads as genuine work done — anything smaller hides.
export const STATS_MIN = {
  calls: 100,
  scams: 50,
  legit: 50,
  minutes: 500,
  households: 50,
};

const TIERS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];

// Largest round tier at or below n (0 when below the first tier).
// Past the last tier, floor to whole millions.
export function floorTier(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (v >= 1000000) return Math.floor(v / 1000000) * 1000000;
  let t = 0;
  for (const tier of TIERS) {
    if (tier > v) break;
    t = tier;
  }
  return t;
}

function asCount(v) {
  const n = Math.floor(Number(v) || 0);
  return n < 0 ? 0 : n;
}

export function recordCallEnd(call) {
  if (!call || !call.endedAt) return;
  if (call.source === 'demo') {
    counters.demo += 1;
    return;
  }
  counters.calls += 1;
  counters.minutes += Math.max(0, Math.floor(Number(call.minutesBilled) || 0));
  const v = call.verdict?.verdict;
  if (v === 'SCAM') counters.scams += 1;
  else if (v === 'LEGIT') counters.legit += 1;
  else counters.unsure += 1;
}

export function recordMemberJoin() {
  counters.households += 1;
}

// Rebuild counters from restored call records — used only when a snapshot
// predates stats (fresh deploys over old data keep honest totals).
export function backfillFromCalls(callList) {
  for (const c of callList || []) {
    if (c?.endedAt) recordCallEnd(c);
  }
}

export function snapshotStats() {
  return { ...counters };
}

// Restore validates every field: a tampered/hand-edited snapshot must not
// inject NaN, negatives, or strings into the public numbers.
export function restoreStats(snap) {
  for (const k of Object.keys(counters)) counters[k] = asCount(snap?.[k]);
}

// Test-only reset (fresh counters per test file run).
export function resetStats() {
  for (const k of Object.keys(counters)) counters[k] = 0;
}

function metric(value, min) {
  const v = asCount(value);
  const shown = v >= min;
  return { value: v, display: shown ? floorTier(v) : 0, shown };
}

// Aggregate-only payload for GET /api/stats — no per-member,
// per-number, or per-call data ever leaves this endpoint (PDPA-safe).
export function getPublicStats() {
  const calls = metric(counters.calls, STATS_MIN.calls);
  return {
    updatedAt: new Date().toISOString(),
    calls,
    scams: metric(counters.scams, STATS_MIN.scams),
    legit: metric(counters.legit, STATS_MIN.legit),
    minutes: metric(counters.minutes, STATS_MIN.minutes),
    households: metric(counters.households, STATS_MIN.households),
    // Share of screened calls judged SCAM — shown only when the base
    // (calls) is big enough for the ratio to mean something.
    scamRate: {
      value: counters.calls > 0 ? counters.scams / counters.calls : 0,
      shown: calls.shown,
    },
  };
}
