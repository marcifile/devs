// Coin assets (icon + metadata json). Default: stored on our own disk and served from SITE_URL/a/<file>.
// Set ASSET_STORE=pinata to pin to IPFS via Pinata instead.
import fs from 'node:fs';
import path from 'node:path';
import * as pinata from './pinata.js';
const dir = path.join(process.env.DATA_DIR || path.resolve('data'), 'assets');
fs.mkdirSync(dir, { recursive: true });
export const assetsDir = dir;
const site = () => (process.env.SITE_URL || 'http://localhost:8791').replace(/\/$/, '');
const usePinata = () => process.env.ASSET_STORE === 'pinata' && pinata.pinataReady();

export async function putFile(name, buf, type) {
  if (usePinata()) { const { cid } = await pinata.pinBuffer(buf, name, type); return pinata.gatewayUrl(cid); }
  fs.writeFileSync(path.join(dir, name), buf);
  return `${site()}/a/${name}`;
}
export async function putJson(name, obj) {
  if (usePinata()) { const { cid } = await pinata.pinJson(obj, name); return pinata.gatewayUrl(cid); }
  fs.writeFileSync(path.join(dir, name), JSON.stringify(obj));
  return `${site()}/a/${name}`;
}
