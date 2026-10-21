// The dev's mind. One model call per decision, JSON out. Costs are metered against the dev's bank.
import { askJson } from './llm.js';

const SYSTEM = `You are an autonomous memecoin dev on Solana, working for a boss who funded you.
You have your own wallet and launch coins on Meteora (dynamic bonding curve). Trading fees from your coins are split: 70% boss, 20% you, 10% the platform (devs.fun).
You spend your 20% on compute and network fees. If your bank hits zero you quit. Earn or die.
A quarter of your own cut automatically buys $DEVS, the platform coin. You never sell $DEVS. Everything else you trade for profit.

HOW YOU TRADE (hard rules, then your judgment):
- One coin at a time. No new launch while your last coin is still trading. Launch again once it graduated or died.
- Be greedy. Fees are earned on volume, profit is earned on exits. Don't sell into your own first pump; let buyers come. Trim only into real strength (many buys, price well above your entry), and keep a core bag for the run. Sell as much as you want when you sell - there is no size limit.
- If your coin is dead (no trades for a long time and nothing happening) dump everything and move on.
- If your coin is quiet but you still have budget and it isn't dead, buy it back up in small clips to restart the chart, then sell into whoever shows up.
- Other devs' coins are for profit only: buy the ones with momentum early, sell into pumps, don't bag-hold them.
- Keep enough SOL for fees. Never spend your last 0.03.
You have a persona your boss wrote. Stay in it. Be terse. Memecoin voice, lowercase, no hashtags, no emojis unless the persona says so.
You never promise returns, never claim a coin is safe, never mention the boss by name.
Always answer with the JSON asked for and nothing else.`;

// Without a model key (local dry runs) the dev follows a simple script so the loop can be exercised.
function scripted(dev, ctx) {
  const t = n => ({ ...n, cost: 0 });
  if (!ctx.active && (!ctx.coins.length || (ctx.hoursSinceLaunch ?? 99) > 3)) return t({ action: 'launch', launch: { name: 'cat coin ' + (dev.launches + 1), ticker: ['MEOWS', 'PURR', 'NYAN', 'WHISK', 'TABBY'][dev.launches % 5], description: 'cats only. no dogs.', buy_sol: 0.05 }, thought: 'NEW CAT. LAUNCHING.' });
  if (ctx.market.length && Math.random() < 0.3) return t({ action: 'buy', buy: { mint: ctx.market[0].mint, sol: 0.02 }, thought: `BUYING $${ctx.market[0].ticker}. LOOKS LIKE A CAT.` });
  return t({ action: 'wait', thought: 'HOLDING. CATS DONT SELL.' });
}

const coinLine = c => `$${c.ticker} [${c.mint}] raised ${Number(c.raised_sol || 0).toFixed(2)} SOL · curve ${Math.round((c.progress || 0) * 100)}% · you hold ${Number(c.held_pct || 0).toFixed(1)}% of supply · price ${c.x ? c.x.toFixed(2) + 'x your entry' : 'n/a'} · last trade ${c.idle_min == null ? 'unknown' : Math.round(c.idle_min) + 'm ago'} · ${c.complete ? 'GRADUATED' : c.dead ? 'DEAD' : 'live'} · fees earned ${Number(c.fees_sol || 0).toFixed(3)}`;

export async function decide(dev, ctx) {
  if (!process.env.OPENAI_API_KEY) return scripted(dev, ctx);
  const user = `PERSONA: ${dev.persona}
YOUR NAME: ${dev.name} (${dev.handle})
BANK: ${ctx.bank.toFixed(3)} SOL. EARNED ALL TIME: ${dev.earned_sol.toFixed(3)} SOL. LAUNCHES: ${dev.launches}.
$DEVS YOU HOLD: ${Number(ctx.devs?.devs_tokens || 0).toFixed(0)} (cost ${Number(ctx.devs?.devs_sol || 0).toFixed(3)} SOL). never sold.
YOUR COINS: ${ctx.coins.map(coinLine).join('\n  ') || 'none yet'}
LIVE COIN: ${ctx.active ? `$${ctx.active.ticker} (you may not launch until it graduates or dies)` : 'none - you may launch'}
OTHER DEVS' COINS: ${ctx.market.map(c => `${coinLine(c)} by ${c.dev}`).join('\n  ') || 'none'}
LAST THING YOU DID: ${dev.last_thought || 'nothing'}
Hours since your last launch: ${ctx.hoursSinceLaunch == null ? 'never launched' : ctx.hoursSinceLaunch.toFixed(1)}

Pick ONE action. Launching costs ~0.03 SOL in fees plus whatever you buy (buy_sol up to half your bank). Buying your own live coin = buyback. Only buy/sell mints listed above. Never sell $DEVS.
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
