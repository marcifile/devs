// A pixel dev per handle: same body, different hoodie / skin / hair from a hash. 16x16, crisp.
import { createHash } from 'node:crypto';
const HOODIES = ['#ff6a1a', '#7cff5a', '#5ad1ff', '#c86bff', '#ffd400', '#ff4d4d', '#e6e6e6', '#ff8c47'];
const SKINS = ['#f3d3b5', '#d9a877', '#a86b3c', '#6b3f22', '#ffe0c7'];
const HAIR = ['#0b0b0b', '#3a2416', '#8a5a2b', '#d1b280', '#262626'];
export function avatarSvg(handle) {
  const h = createHash('sha256').update(String(handle)).digest();
  const hood = HOODIES[h[0] % HOODIES.length], skin = SKINS[h[1] % SKINS.length], hair = HAIR[h[2] % HAIR.length];
  const glasses = h[3] % 3 === 0, cap = h[4] % 4 === 0, beard = h[5] % 5 === 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">
<rect width="16" height="16" fill="#111"/>
<rect x="3" y="9" width="10" height="7" fill="${hood}"/><rect x="5" y="8" width="6" height="1" fill="${hood}"/>
<rect x="5" y="3" width="6" height="6" fill="${skin}"/>
${cap ? `<rect x="4" y="2" width="8" height="2" fill="${hood}"/><rect x="4" y="4" width="9" height="1" fill="${hood}"/>` : `<rect x="4" y="2" width="8" height="2" fill="${hair}"/><rect x="4" y="4" width="1" height="2" fill="${hair}"/><rect x="11" y="4" width="1" height="2" fill="${hair}"/>`}
${glasses ? `<rect x="5" y="5" width="3" height="1" fill="#0b0b0b"/><rect x="8" y="5" width="3" height="1" fill="#0b0b0b"/><rect x="6" y="5" width="1" height="1" fill="#5ad1ff"/><rect x="9" y="5" width="1" height="1" fill="#5ad1ff"/>` : `<rect x="6" y="5" width="1" height="1" fill="#0b0b0b"/><rect x="9" y="5" width="1" height="1" fill="#0b0b0b"/>`}
${beard ? `<rect x="5" y="8" width="6" height="1" fill="${hair}"/>` : ''}
<rect x="2" y="12" width="12" height="1" fill="#e6e6e6"/><rect x="3" y="11" width="10" height="1" fill="#262626"/><rect x="4" y="11" width="1" height="1" fill="#7cff5a"/>
</svg>`;
}
