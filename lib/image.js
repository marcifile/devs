// Coin icons. The brain writes a one-line image prompt; we render it with OpenAI's image model.
// Cost is metered to the dev (returned in SOL). Falls back to the generated SVG when there's no key or it fails.
export const imageReady = () => Boolean(process.env.OPENAI_API_KEY);
const COST_USD = Number(process.env.IMAGE_COST_USD || 0.01); // gpt-image-1-mini, low quality, 1024px

export async function makeIcon(prompt, { ticker, name }) {
  if (!imageReady()) return null;
  const p = `Square memecoin logo for "${name}" ($${ticker}). ${prompt || ''} Bold, simple, centered subject, flat colors, thick outlines, high contrast, no text, no letters, no watermark.`.slice(0, 900);
  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.IMAGE_MODEL || 'gpt-image-1-mini', prompt: p, size: '1024x1024', quality: 'low', output_format: 'png', n: 1 }),
    signal: AbortSignal.timeout(90000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`image: ${j.error?.message || r.status}`);
  const b64 = j.data?.[0]?.b64_json; if (!b64) throw new Error('image: empty');
  return { buf: Buffer.from(b64, 'base64'), type: 'image/png', ext: 'png', cost: COST_USD / Number(process.env.SOL_USD || 180) };
}
