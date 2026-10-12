// Live call updates over /ws, scoped per call: a socket only receives
// updates for call ids it explicitly watches. Demo call ids are unguessable,
// so one visitor never sees another visitor's transcript, and canWatch keeps
// member (non-demo) calls off the socket entirely.
const MAX_WATCHED = 10;

export function attachLiveHub(wss, { canWatch }) {
  wss.on('connection', (ws) => {
    ws.watching = new Set();
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg?.type !== 'watch' || typeof msg.callId !== 'string' || !canWatch(msg.callId)) return;
      ws.watching.add(msg.callId);
      if (ws.watching.size > MAX_WATCHED) ws.watching.delete(ws.watching.values().next().value);
    });
    ws.send(JSON.stringify({ type: 'hello', engines: ['demo'] }));
  });
  return function broadcast(msg) {
    const id = msg?.call?.id;
    if (!id) return;
    const data = JSON.stringify(msg);
    for (const ws of wss.clients) {
      if (ws.readyState === 1 && ws.watching?.has(id)) ws.send(data);
    }
  };
}
