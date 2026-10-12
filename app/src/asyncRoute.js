// Express 4 drops rejected promises from async handlers (the request hangs,
// and on Node 20 the process dies). Wrap every async handler:
//   r.post('/x', safe(async (req, res) => { ... }))
export const safe = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
