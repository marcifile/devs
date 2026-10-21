// A coin icon the dev can afford: a 512px pixel-art-ish SVG from a seed, rasterised to PNG via sharp if present,
// otherwise pinned as SVG. No image-model bill.
import { createHash } from 'node:crypto';

const PALETTES = [['#ff6a1a', '#0b0b0b', '#ffd9c2'], ['#7cff5a', '#0b0b0b', '#dfffd6'], ['#ff4d4d', '#0b0b0b', '#ffd6d6'], ['#ffd400', '#0b0b0b', '#fff6c2'], ['#5ad1ff', '#0b0b0b', '#d6f2ff'], ['#c86bff', '#0b0b0b', '#efd6ff']];

export function iconSvg(ticker, seed = ticker) {
  const h = createHash('sha256').update(seed).digest();
  const [a, b, c] = PALETTES[h[0] % PALETTES.length];
  const n = 8, cell = 512 / n;
  let rects = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n / 2; x++) {
    const on = (h[1 + ((y * 4 + x) % 30)] >> (x % 8)) & 1;
    if (on) { rects += `<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="${a}"/>`; rects += `<rect x="${(n - 1 - x) * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="${a}"/>`; }
  }
  const t = ticker.slice(0, 5);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="${b}"/>${rects}<rect x="0" y="392" width="512" height="120" fill="${b}" opacity=".85"/><text x="256" y="470" text-anchor="middle" font-family="Menlo, Consolas, monospace" font-weight="700" font-size="${t.length > 4 ? 84 : 100}" fill="${c}">$${t}</text></svg>`;
}
