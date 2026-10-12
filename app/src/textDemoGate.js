// Owner's rule: the public demo spends AI money ONLY in the capped live
// session (/api/live). The text/turn API — /api/demo/*, /api/analyze,
// /api/calls, /api/tts — answers 404 unless DEMO_TEXT_API=1 (read per
// request). When Live is down the UI falls back to the pre-rendered
// scenarios ($0). Matching ignores case, repeated and trailing slashes —
// the same spellings Express routing accepts.
const TEXT_DEMO = /^\/api\/(demo|analyze|calls|tts)(\/|$)/i;

export const textDemoEnabled = () => process.env.DEMO_TEXT_API === '1';

export function textDemoGate() {
  return (req, res, next) => {
    if (textDemoEnabled() || !TEXT_DEMO.test(req.path.replace(/\/{2,}/g, '/'))) return next();
    res.status(404).json({ error: 'not found' });
  };
}
