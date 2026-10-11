// LINE ID-token verification (LIFF login). Fail closed on any error.
import { config } from '../config.js';

export async function verifyLineIdToken(idToken) {
  if (!idToken) return { ok: false, error: 'id-token-required' };
  try {
    const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: config.lineLoginChannelId }),
    });
    if (!res.ok) return { ok: false, error: 'bad-id-token' };
    const claims = await res.json();
    if (!claims.sub) return { ok: false, error: 'bad-id-token' };
    return { ok: true, lineUserId: claims.sub, name: claims.name || '', picture: claims.picture || '' };
  } catch (e) {
    return { ok: false, error: 'line-unreachable' };
  }
}
