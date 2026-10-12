// Accuracy / latency / cost eval for the judge (real Jev + Gemini, local keys).
// Plays every call in test/fixtures/eval-calls.json turn by turn, exactly like
// a call: judgeTurn after each caller line, nextAction decides whether the
// call goes on (hangup / take-message end it). The receptionist line between
// caller turns is the judge's own canned line (free) unless --persona asks for
// the real personaReply. The 5 demo scripts always run with the real persona,
// so the persona's cost is measured too. Token usage comes from the API
// responses themselves (a metering fetch injected into createJudge).
// Usage: npm run eval [-- --persona] [--only id,id] [--repeat N] [--no-demo] [--out dir]
//        npm run eval -- --resummarize   (rewrite summary.md from results.json, no API calls)
// Production model: GEMINI_MODEL=gemini-3.5-flash-lite npm run eval (app/.env may pin another).
// Costs real money (well under $1 per run): never part of `npm test`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { SCRIPTS } from '../src/demoScripts.js';
import { createJudge, nextAction, openingLine } from '../src/judge/index.js';
import { JEV_URL } from '../src/judge/jev.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATASET = path.join(APP, 'test', 'fixtures', 'eval-calls.json');

// USD per 1M tokens, checked 2026-10-12. Gemini output includes thinking tokens.
const PRICING = {
  checkedAt: '2026-10-12',
  sources: {
    jev: 'https://docs.typesafe.ai/models.md ($42 per billion input tokens, output free)',
    gemini: 'https://ai.google.dev/gemini-api/docs/pricing (paid tier, page updated 2026-10-09)',
  },
  jev: { input: 0.042, output: 0 },
  gemini: {
    'gemini-3.8-flash': { input: 0.75, output: 3.75, note: 'launch price until 2026-12-31; $1.50 / $7.50 from 2027-01-01' },
    'gemini-3.5-flash-lite': { input: 0.30, output: 2.50 },
  },
  thbPerUsd: 35, // same rate as instruction/work/biz-v2.html
};

function parseArgs(argv) {
  const a = { persona: false, demo: true, repeat: 1, only: null, resummarize: false, out: path.resolve(APP, '..', 'agent-temp', 'eval') };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--persona') a.persona = true;
    else if (k === '--no-demo') a.demo = false;
    else if (k === '--resummarize') a.resummarize = true;
    else if (k === '--repeat') a.repeat = Math.max(1, Number(argv[++i]) || 1);
    else if (k === '--only') a.only = new Set(String(argv[++i] || '').split(',').filter(Boolean));
    else if (k === '--out') a.out = path.resolve(argv[++i]);
  }
  return a;
}

// ---- metering fetch: counts tokens per engine from the real responses ----
function createMeter() {
  const blank = () => ({ jev: { calls: 0, input: 0, output: 0 }, gemini: {}, errors: [] });
  let cur = blank();
  async function meteredFetch(url, init = {}) {
    const u = String(url);
    const engine = u.startsWith(JEV_URL) ? 'jev' : 'gemini';
    const counted = (init.method || 'GET') !== 'GET'; // GETs are free health probes
    let res;
    try {
      res = await globalThis.fetch(url, init);
    } catch (e) {
      if (counted) cur.errors.push(`${engine}-${e.name === 'AbortError' ? 'timeout' : 'network'}`);
      throw e;
    }
    if (!counted) return res;
    if (!res.ok) {
      cur.errors.push(`${engine}-http-${res.status}`);
      return res;
    }
    try {
      const body = await res.clone().json();
      if (engine === 'jev') {
        cur.jev.calls += 1;
        cur.jev.input += Number(body?.usage?.input_tokens) || 0;
        cur.jev.output += Number(body?.usage?.output_tokens) || 0;
      } else {
        const model = (u.match(/models\/([^:/]+):/) || [])[1] || 'gemini';
        const g = (cur.gemini[model] ||= { calls: 0, input: 0, output: 0 });
        const m = body?.usageMetadata || {};
        g.calls += 1;
        g.input += Number(m.promptTokenCount) || 0;
        g.output += (Number(m.candidatesTokenCount) || 0) + (Number(m.thoughtsTokenCount) || 0);
      }
    } catch {
      // unreadable body: the judge will record its own failure
    }
    return res;
  }
  return { fetch: meteredFetch, take() { const t = cur; cur = blank(); return t; } };
}

function usd(u) {
  let total = (u.jev.input * PRICING.jev.input + u.jev.output * PRICING.jev.output) / 1e6;
  for (const [model, g] of Object.entries(u.gemini)) {
    const p = PRICING.gemini[model] || PRICING.gemini[config.geminiModel];
    total += (g.input * p.input + g.output * p.output) / 1e6;
  }
  return total;
}

function addUsage(a, b) {
  const out = { jev: { ...a.jev }, gemini: JSON.parse(JSON.stringify(a.gemini)), errors: [...a.errors, ...b.errors] };
  for (const k of ['calls', 'input', 'output']) out.jev[k] += b.jev[k];
  for (const [m, g] of Object.entries(b.gemini)) {
    const t = (out.gemini[m] ||= { calls: 0, input: 0, output: 0 });
    for (const k of ['calls', 'input', 'output']) t[k] += g[k];
  }
  return out;
}
const emptyUsage = () => ({ jev: { calls: 0, input: 0, output: 0 }, gemini: {}, errors: [] });

// 'rule' | 'jev' | 'jev>gemini' (Jev unsure, Gemini decided) | 'gemini-only' (Jev unavailable) | 'rules-fallback'
const pathOf = (v) => (v.engine === 'gemini' ? (v.probabilities ? 'jev>gemini' : 'gemini-only') : v.engine);

// ---- one call, turn by turn ----
async function runCall(c, { judge, offline, meter, persona }) {
  const turns = [{ role: 'ai', text: openingLine(c.lang) }];
  const log = [];
  let endedBy = 'script-end';
  for (let i = 0; i < c.turns.length; i++) {
    turns.push({ role: 'caller', text: c.turns[i] });
    meter.take();
    const v = await judge.judgeTurn({ turns, lang: c.lang });
    const judgeUsage = meter.take();
    const action = nextAction(v, i + 1, { maxTurns: config.maxTurnsPerCall });
    const p = await (persona ? judge : offline).personaReply({ turns, verdict: v, lang: c.lang, action });
    const personaUsage = meter.take();
    turns.push({ role: 'ai', text: p.text });
    log.push({
      turn: i + 1,
      caller: c.turns[i],
      verdict: v.verdict,
      confidence: v.confidence,
      engine: v.engine,
      path: pathOf(v),
      model: v.model || null,
      latencyMs: v.latencyMs,
      probabilities: v.probabilities || null,
      signals: v.signals,
      reasonEn: v.reasonEn,
      reasonEngine: v.reasonEngine,
      action,
      ai: p.text,
      personaEngine: p.engine,
      personaMs: p.latencyMs,
      usage: { judge: judgeUsage, persona: personaUsage },
      usd: { judge: usd(judgeUsage), persona: usd(personaUsage) },
    });
    if (action !== 'continue') {
      endedBy = action;
      break;
    }
  }
  const final = log[log.length - 1];
  const okSet = [c.class, ...(c.alsoOk || [])];
  // Turns-to-correct: first caller turn from which the verdict stayed correct.
  let ttc = null;
  if (final.verdict === c.class) {
    ttc = log.length;
    for (let k = log.length - 1; k >= 0 && log[k].verdict === c.class; k--) ttc = k + 1;
  }
  return {
    id: c.id,
    class: c.class,
    alsoOk: c.alsoOk || [],
    lang: c.lang,
    category: c.category,
    tags: c.tags || [],
    expertTurn: c.expertTurn,
    scriptTurns: c.turns.length,
    final: final.verdict,
    finalConfidence: final.confidence,
    ok: final.verdict === c.class,
    safe: okSet.includes(final.verdict),
    endedBy,
    turnsPlayed: log.length,
    turnsToCorrect: ttc,
    lagVsExpert: ttc == null ? null : ttc - c.expertTurn,
    usd: { judge: log.reduce((s, t) => s + t.usd.judge, 0), persona: log.reduce((s, t) => s + t.usd.persona, 0) },
    turns: log,
  };
}

// ---- stats ----
const sorted = (xs) => xs.filter(Number.isFinite).sort((a, b) => a - b);
function pct(xs, q) {
  const a = sorted(xs);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1))]; // nearest rank
}
const median = (xs) => pct(xs, 0.5);
const mean = (xs) => { const a = sorted(xs); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; };
const ratio = (n, d) => (d ? Math.round((n / d) * 1000) / 1000 : null);
const r4 = (x) => (x == null ? null : Math.round(x * 1e4) / 1e4);
const CLASSES = ['SCAM', 'LEGIT', 'UNSURE'];

// Wilson 95% interval: an honest range for a rate measured on a small n.
function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.round(Math.max(0, mid - half) * 1000) / 1000, Math.round(Math.min(1, mid + half) * 1000) / 1000];
}

function computeMetrics(results) {
  const n = results.length;
  const by = (cls) => results.filter((r) => r.class === cls);
  const confusion = Object.fromEntries(CLASSES.map((e) => [e, Object.fromEntries(CLASSES.map((p) => [p, results.filter((r) => r.class === e && r.final === p).length]))]));
  const predictedScam = results.filter((r) => r.final === 'SCAM').length;
  const scam = by('SCAM');
  const legit = by('LEGIT');
  const unsure = by('UNSURE');
  const allTurns = results.flatMap((r) => r.turns);

  const latency = {};
  for (const t of allTurns) (latency[t.path] ||= []).push(t.latencyMs);
  const latencyByPath = Object.fromEntries(Object.entries(latency).map(([k, v]) => [k, { turns: v.length, share: ratio(v.length, allTurns.length), medianMs: median(v), p90Ms: pct(v, 0.9) }]));

  const tagged = {};
  for (const r of results) for (const tag of r.tags) (tagged[tag] ||= []).push(r);

  const judgeUsd = results.map((r) => r.usd.judge);
  const correctScam = scam.filter((r) => r.ok);
  return {
    calls: n,
    turns: allTurns.length,
    byClass: Object.fromEntries(CLASSES.map((c) => [c, by(c).length])),
    byLang: { th: results.filter((r) => r.lang === 'th').length, en: results.filter((r) => r.lang === 'en').length },
    confusion, // confusion[expected][predicted]
    accuracy: ratio(CLASSES.reduce((s, c) => s + confusion[c][c], 0), n),
    safeAccuracy: ratio(results.filter((r) => r.safe).length, n),
    scam: {
      recall: ratio(confusion.SCAM.SCAM, scam.length),
      recallCi95: wilson(confusion.SCAM.SCAM, scam.length),
      precision: ratio(confusion.SCAM.SCAM, predictedScam),
      precisionVsLegit: ratio(confusion.SCAM.SCAM, confusion.SCAM.SCAM + confusion.LEGIT.SCAM),
      missedAsLegit: scam.filter((r) => r.final === 'LEGIT').map((r) => r.id),
      missedAsUnsure: scam.filter((r) => r.final === 'UNSURE').map((r) => r.id),
      medianTurnsToCorrect: median(correctScam.map((r) => r.turnsToCorrect)),
      caughtByExpertTurn: ratio(correctScam.filter((r) => r.lagVsExpert <= 0).length, scam.length),
      medianLagVsExpert: median(correctScam.map((r) => r.lagVsExpert)),
      hungUp: ratio(scam.filter((r) => r.endedBy === 'hangup').length, scam.length),
    },
    legit: {
      falseScamAlarm: ratio(confusion.LEGIT.SCAM, legit.length),
      falseScamAlarmCi95: wilson(confusion.LEGIT.SCAM, legit.length),
      falseScamIds: legit.filter((r) => r.final === 'SCAM').map((r) => r.id),
      toUnsure: ratio(confusion.LEGIT.UNSURE, legit.length),
      toUnsureIds: legit.filter((r) => r.final === 'UNSURE').map((r) => r.id),
      medianTurnsToCorrect: median(legit.filter((r) => r.ok).map((r) => r.turnsToCorrect)),
    },
    unsure: {
      keptUnsure: ratio(confusion.UNSURE.UNSURE, unsure.length),
      toScam: unsure.filter((r) => r.final === 'SCAM').map((r) => r.id),
      toLegit: unsure.filter((r) => r.final === 'LEGIT').map((r) => r.id),
    },
    medianTurnsToCorrect: median(results.filter((r) => r.ok).map((r) => r.turnsToCorrect)),
    adversarial: Object.fromEntries(Object.entries(tagged).map(([tag, rs]) => [tag, { n: rs.length, correct: rs.filter((r) => r.ok).length, safe: rs.filter((r) => r.safe).length }])),
    latency: {
      judgeMedianMs: median(allTurns.map((t) => t.latencyMs)),
      judgeP90Ms: pct(allTurns.map((t) => t.latencyMs), 0.9),
      byPath: latencyByPath,
    },
    cost: {
      judgeUsdPerCall: { mean: mean(judgeUsd), median: median(judgeUsd), max: Math.max(...judgeUsd) },
      judgeThbPerCall: { mean: mean(judgeUsd) * PRICING.thbPerUsd, max: Math.max(...judgeUsd) * PRICING.thbPerUsd },
      judgeUsdTotal: judgeUsd.reduce((s, x) => s + x, 0),
      jevTokensPerTurn: median(allTurns.filter((t) => t.usage.judge.jev.calls).map((t) => t.usage.judge.jev.input)),
      geminiEscalations: allTurns.filter((t) => t.path === 'jev>gemini' || t.path === 'gemini-only').length,
    },
    // Jev was unsure -> Gemini asked; a timeout leaves Jev's own (UNSURE) answer.
    escalation: (() => {
      const decided = allTurns.filter((t) => t.path === 'jev>gemini').length;
      const timeouts = allTurns.reduce((s, t) => s + t.usage.judge.errors.filter((e) => e === 'gemini-timeout').length, 0);
      return { attempts: decided + timeouts, decidedByGemini: decided, timeouts, timeoutRate: ratio(timeouts, decided + timeouts) };
    })(),
    serviceErrors: allTurns.flatMap((t) => [...t.usage.judge.errors, ...t.usage.persona.errors]),
  };
}

// Mechanical "why" for a miss: the verdict trail and the evidence behind the last turn.
function diagnose(r) {
  const last = r.turns[r.turns.length - 1];
  const strong = Object.entries(last.signals || {}).filter(([, v]) => v >= 0.5).map(([k, v]) => `${k}=${v}`);
  const p = last.probabilities;
  return {
    id: r.id,
    expected: r.class,
    got: r.final,
    safe: r.safe,
    endedBy: r.endedBy,
    trail: r.turns.map((t) => `${t.verdict}@${t.confidence}/${t.path}`).join(' > '),
    lastCallerTurn: last.caller,
    jevProbabilities: p,
    strongSignals: strong,
    reasonEn: last.reasonEn,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.resummarize) {
    const file = path.join(args.out, 'results.json');
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    o.headline = headline(o.metrics, o.costPerCall);
    fs.writeFileSync(file, JSON.stringify(o, null, 2));
    fs.writeFileSync(path.join(args.out, 'summary.md'), summaryMd(o));
    console.log(o.headline);
    return;
  }
  const ds = JSON.parse(fs.readFileSync(DATASET, 'utf8'));
  const calls = ds.calls.filter((c) => !args.only || args.only.has(c.id));
  const meter = createMeter();
  const judge = createJudge({ fetch: meter.fetch });
  // Same code, AI switched off: its personaReply returns the judge's own canned lines.
  const offline = createJudge({ config: { ...config, aiOffline: true } });

  const status0 = await judge.getEngineStatus({ wait: true });
  console.log(`engines: ${status0.mode} | jev ${status0.jev.ok} ${status0.jev.model} | gemini ${status0.gemini.ok} ${status0.gemini.model} / persona ${config.geminiPersonaModel || config.geminiModel}`);
  if (!status0.jev.ok) console.warn('WARNING: Jev is not reachable; numbers will reflect the fallback path.');

  const t0 = Date.now();
  const runs = [];
  for (let k = 0; k < args.repeat; k++) {
    const results = [];
    for (const c of calls) {
      const r = await runCall(c, { judge, offline, meter, persona: args.persona });
      results.push(r);
      console.log(`${r.ok ? 'OK ' : r.safe ? 'ok~' : 'XX '} ${r.id.padEnd(30)} exp=${r.class.padEnd(6)} got=${r.final.padEnd(6)} ${String(r.finalConfidence).padEnd(5)} end=${r.endedBy.padEnd(12)} | `
        + r.turns.map((t) => `${t.verdict[0]}${Math.round(t.confidence * 100)}/${t.path}/${t.latencyMs}ms`).join('  '));
    }
    runs.push({ run: k + 1, metrics: computeMetrics(results), misses: results.filter((r) => !r.ok).map(diagnose), results });
  }

  // Demo scenarios: the real persona too, as scripts/render-demo.mjs records them.
  let demo = null;
  if (args.demo) {
    const results = [];
    for (const s of SCRIPTS) {
      const c = { id: s.id, class: s.expected, lang: 'th', category: 'demo', expertTurn: 1, turns: s.lines };
      const r = await runCall(c, { judge, offline, meter, persona: true });
      results.push(r);
      console.log(`demo ${r.ok ? 'OK ' : 'XX '} ${r.id.padEnd(16)} exp=${r.class.padEnd(6)} got=${r.final.padEnd(6)} ${r.finalConfidence} end=${r.endedBy} | `
        + r.turns.map((t) => `${t.verdict[0]}${Math.round(t.confidence * 100)}/${t.path}/${t.latencyMs}ms persona=${t.personaEngine}/${t.personaMs}ms`).join('  '));
    }
    demo = {
      correct: results.filter((r) => r.ok).length,
      total: results.length,
      results: results.map((r) => ({
        id: r.id, expected: r.class, final: r.final, confidence: r.finalConfidence, endedBy: r.endedBy, turnsPlayed: r.turnsPlayed,
        trail: r.turns.map((t) => ({ turn: t.turn, verdict: t.verdict, confidence: t.confidence, path: t.path, latencyMs: t.latencyMs, ai: t.ai, personaEngine: t.personaEngine, personaMs: t.personaMs })),
        usd: r.usd,
      })),
      personaTurns: results.flatMap((r) => r.turns),
    };
  }

  // Persona cost per AI line (Gemini Flash-Lite + Jev output guard), measured
  // wherever the real persona ran; scaled to the dataset's turns per call.
  const personaTurns = [
    ...(demo ? demo.personaTurns : []),
    ...(args.persona ? runs.flatMap((r) => r.results.flatMap((x) => x.turns)) : []),
  ].filter((t) => t.personaEngine === 'gemini' || t.usd.persona > 0);
  if (demo) delete demo.personaTurns;
  const personaUsdPerLine = mean(personaTurns.map((t) => t.usd.persona));
  const m = runs[0].metrics;
  const turnsPerCall = mean(runs[0].results.map((r) => r.turnsPlayed));
  const personaUsdPerCall = personaUsdPerLine == null ? null : personaUsdPerLine * turnsPerCall;
  const totalUsdPerCall = m.cost.judgeUsdPerCall.mean + (personaUsdPerCall || 0);

  const allUsage = [...runs.flatMap((r) => r.results), ...(demo ? demo.results : [])];
  const spendUsd = allUsage.reduce((s, r) => s + r.usd.judge + r.usd.persona, 0);
  const status1 = await judge.getEngineStatus({ noWait: true });
  const jevResolved = runs[0].results.flatMap((r) => r.turns).find((t) => t.model)?.model || null;

  const perCall = {
    turnsPerCall: r4(turnsPerCall),
    judgeUsd: m.cost.judgeUsdPerCall.mean,
    personaUsdPerLine,
    personaUsdEstimate: personaUsdPerCall,
    totalUsd: totalUsdPerCall,
    totalThb: totalUsdPerCall * PRICING.thbPerUsd,
    judgeThb: m.cost.judgeUsdPerCall.mean * PRICING.thbPerUsd,
    personaSampleLines: personaTurns.length,
    scope: 'Text AI only (Jev judge + Gemini escalation + Gemini persona + Jev persona guard). Excludes speech-to-text, TTS and telephony.',
  };

  const stability = runs.length > 1 ? (() => {
    const ids = runs[0].results.map((r) => r.id);
    const same = ids.filter((id) => new Set(runs.map((run) => run.results.find((r) => r.id === id).final)).size === 1);
    return { runs: runs.length, sameFinalVerdict: ratio(same.length, ids.length), flipped: ids.filter((id) => !same.includes(id)) };
  })() : null;

  const out = {
    ranAt: new Date().toISOString(),
    wallSeconds: Math.round((Date.now() - t0) / 1000),
    dataset: { file: 'app/test/fixtures/eval-calls.json', version: ds.version, createdAt: ds.createdAt, calls: calls.length, byClass: m.byClass, byLang: m.byLang },
    setup: {
      judge: 'createJudge() from src/judge/index.js with a metering fetch (same code path as judgeTurn)',
      receptionistLines: args.persona ? 'real personaReply' : 'judge canned lines (no AI)',
      jevModel: config.jevModel, jevResolved,
      geminiModel: config.geminiModel, personaModel: config.geminiPersonaModel || config.geminiModel,
      jevTimeoutMs: config.jevTimeoutMs, geminiTurnTimeoutMs: config.geminiTurnTimeoutMs ?? config.geminiTimeoutMs,
      judgeBudgetMs: config.judgeBudgetMs ?? null, replyBudgetMs: config.replyBudgetMs ?? null, maxTurnsPerCall: config.maxTurnsPerCall,
    },
    pricing: PRICING,
    engineStatus: { before: status0, after: status1 },
    headline: headline(m, perCall),
    metrics: m,
    costPerCall: perCall,
    stability,
    misses: runs[0].misses,
    demo,
    spend: { usd: spendUsd, thb: spendUsd * PRICING.thbPerUsd, note: 'Everything this eval run called (all repeats + demo scenarios).' },
    runs: runs.map((r) => ({ run: r.run, metrics: r.run === 1 ? undefined : r.metrics, results: r.results })),
  };
  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(path.join(args.out, 'results.json'), JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(args.out, 'summary.md'), summaryMd(out));
  console.log(`\n${out.headline}`);
  console.log(`spend this run: $${spendUsd.toFixed(4)} (฿${(spendUsd * PRICING.thbPerUsd).toFixed(2)}) · ${out.wallSeconds}s`);
  console.log('wrote', path.join(args.out, 'results.json'), 'and summary.md');
}

const p100 = (x) => (x == null ? 'n/a' : `${Math.round(x * 1000) / 10}%`);
const sec = (ms) => (ms == null ? 'n/a' : `${(ms / 1000).toFixed(ms < 1000 ? 2 : 1)} s`);

function headline(m, perCall) {
  const ci = m.scam.recallCi95 ? `, 95% CI ${p100(m.scam.recallCi95[0])}–${p100(m.scam.recallCi95[1])}` : '';
  return `SCAM recall ${p100(m.scam.recall)} (${m.confusion.SCAM.SCAM}/${m.byClass.SCAM} scam calls${ci}), ${m.confusion.LEGIT.SCAM} of ${m.byClass.LEGIT} legit calls flagged as scam, `
    + `median ${sec(m.latency.judgeMedianMs)} per turn (p90 ${sec(m.latency.judgeP90Ms)}), ~฿${perCall.totalThb.toFixed(2)} text-AI cost per call`;
}

function summaryMd(o) {
  const m = o.metrics;
  const c = m.confusion;
  const lines = [];
  lines.push('# Krai-a judge eval', '');
  lines.push(`Run ${o.ranAt} · dataset v${o.dataset.version} (${o.dataset.createdAt}) · ${o.dataset.calls} calls / ${m.turns} judged turns · ${o.dataset.byLang.th} Thai, ${o.dataset.byLang.en} English`);
  lines.push(`Classes: SCAM ${m.byClass.SCAM} · LEGIT ${m.byClass.LEGIT} · UNSURE ${m.byClass.UNSURE} · engines: Jev ${o.setup.jevModel} (${o.setup.jevResolved}) · Gemini ${o.setup.geminiModel} (escalation) · ${o.setup.personaModel} (persona)`, '');
  lines.push(`**Headline:** ${o.headline}`, '');
  lines.push('## Accuracy', '');
  lines.push('| metric | value |', '|---|---|');
  const ci = (r) => (r ? `${p100(r[0])}–${p100(r[1])}` : 'n/a');
  lines.push(`| SCAM recall | ${p100(m.scam.recall)} (${c.SCAM.SCAM}/${m.byClass.SCAM}; 95% CI ${ci(m.scam.recallCi95)}) |`);
  lines.push(`| SCAM precision (all calls) | ${p100(m.scam.precision)} |`);
  lines.push(`| SCAM precision vs legit only | ${p100(m.scam.precisionVsLegit)} |`);
  lines.push(`| scam missed as LEGIT (worst error) | ${m.scam.missedAsLegit.length} |`);
  lines.push(`| LEGIT false scam alarm | ${p100(m.legit.falseScamAlarm)} (${c.LEGIT.SCAM}/${m.byClass.LEGIT}; 95% CI ${ci(m.legit.falseScamAlarmCi95)}) |`);
  lines.push(`| LEGIT left UNSURE (message taken) | ${p100(m.legit.toUnsure)} |`);
  lines.push(`| UNSURE kept UNSURE | ${p100(m.unsure.keptUnsure)} · to SCAM ${m.unsure.toScam.length} · to LEGIT ${m.unsure.toLegit.length} |`);
  lines.push(`| accuracy (exact class) | ${p100(m.accuracy)} |`);
  lines.push(`| safe outcome (class or listed safe alternative) | ${p100(m.safeAccuracy)} |`);
  lines.push(`| median turns to correct verdict | all ${m.medianTurnsToCorrect} · SCAM ${m.scam.medianTurnsToCorrect} · LEGIT ${m.legit.medianTurnsToCorrect} |`);
  lines.push(`| SCAM caught by the expert's turn | ${p100(m.scam.caughtByExpertTurn)} (median lag ${m.scam.medianLagVsExpert} turns) |`);
  lines.push(`| scam calls hung up by policy | ${p100(m.scam.hungUp)} |`, '');
  lines.push('Confusion matrix (rows = expected, columns = final verdict):', '');
  lines.push('| | SCAM | LEGIT | UNSURE |', '|---|---|---|---|');
  for (const e of CLASSES) lines.push(`| **${e}** | ${c[e].SCAM} | ${c[e].LEGIT} | ${c[e].UNSURE} |`);
  lines.push('');
  lines.push('Adversarial subsets (correct / safe / n):', '');
  for (const [tag, v] of Object.entries(m.adversarial)) lines.push(`- ${tag}: ${v.correct} / ${v.safe} / ${v.n}`);
  lines.push('', '## Latency (judge, per caller turn)', '');
  lines.push(`All turns: median ${sec(m.latency.judgeMedianMs)}, p90 ${sec(m.latency.judgeP90Ms)}`, '');
  lines.push('| path | share of turns | median | p90 |', '|---|---|---|---|');
  for (const [k, v] of Object.entries(m.latency.byPath)) lines.push(`| ${k} | ${p100(v.share)} (${v.turns}) | ${sec(v.medianMs)} | ${sec(v.p90Ms)} |`);
  lines.push('', 'rule = hard rule before any AI · jev = Jev decided (incl. turns where the Gemini escalation timed out) · jev>gemini = Jev unsure, Gemini decided · gemini-only = Jev unavailable', '');
  lines.push(`Gemini escalations: ${m.escalation.attempts} attempts, ${m.escalation.decidedByGemini} answered, ${m.escalation.timeouts} timed out (${p100(m.escalation.timeoutRate)}) at the ${o.setup.geminiTurnTimeoutMs} ms turn budget`, '');
  lines.push('## Cost per call', '');
  const pc = o.costPerCall;
  lines.push(`- Judge (Jev + Gemini escalation), measured: $${pc.judgeUsd.toFixed(6)} ≈ ฿${pc.judgeThb.toFixed(4)} per call (${pc.turnsPerCall} turns/call, Jev ${m.cost.jevTokensPerTurn} input tokens/turn, ${m.cost.geminiEscalations} Gemini escalations in ${m.turns} turns)`);
  lines.push(`- Persona (Gemini Flash-Lite line + Jev guard): $${(pc.personaUsdPerLine || 0).toFixed(6)} per line, measured on ${pc.personaSampleLines} lines → ≈ $${(pc.personaUsdEstimate || 0).toFixed(6)} per call`);
  lines.push(`- **Total text-AI cost ≈ $${pc.totalUsd.toFixed(5)} ≈ ฿${pc.totalThb.toFixed(3)} per call** (฿${(pc.totalThb * 1000).toFixed(0)} per 1,000 calls). ${pc.scope}`);
  lines.push(`- Prices (USD/1M tokens, checked ${o.pricing.checkedAt}): Jev $0.042 input, output free · gemini-3.8-flash $0.75 in / $3.75 out (until 2026-12-31) · gemini-3.5-flash-lite $0.30 / $2.50 · $1 = ฿${o.pricing.thbPerUsd}`, '');
  if (o.demo) {
    lines.push('## Demo scenarios (src/demoScripts.js, real persona)', '');
    lines.push(`${o.demo.correct}/${o.demo.total} correct`, '');
    for (const d of o.demo.results) lines.push(`- ${d.id}: expected ${d.expected}, got ${d.final} @${d.confidence}, ${d.endedBy} after ${d.turnsPlayed} turn(s) · ${d.trail.map((t) => `${t.verdict}@${t.confidence}/${t.path}/${t.latencyMs}ms`).join(' > ')}`);
    lines.push('');
  }
  if (o.stability) lines.push('## Stability', '', `${o.stability.runs} runs: same final verdict on ${p100(o.stability.sameFinalVerdict)} of calls; flipped: ${o.stability.flipped.join(', ') || 'none'}`, '');
  lines.push('## Misses (final verdict ≠ expected class)', '');
  if (!o.misses.length) lines.push('None.');
  for (const x of o.misses) {
    lines.push(`- **${x.id}** expected ${x.expected}, got ${x.got}${x.safe ? ' (listed as a safe alternative)' : ''}, ended by ${x.endedBy}`);
    lines.push(`  - trail: ${x.trail}`);
    lines.push(`  - last caller turn: "${x.lastCallerTurn}"`);
    lines.push(`  - Jev P: ${x.jevProbabilities ? Object.entries(x.jevProbabilities).map(([k, v]) => `${k} ${v}`).join(', ') : 'n/a'} · signals ≥0.5: ${x.strongSignals.join(', ') || 'none'} · reason: ${x.reasonEn}`);
  }
  lines.push('', `Service errors during run: ${m.serviceErrors.length ? m.serviceErrors.join(', ') : 'none'}`);
  lines.push(`Total spend of this eval run: $${o.spend.usd.toFixed(4)} ≈ ฿${o.spend.thb.toFixed(2)} (${o.wallSeconds}s wall time)`);
  return `${lines.join('\n')}\n`;
}

await main();
