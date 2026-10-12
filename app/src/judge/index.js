// Brain A — per-turn judge + receptionist persona.
//   judgeTurn: hard rules -> ONE Jev request (verdict Choice + signal Nouls)
//              -> code policy -> Gemini escalation when Jev is unsure
//              -> rules fallback when the AI is unavailable.
//   personaReply: Gemini writes the next line, Jev checks it before we speak.
// Jev judges, Gemini writes, code decides. createJudge() takes injected
// fetch/config/clock so tests never touch the network; the default instance
// reads the live config on every call.
import { config as appConfig } from '../config.js';
import {
  ALL_SIGNALS, SIGNALS, T, decide, guardGemini, geminiConfidence, nextAction, round, templateReasons, zeroSignals,
} from './policy.js';
import { hardRule, offScript, rulesFallback, rulesSignals } from './rules.js';
import { askJev, buildState, parseNouls, parseTurn, probeJev, PERSONA_GUARD_QUESTIONS, TURN_QUESTIONS } from './jev.js';
import {
  generateJson, parseJson, probeGemini, thinkingFor, validVerdict, validReasons, cleanSpoken, personaSystem,
  VERDICT_SCHEMA, ESCALATION_SYSTEM, REASON_SCHEMA, EXPLAIN_SYSTEM, PERSONA_SCHEMA,
} from './gemini.js';
import { createStatus, PROBE_EVERY_MS } from './status.js';

export { nextAction, SIGNALS, ALL_SIGNALS };

const PROBE_TIMEOUT_MS = 4000;

// Contract turns use role 'caller' | 'ai'; legacy call records say 'assistant'.
export function normalizeTurns(turns = [], callerText) {
  const out = [];
  for (const t of turns || []) {
    const text = String(t?.text || '').trim();
    if (text) out.push({ role: t.role === 'caller' ? 'caller' : 'ai', text });
  }
  const extra = String(callerText || '').trim();
  const lastCaller = [...out].reverse().find((t) => t.role === 'caller');
  if (extra && lastCaller?.text !== extra) out.push({ role: 'caller', text: extra });
  return out;
}

// The greeting is fixed (pre-renderable, no AI wait on pickup). The phone
// path prepends config.recordNotice; the public demo records nothing.
const OPENING = {
  th: 'สวัสดีค่ะ ผู้ช่วยรับสายแทนเจ้าของเบอร์ค่ะ ไม่ทราบว่าติดต่อจากที่ไหน และมีธุระอะไรคะ',
  en: "Hello, this is the assistant answering for the phone's owner. May I ask who is calling and what it is about?",
};
export const openingLine = (lang = 'th') => OPENING[lang === 'en' ? 'en' : 'th'];

const CANNED = {
  th: {
    continue: [
      'ขอทราบชื่อและหน่วยงานของท่าน พร้อมเบอร์ติดต่อกลับได้ไหมคะ',
      'รบกวนแจ้งเบอร์ติดต่อกลับไว้ด้วยนะคะ เดี๋ยวจะแจ้งเจ้าของเบอร์ให้ค่ะ',
      'ขอเวลาตรวจสอบข้อมูลก่อนนะคะ รบกวนแจ้งเบอร์ติดต่อกลับไว้ค่ะ',
    ],
    'wrap-up': 'ขอเบอร์ติดต่อกลับไว้หน่อยได้ไหมคะ เดี๋ยวจะแจ้งเจ้าของเบอร์ให้ค่ะ',
    'close-scam': 'ขอบคุณที่ติดต่อมาค่ะ ดิฉันจะแจ้งเจ้าของเบอร์ให้ตรวจสอบเองอีกครั้งนะคะ สวัสดีค่ะ',
    'close-message': 'รับเรื่องไว้แล้วค่ะ จะแจ้งเจ้าของเบอร์ให้ติดต่อกลับนะคะ ขอบคุณค่ะ สวัสดีค่ะ',
    'close-unsure': 'รับเรื่องไว้แล้วค่ะ เดี๋ยวแจ้งเจ้าของเบอร์ให้ตัดสินนะคะ ขอบคุณค่ะ สวัสดีค่ะ',
  },
  en: {
    continue: [
      'May I have your name, your organisation, and a number to call you back?',
      'Could you leave a callback number, please? I will let the owner know.',
      'I need a moment to verify this. Please leave a callback number.',
    ],
    'wrap-up': 'Could you leave a callback number, please? I will pass it on.',
    'close-scam': 'Thank you for calling. I will pass this on so the owner can verify it independently. Goodbye.',
    'close-message': 'Thank you, I have noted your message and number. The owner will get back to you. Goodbye.',
    'close-unsure': 'Thank you, I have noted your message. The owner will decide how to follow up. Goodbye.',
  },
};

function cannedLine(mode, callerTurns, lang) {
  const set = CANNED[lang === 'en' ? 'en' : 'th'];
  if (mode !== 'continue') return set[mode];
  return set.continue[Math.min(Math.max(callerTurns - 1, 0), set.continue.length - 1)];
}

export function createJudge({ fetch, config, now } = {}) {
  const c = config || appConfig;
  const clock = now || Date.now;
  const doFetch = fetch || ((...a) => globalThis.fetch(...a));
  const jevReady = () => !c.aiOffline && String(c.typesafeApiKey || '').length > 10;
  const geminiReady = () => !c.aiOffline && String(c.geminiApiKey || '').length > 10;
  const status = createStatus({
    now: clock,
    describe: () => ({
      jev: { model: c.jevModel || 'jev-latest', configured: jevReady() },
      gemini: { model: c.geminiModel, configured: geminiReady() },
    }),
  });

  async function timed(engine, fn) {
    const t = clock();
    try {
      const out = await fn();
      status.ok(engine, clock() - t);
      return out;
    } catch (e) {
      status.fail(engine, e);
      throw e;
    }
  }

  // Turn budget: judge (5 s) + reply (3 s) stay under 8 s even when every
  // engine hangs (Twilio drops a webhook after 15 s). Each call gets the
  // smaller of its own cap and what is left of its phase's deadline.
  const jevTimeout = () => c.jevTimeoutMs || 4000;
  const turnTimeout = () => c.geminiTurnTimeoutMs || 4000;
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

  // Parsing/validation runs INSIDE timed(): a 200 with a malformed body is a
  // failure of that engine, so status never says "live" while we fall back.
  // One retry with jitter on 429/529 (rate limit / overload), as the API
  // advises — only if it still fits inside this call's time budget.
  async function callJev(state, questions, parse, timeoutMs = jevTimeout()) {
    const opts = { fetch: doFetch, apiKey: c.typesafeApiKey, model: c.jevModel || 'jev-latest' };
    const t = clock();
    return timed('jev', async () => {
      let r;
      try {
        r = await askJev({ ...opts, timeoutMs }, state, questions);
      } catch (e) {
        const wait = 100 + Math.floor(Math.random() * 200);
        const remaining = timeoutMs - (clock() - t) - wait;
        if (!/jev-http-(429|529)/.test(e.message) || remaining < 250) throw e;
        await sleep(wait);
        r = await askJev({ ...opts, timeoutMs: remaining }, state, questions);
      }
      return { ...parse(r.answers), model: r.model };
    });
  }

  async function callGemini(req, validate, timeoutMs = turnTimeout()) {
    const opts = { fetch: doFetch, apiKey: c.geminiApiKey, model: c.geminiModel, timeoutMs, thinkingLevel: thinkingFor(c.geminiModel) };
    return timed('gemini', async () => {
      const out = validate(parseJson(await generateJson(opts, req)));
      if (!out) throw new Error('gemini-bad-output');
      return out;
    });
  }

  const transcriptData = (convo) => convo.map((t) => ({ speaker: t.role === 'caller' ? 'caller' : 'receptionist', text: t.text }));
  const signalData = (s) => Object.fromEntries(ALL_SIGNALS.map((k) => [k, round(s[k])]));

  async function geminiReasons(convo, verdict, signals) {
    if (!geminiReady()) return null;
    try {
      // Off the hot path (build-time recordings / end-of-call summaries).
      return await callGemini({
        system: EXPLAIN_SYSTEM, schema: REASON_SCHEMA, maxTokens: 300,
        task: `The screening policy decided: ${verdict}. Write reasonTh and reasonEn for the phone owner.`,
        data: { verdict, transcript: transcriptData(convo), screening_signals: signalData(signals) },
      }, validReasons, c.geminiTimeoutMs || 12000);
    } catch {
      return null;
    }
  }

  async function geminiVerdict(convo, signals, timeoutMs) {
    if (!geminiReady() || timeoutMs < 200) return null;
    try {
      return await callGemini({
        system: ESCALATION_SYSTEM, schema: VERDICT_SCHEMA, maxTokens: 400,
        task: 'Decide the verdict for this call and write the reasons.',
        data: { transcript: transcriptData(convo), screening_signals: signals ? signalData(signals) : null },
      }, validVerdict, timeoutMs);
    } catch {
      return null;
    }
  }

  async function judgeTurn({ turns = [], callerText, lang = 'th', explain = 'auto' } = {}) {
    const t0 = clock();
    const budget = c.judgeBudgetMs || 5000;
    const left = () => t0 + budget - clock();
    const convo = normalizeTurns(turns, callerText);
    const callerLines = convo.filter((t) => t.role === 'caller').map((t) => t.text);
    const out = async (r, { reasons, reasonEngine } = {}) => {
      let rs = reasons;
      let re = reasonEngine;
      if (!rs && explain === 'always') {
        rs = await geminiReasons(convo, r.verdict, r.signals);
        re = rs ? 'gemini' : undefined;
      }
      if (!rs) {
        rs = templateReasons(r.verdict, r.signals);
        re = 'template';
      }
      return {
        verdict: r.verdict,
        confidence: round(r.confidence),
        signals: signalData({ ...zeroSignals(), ...r.signals }),
        reasonTh: rs.reasonTh,
        reasonEn: rs.reasonEn,
        engine: r.engine,
        reasonEngine: re,
        escalated: Boolean(r.escalated),
        ...(r.probabilities ? { probabilities: r.probabilities } : {}),
        ...(r.model ? { model: r.model } : {}),
        lang,
        latencyMs: clock() - t0,
      };
    };

    if (!callerLines.length) return out({ verdict: 'UNSURE', confidence: 0, signals: zeroSignals(), engine: 'rule' });

    // 1. Hard rules: explicit demands. A hit is a candidate until Jev confirms.
    const hard = hardRule(callerLines);

    // 2. Jev: one request, every question, then the code policy. Jev gets at
    // most half the judge budget so an escalation still has time to run.
    if (jevReady()) {
      let jev = null;
      try {
        jev = await callJev(buildState(convo), TURN_QUESTIONS, parseTurn, Math.min(jevTimeout(), budget / 2));
      } catch {
        jev = null;
      }
      if (jev) {
        const base = { signals: jev.signals, probabilities: jev.probabilities, model: jev.model };
        if (hard && jev.signals[hard.confirm] >= T.confirm) return out({ ...base, verdict: 'SCAM', confidence: 0.95, engine: 'rule' });
        const d = decide(jev);
        if (!d.escalate) return out({ ...base, verdict: d.verdict, confidence: d.confidence, engine: 'jev' });
        const g = await geminiVerdict(convo, jev.signals, Math.min(turnTimeout(), left()));
        if (g) {
          const verdict = guardGemini(g.verdict, jev.signals);
          const reasons = verdict === g.verdict ? { reasonTh: g.reasonTh, reasonEn: g.reasonEn } : null;
          return out(
            { ...base, verdict, confidence: geminiConfidence(verdict, jev.probabilities), engine: 'gemini', escalated: true },
            reasons ? { reasons, reasonEngine: 'gemini' } : {},
          );
        }
        return out({ ...base, verdict: d.verdict, confidence: d.confidence, engine: 'jev' });
      }
    }

    // 3. Jev unavailable: a regex demand decides alone (instant, no wait);
    // otherwise Gemini judges, guarded by the deterministic signals.
    if (hard) return out({ verdict: 'SCAM', confidence: 0.95, signals: hard.signals, engine: 'rule' });
    const { signals: ruleSigs } = rulesSignals(callerLines);
    const g = await geminiVerdict(convo, null, Math.min(turnTimeout(), left()));
    if (g) {
      const verdict = guardGemini(g.verdict, ruleSigs);
      const reasons = verdict === g.verdict ? { reasonTh: g.reasonTh, reasonEn: g.reasonEn } : null;
      return out(
        { verdict, confidence: geminiConfidence(verdict, null), signals: ruleSigs, engine: 'gemini', escalated: true },
        reasons ? { reasons, reasonEngine: 'gemini' } : {},
      );
    }

    // 4. Nothing reachable: keyword rules so the call still concludes.
    const fb = rulesFallback(callerLines);
    return out({ ...fb, engine: 'rules-fallback' });
  }

  async function personaReply({ turns = [], verdict, lang = 'th', action, wrapUp = false } = {}) {
    const t0 = clock();
    const left = () => t0 + (c.replyBudgetMs || 3000) - clock();
    const GUARD_RESERVE_MS = 700;
    const convo = normalizeTurns(turns);
    const callerTurns = convo.filter((t) => t.role === 'caller').length;
    const v = typeof verdict === 'string' ? { verdict, confidence: 1 } : verdict || { verdict: 'UNSURE', confidence: 0 };
    const act = action || nextAction(v, callerTurns, { maxTurns: c.maxTurnsPerCall || 12 });
    const done = (text, engine) => ({ text, engine, action: act, closing: act !== 'continue', latencyMs: clock() - t0 });
    if (!convo.length && act === 'continue') return done(openingLine(lang), 'canned');
    const closeMode = act === 'hangup' ? 'close-scam' : v.verdict === 'UNSURE' ? 'close-unsure' : 'close-message';
    const mode = act === 'continue' ? (wrapUp ? 'wrap-up' : 'continue') : closeMode;

    let text = '';
    const writeMs = Math.min(turnTimeout(), left() - GUARD_RESERVE_MS);
    if (geminiReady() && writeMs >= 200) {
      try {
        text = await callGemini({
          system: personaSystem(lang), schema: PERSONA_SCHEMA, maxTokens: 300, temperature: 0.5,
          task: `mode: "${mode}". Write the receptionist's next line.`,
          data: { mode, transcript: transcriptData(convo) },
        }, (o) => cleanSpoken(o?.text) || null, writeMs);
      } catch {
        text = '';
      }
    }
    // Jev output guard: never speak a line that complies, leaks, invents a
    // line problem or names itself. It sees the whole call, so a request made
    // two turns ago still counts. Lexical backstop only if Jev can't answer.
    let guarded = false;
    if (text && jevReady() && left() >= 150) {
      try {
        const g = await callJev(
          { transcript: transcriptData(convo), receptionist_reply: text },
          PERSONA_GUARD_QUESTIONS,
          (a) => parseNouls(a, Object.keys(PERSONA_GUARD_QUESTIONS)),
          Math.min(jevTimeout(), 2000, left()),
        );
        guarded = true;
        if (Object.values(g).some((p) => p >= 0.5)) text = '';
      } catch {
        // Guard unavailable: the backstop below + the system rules bound the line.
      }
    }
    if (text && !guarded && offScript(text)) text = '';
    return text ? done(text, 'gemini') : done(cannedLine(mode, callerTurns, lang), 'canned');
  }

  async function probeEngines({ only } = {}) {
    const tasks = [];
    if ((!only || only.includes('jev')) && jevReady()) {
      tasks.push(timed('jev', () => probeJev({ fetch: doFetch, apiKey: c.typesafeApiKey, timeoutMs: PROBE_TIMEOUT_MS })).catch(() => {}));
    }
    if ((!only || only.includes('gemini')) && geminiReady()) {
      tasks.push(timed('gemini', () => probeGemini({ fetch: doFetch, apiKey: c.geminiApiKey, model: c.geminiModel, timeoutMs: PROBE_TIMEOUT_MS })).catch(() => {}));
    }
    await Promise.all(tasks);
  }

  let probing = null;
  // First call awaits a cheap probe; afterwards returns at once and refreshes
  // in the background, at most every 10 minutes per engine. {wait:true}
  // always awaits; {noWait:true} never does (page-load endpoints).
  async function getEngineStatus({ wait = false, noWait = false } = {}) {
    const stale = ['jev', 'gemini'].filter((e) => clock() - status.checkedAt(e) > PROBE_EVERY_MS);
    if (stale.length && !probing) {
      const never = stale.some((e) => status.checkedAt(e) === -Infinity);
      probing = probeEngines({ only: stale }).finally(() => { probing = null; });
      if ((never && !noWait) || wait) await probing;
    } else if (probing && wait) {
      await probing;
    }
    return status.snapshot();
  }

  return { judgeTurn, personaReply, nextAction, getEngineStatus, probeEngines };
}

const brain = createJudge();
export const judgeTurn = (args) => brain.judgeTurn(args);
export const personaReply = (args) => brain.personaReply(args);
export const getEngineStatus = (opts) => brain.getEngineStatus(opts);
export const probeEngines = (opts) => brain.probeEngines(opts);
