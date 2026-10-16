// Crash-safe snapshots (single-writer): boot load + 15s interval + SIGTERM
// flush. Requires max-instances=1 — concurrent writers would clobber each
// other (last-write-wins). Locally (no metadata server) every op is a
// silent no-op: pure in-memory, exactly like before.
import { serializeStore, restoreStore } from '../store.js';
import { serializeAuth, restoreAuth } from '../auth.js';
import { loadSnapshot, saveSnapshot } from './firestore.js';
import { persistDoc } from '../siteMode.js';

let timer = null;

export async function bootLoad() {
  const doc = persistDoc();
  if (!doc) return console.log('[persist] off (PERSIST_DOC=off): in-memory only');
  try {
    const snap = await loadSnapshot(doc);
    if (snap) {
      if (snap.store) restoreStore(snap.store);
      if (snap.auth) restoreAuth(snap.auth);
      console.log(`[persist] snapshot restored from ${doc}`);
    }
  } catch (e) {
    console.log('[persist] boot load skipped:', e.message);
  }
}

export async function flush() {
  const doc = persistDoc();
  if (!doc) return;
  try {
    await saveSnapshot(doc, { store: serializeStore(), auth: serializeAuth(), savedAt: new Date().toISOString() });
  } catch (e) {
    console.error('[persist] save failed:', e.message);
  }
}

export function startPersistence(intervalMs = 15000) {
  if (timer) return;
  timer = setInterval(() => { flush().catch(() => {}); }, intervalMs);
  process.once('SIGTERM', () => { flush().finally(() => process.exit(0)); });
}
