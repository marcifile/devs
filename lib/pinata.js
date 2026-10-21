// IPFS through Pinata, for coin icons and metadata.
const API = 'https://api.pinata.cloud';
const auth = () => ({ Authorization: `Bearer ${process.env.PINATA_JWT}` });
const gateway = () => (process.env.PINATA_GATEWAY ? `https://${process.env.PINATA_GATEWAY.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}/ipfs/` : 'https://gateway.pinata.cloud/ipfs/');
export const pinataReady = () => Boolean(process.env.PINATA_JWT);
export async function pinBuffer(buf, name, type = 'application/octet-stream') {
  const form = new FormData();
  form.append('file', new Blob([buf], { type }), name);
  form.append('pinataMetadata', JSON.stringify({ name }));
  form.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));
  const r = await fetch(`${API}/pinning/pinFileToIPFS`, { method: 'POST', headers: auth(), body: form, signal: AbortSignal.timeout(120000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`pinata: ${j.error?.reason || j.error?.details || j.error || r.status}`);
  return { cid: j.IpfsHash };
}
export async function pinJson(obj, name) {
  const r = await fetch(`${API}/pinning/pinJSONToIPFS`, { method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify({ pinataContent: obj, pinataMetadata: { name }, pinataOptions: { cidVersion: 1 } }), signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`pinata: ${j.error?.reason || j.error?.details || j.error || r.status}`);
  return { cid: j.IpfsHash };
}
export const gatewayUrl = cid => gateway() + cid;
