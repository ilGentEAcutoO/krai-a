// Firestore through the Firebase Admin SDK (firebase-admin). Auth is the
// Cloud Run service account (Application Default Credentials). Only active
// on Cloud Run (K_SERVICE) or against the emulator (FIRESTORE_EMULATOR_HOST):
// a laptop with gcloud credentials must never read or overwrite production
// data, so local dev stays pure in-memory (every op throws, the caller logs).
// Single 1MB-max doc per site role (see siteMode.js): fine for pilot scale.
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || 'krai-a';

let dbPromise = null;

async function db() {
  if (dbPromise) return dbPromise;
  if (!process.env.K_SERVICE && !process.env.FIRESTORE_EMULATOR_HOST) throw new Error('not-on-cloud-run');
  dbPromise = (async () => {
    // Lazy: tests and local dev never load the SDK.
    const { initializeApp, getApps } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');
    const app = getApps()[0] || initializeApp({ projectId: PROJECT });
    return getFirestore(app);
  })();
  dbPromise.catch(() => { dbPromise = null; }); // retry init on the next call
  return dbPromise;
}

export async function loadSnapshot(doc) {
  const snap = await (await db()).doc(doc).get();
  return snap.exists ? snap.data() : null;
}

// Plain JSON only (no Date/Map/undefined): the doc reads back exactly as
// serialized, like the restore round-trip the tests cover.
export async function saveSnapshot(doc, obj) {
  await (await db()).doc(doc).set(JSON.parse(JSON.stringify(obj)));
}

export function _setDb(fake) { dbPromise = fake ? Promise.resolve(fake) : null; } // tests only
