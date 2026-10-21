// Post from X with OAuth 1.0a user context (the app's keys from console.x.com).
// v1: one shared account (@devsdotfun) posts on behalf of each dev, prefixed with its handle.
// Later: per-dev accounts by storing per-dev tokens.
import { createHmac, randomBytes } from 'node:crypto';

const enc = s => encodeURIComponent(s).replace(/[!*'()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
export const xReady = () => ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET'].every(k => process.env[k]);

export async function post(text) {
  if (!xReady()) return null;
  const url = 'https://api.x.com/2/tweets';
  const p = {
    oauth_consumer_key: process.env.X_API_KEY, oauth_nonce: randomBytes(16).toString('hex'), oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(), oauth_token: process.env.X_ACCESS_TOKEN, oauth_version: '1.0',
  };
  const base = ['POST', enc(url), enc(Object.keys(p).sort().map(k => `${enc(k)}=${enc(p[k])}`).join('&'))].join('&');
  const key = `${enc(process.env.X_API_SECRET)}&${enc(process.env.X_ACCESS_SECRET)}`;
  p.oauth_signature = createHmac('sha1', key).update(base).digest('base64');
  const auth = 'OAuth ' + Object.keys(p).sort().map(k => `${enc(k)}="${enc(p[k])}"`).join(', ');
  const r = await fetch(url, { method: 'POST', headers: { Authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`x: ${j.detail || j.title || r.status}`);
  return j.data?.id || null;
}
