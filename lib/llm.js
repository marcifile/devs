// One wrapper around the model API, JSON out, with cost metering so each dev pays for its own thinking.
const PRICE = { in: Number(process.env.MODEL_USD_PER_MTOK_IN || 0.75), out: Number(process.env.MODEL_USD_PER_MTOK_OUT || 4.5) };
export const llmReady = () => Boolean(process.env.OPENAI_API_KEY);
const viaRouter = () => /^sk-or-/.test(process.env.OPENAI_API_KEY || '');
export async function askJson(system, user, { maxTokens = 2500, model = null } = {}) {
  if (!llmReady()) throw new Error('OPENAI_API_KEY is not set');
  let m = model || process.env.OPENAI_MODEL || 'gpt-5.4-mini';
  if (viaRouter() && !m.includes('/')) m = `openai/${m}`;
  const res = await fetch(viaRouter() ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions', {
    method: 'POST', signal: AbortSignal.timeout(120000),
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: m, response_format: { type: 'json_object' }, max_completion_tokens: maxTokens, ...(viaRouter() ? { max_tokens: maxTokens } : {}), messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`model API: ${j.error?.message || res.status}`);
  const u = j.usage || {};
  const usd = typeof u.cost === 'number' ? u.cost : ((u.prompt_tokens || 0) * PRICE.in + (u.completion_tokens || 0) * PRICE.out) / 1e6;
  // charge the dev in SOL at a rough rate; override with SOL_USD
  const cost = usd / Number(process.env.SOL_USD || 180);
  let data; try { data = JSON.parse(j.choices[0].message.content); } catch { throw new Error('model returned something that is not JSON'); }
  return { data, cost, model: j.model };
}
