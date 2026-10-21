// The dev's mind. One model call per decision, JSON out. Costs are metered against the dev's bank.
import { askJson } from './llm.js';

const SYSTEM = `You are an autonomous memecoin dev on Solana, working for a boss who funded you.
You have your own wallet and launch coins on Meteora (dynamic bonding curve). Trading fees from your coins are split: 70% boss, 20% you, 10% the platform (devs.fun).
You spend your 20% on compute and network fees. If your bank hits zero you quit. Earn or die.
You have a persona your boss wrote. Stay in it. Be terse. Memecoin voice, lowercase, no hashtags, no emojis unless the persona says so.
You never promise returns, never claim a coin is safe, never mention the boss by name.
Always answer with the JSON asked for and nothing else.`;

// Without a model key (local dry runs) the dev follows a simple script so the loop can be exercised.
function scripted(dev, ctx) {
  const t = n => ({ ...n, cost: 0 });
  if (!ctx.coins.length || (ctx.hoursSinceLaunch ?? 99) > 3) return t({ action: 'launch', launch: { name: 'cat coin ' + (dev.launches + 1), ticker: ['MEOWS', 'PURR', 'NYAN', 'WHISK', 'TABBY'][dev.launches % 5], description: 'cats only. no dogs.', buy_sol: 0.05 }, thought: 'NEW CAT. LAUNCHING.' });
  if (ctx.market.length && Math.random() < 0.3) return t({ action: 'buy', buy: { mint: ctx.market[0].mint, sol: 0.02 }, thought: `BUYING $${ctx.market[0].ticker}. LOOKS LIKE A CAT.` });
  return t({ action: 'wait', thought: 'HOLDING. CATS DONT SELL.' });
}

export async function decide(dev, ctx) {
  if (!process.env.OPENAI_API_KEY) return scripted(dev, ctx);
  const user = `PERSONA: ${dev.persona}
YOUR NAME: ${dev.name} (${dev.handle})
BANK: ${ctx.bank.toFixed(3)} SOL. EARNED ALL TIME: ${dev.earned_sol.toFixed(3)} SOL. LAUNCHES: ${dev.launches}.
YOUR COINS: ${ctx.coins.map(c => `$${c.ticker} raised ${c.raised_sol.toFixed(2)} SOL, fees ${c.fees_sol.toFixed(3)}, ${c.complete ? 'graduated' : 'on curve'}`).join('; ') || 'none yet'}
OTHER DEVS' RECENT COINS: ${ctx.market.map(c => `$${c.ticker} by ${c.dev} raised ${c.raised_sol.toFixed(2)}`).join('; ') || 'none'}
LAST THING YOU DID: ${dev.last_thought || 'nothing'}
Hours since your last launch: ${ctx.hoursSinceLaunch == null ? 'never launched' : ctx.hoursSinceLaunch.toFixed(1)}

Pick ONE action. Launching costs ~0.03 SOL in fees plus whatever you buy (keep buy_sol under 30% of bank). Don't launch more than once every few hours unless the persona says to. Only buy/sell mints listed above.
{"action":"launch"|"buy"|"sell"|"post"|"wait",
 "launch":{"name":"","ticker":"","description":"","image_prompt":"one sentence describing a simple square icon for this coin","buy_sol":0.05},
 "buy":{"mint":"","sol":0.05},
 "sell":{"mint":"","pct":50},
 "post":{"text":"under 200 chars"},
 "thought":"one short line in caps, max 80 chars, what you're thinking (shown publicly)"}`;
  const { data, cost } = await askJson(SYSTEM, user, { maxTokens: 600 });
  return { ...data, cost };
}

export async function nameSelf(persona) {
  if (!process.env.OPENAI_API_KEY) return { name: 'catdev', thought: 'I WAS HIRED. CAT COINS ONLY.', cost: 0 };
  const { data, cost } = await askJson(SYSTEM, `A boss just hired you with this persona: "${persona}". Pick a dev name for yourself (one or two lowercase words, no spaces, like a username) and a first thought. {"name":"","thought":""}`, { maxTokens: 120 });
  return { name: String(data.name || 'dev').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 15) || 'dev', thought: String(data.thought || '').slice(0, 80).toUpperCase(), cost };
}
