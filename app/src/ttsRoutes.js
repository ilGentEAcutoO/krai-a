// Live TTS fallback for the turn-based freestyle path: GET /api/tts?call=&turn=
// Voices ONLY a line the server itself generated for a public demo call (an
// assistant turn already stored on that call) — never free text from the
// query, so this endpoint can't be used as a free Thai TTS service. Lines are
// streamed as WAV while Gemini speaks (~1.4 s to first audio) and disk-cached
// by tts.js; repeats cost nothing. Pre-rendered scenarios never hit this
// route (they ship as static mp3 under /demo/audio).
import { Router } from 'express';
import { getCall } from './store.js';
import { take } from './ratelimit.js';
import { synthStream, wavHeader, TtsUnavailable } from './tts.js';

const CALL_ID = /^call_[0-9a-f]{32}$/;
const AI_ROLES = new Set(['assistant', 'ai']);
const MAX_CHARS = 500;

export function ttsRouter({
  streamImpl = synthStream,
  lookupCall = getCall,
  perIpPerMin = 20,
  perHour = 600,
} = {}) {
  const r = Router();

  r.get('/tts', async (req, res) => {
    const id = String(req.query.call || '');
    const turn = Number(req.query.turn);
    if (!CALL_ID.test(id) || !Number.isInteger(turn) || turn < 0 || turn > 200) {
      return res.status(400).json({ error: 'bad-request' });
    }
    for (const [key, max, windowMs] of [[`tts:ip:${req.ip}`, perIpPerMin, 60000], ['tts:all', perHour, 3600000]]) {
      const lim = take(key, max, windowMs);
      if (!lim.ok) {
        res.set('Retry-After', String(lim.retryAfterSec));
        return res.status(429).json({ error: 'rate-limited', retryAfterSec: lim.retryAfterSec });
      }
    }
    const call = lookupCall(id);
    const line = call && call.source === 'demo' ? call.turns?.[turn] : null;
    if (!line || !AI_ROLES.has(line.role) || !line.text || line.text.length > MAX_CHARS) {
      return res.status(404).json({ error: 'not-found' });
    }
    let started = false;
    try {
      await streamImpl(line.text, (pcm, { complete }) => {
        if (!started) {
          started = true;
          res.status(200).type('audio/wav');
          res.set('Cache-Control', 'private, max-age=86400');
          res.write(complete ? wavHeader(pcm.length) : wavHeader());
        }
        res.write(pcm);
      });
      return res.end();
    } catch (e) {
      if (!(e instanceof TtsUnavailable)) console.error('[tts] failed', e.message);
      if (started) return res.end(); // partial line already playing; just stop
      // Client falls back to the browser's own Thai voice for this line.
      return res.status(503).json({ error: 'tts-unavailable', fallback: 'browser' });
    }
  });

  return r;
}
