// Minimal Firestore backend over REST (no SDK dep). Auth via the Cloud Run
// metadata server; throws when unreachable (local dev) so the caller can
// stay pure in-memory. Single 1MB-max doc: fine for pilot scale.
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || 'krai-a';
const DB = '(default)';
const DOC = `projects/${PROJECT}/databases/${DB}/documents/krai/snapshot`;

let cachedToken = null;
let tokenExp = 0;

async function accessToken() {
  if (cachedToken && Date.now() < tokenExp) return cachedToken;
  const res = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' } });
  if (!res.ok) throw new Error('no-metadata-server');
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExp = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// Firestore REST value encoding for plain JSON (string/int/double/bool/
// null/array/map). undefined -> null (Firestore rejects undefined).
function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  if (typeof v === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
  return { stringValue: String(v) };
}

function dec(v) {
  if (!v || 'nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)]));
  return null;
}

export async function loadSnapshot() {
  const token = await accessToken();
  const res = await fetch(`https://firestore.googleapis.com/v1/${DOC}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`firestore-load-${res.status}`);
  const data = await res.json();
  return data.fields ? dec({ mapValue: { fields: data.fields } }) : null;
}

export async function saveSnapshot(obj) {
  const token = await accessToken();
  const res = await fetch(`https://firestore.googleapis.com/v1/${DOC}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: enc(obj).mapValue.fields }),
  });
  if (!res.ok) throw new Error(`firestore-save-${res.status}`);
}

export { enc as _enc, dec as _dec }; // exported for unit tests only
