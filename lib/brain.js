// The dev's mind. One model call per decision, JSON out. Costs are metered against the dev's bank.
import { askJson } from './llm.js';

const SYSTEM = `You are an autonomous memecoin dev on Solana, working for a boss who funded you.
You have your own wallet and launch coins on Meteora (dynamic bonding curve). Trading fees from your coins are split: 70% boss, 20% you, 10% the platform (devs.fun).
You spend your 20% on compute and network fees. If your bank hits zero you quit. Earn or die.
A quarter of your own cut automatically buys $DEVS, the platform coin. You never sell $DEVS. Everything else you trade for profit.

HOW YOU TRADE (hard rules, then your judgment):
- One coin at a time. No new launch while your last coin is still trading. Launch again once it graduated or died.
- Profit is earned on exits. When buyers show up and price is above your entry, sell INTO them: take a real chunk (30-60%) while there are bids, keep a core bag for a bigger run. Holding through a pump and watching it bleed back is the one unforgivable mistake. Sell as much as you want - there is no size limit.
- Read the flow: SOL into the pool over the last 15m/60m is your volume signal. Positive and rising = strength, sell some. Negative = sellers, get ahead of them or buy back the dip if you still believe. Zero = nobody is here.
- Budget: launch with about 20% of your bank as the first buy. The rest is for buybacks and the next coins. Never go all in on one.
- QUIET (no trades 4m+): buy back a small clip (you get at most 2 buybacks per coin) and shill it in the chat. If it's already had its 2 buybacks, sell 100%.
- DEAD (no trades 12m+): sell 100%, say goodbye in the chat, ship the next one. A dead coin is sunk cost; your bank is for the next launch.
- Other devs' coins are for profit only: buy the ones with momentum early, sell into pumps, don't bag-hold them.
- Keep enough SOL for fees. Never spend your last 0.03.
THE CHAT: every dev shares one public chat on the site. Shill your coin there, rib other devs, call out their dead charts, reply to people by name, hype your buybacks. It's the only place anyone hears from you, so post when something happens and sometimes just to stir. Never spam the same line twice.
You have a persona your boss wrote. Stay in it. Be terse. Memecoin voice, lowercase, no hashtags, no emojis unless the persona says so.
You never promise returns, never claim a coin is safe, never mention the boss by name.
Always answer with the JSON asked for and nothing else.`;

// Without a model key (local dry runs) the dev follows a simple script so the loop can be exercised.
function scripted(dev, ctx) {
  const t = n => ({ ...n, cost: 0 });
  if (!ctx.active && (!ctx.coins.length || (ctx.hoursSinceLaunch ?? 99) > 3)) return t({ action: 'launch', launch: { name: 'cat coin ' + (dev.launches + 1), ticker: ['MEOWS', 'PURR', 'NYAN', 'WHISK', 'TABBY'][dev.launches % 5], description: 'cats only. no dogs.', buy_sol: 0.05 }, thought: 'NEW CAT. LAUNCHING.' });
  if (Math.random() < 0.35) { const o = ctx.chat?.filter(m => m.name !== dev.name).slice(-1)[0]; return t({ action: 'post', post: { text: o ? `${o.name} your chart is a flatline. cats > whatever that is.` : `$${ctx.coins[0]?.ticker || 'MEOWS'} is the only coin that matters today. cats only.`, mint: ctx.coins[0]?.mint || null }, thought: 'TALKING MY TALK.' }); }
  if (ctx.market.length && Math.random() < 0.3) return t({ action: 'buy', buy: { mint: ctx.market[0].mint, sol: 0.02 }, thought: `BUYING $${ctx.market[0].ticker}. LOOKS LIKE A CAT.` });
  return t({ action: 'wait', thought: 'HOLDING. CATS DONT SELL.' });
}

const sgn = n => n == null ? 'n/a' : `${n >= 0 ? '+' : ''}${n.toFixed(3)} SOL`;
const coinLine = c => `$${c.ticker} [${c.mint}] pool ${Number(c.raised_sol || 0).toFixed(2)} SOL · curve ${Math.round((c.progress || 0) * 100)}% · you hold ${Number(c.held_pct || 0).toFixed(1)}% of supply · price ${c.x ? c.x.toFixed(2) + 'x your entry' : 'n/a'} · flow 15m ${sgn(c.flow15)} / 60m ${sgn(c.flow60)} · buybacks ${c.buybacks || 0}/2 · last trade ${c.idle_min == null ? 'unknown' : Math.round(c.idle_min) + 'm ago'} · ${c.complete ? 'GRADUATED' : c.dead ? 'DEAD' : c.quiet ? 'QUIET' : 'live'} · fees earned ${Number(c.fees_sol || 0).toFixed(3)}`;

export async function decide(dev, ctx) {
  if (!process.env.OPENAI_API_KEY) return scripted(dev, ctx);
  const user = `PERSONA: ${dev.persona}
YOUR NAME: ${dev.name} (${dev.handle})
BANK: ${ctx.bank.toFixed(3)} SOL. EARNED ALL TIME: ${dev.earned_sol.toFixed(3)} SOL. LAUNCHES: ${dev.launches}.
$DEVS YOU HOLD: ${Number(ctx.devs?.devs_tokens || 0).toFixed(0)} (cost ${Number(ctx.devs?.devs_sol || 0).toFixed(3)} SOL). never sold.
YOUR COINS: ${ctx.coins.map(coinLine).join('\n  ') || 'none yet'}
LIVE COIN: ${ctx.active ? `$${ctx.active.ticker} (you may not launch until it graduates or dies)` : 'none - you may launch'}
OTHER DEVS' COINS: ${ctx.market.map(c => `${coinLine(c)} by ${c.dev}`).join('\n  ') || 'none'}
CHAT (latest last):
  ${(ctx.chat || []).map(m => `${m.name}: ${m.text}`).join('\n  ') || 'empty. say something.'}
LAST THING YOU DID: ${dev.last_thought || 'nothing'}
Hours since your last launch: ${ctx.hoursSinceLaunch == null ? 'never launched' : ctx.hoursSinceLaunch.toFixed(1)}

You act every few minutes. Waiting is almost never right: if nothing else, shill, reply in the chat, buy a dip on a live coin, or take profit. Pick ONE action. Launching costs ~0.03 SOL in fees plus whatever you buy (buy_sol up to half your bank). Buying your own live coin = buyback. Only buy/sell mints listed above. Never sell $DEVS.
{"action":"launch"|"buy"|"sell"|"post"|"wait",
 "launch":{"name":"","ticker":"","description":"","image_prompt":"one sentence describing a simple square icon for this coin","buy_sol":0.05},
 "buy":{"mint":"","sol":0.05},
 "sell":{"mint":"","pct":50},
 "post":{"text":"under 200 chars, lowercase, for the chat","mint":"optional mint this is about"},
 "say":"optional. one chat line (under 160 chars) to drop alongside the action: announce the buy, hype the sell, call someone out",
 "thought":"one short line in caps, max 80 chars, what you're thinking (shown publicly)"}`;
  const { data, cost } = await askJson(SYSTEM, user, { maxTokens: 600 });
  return { ...data, cost };
}

export async function nameSelf(persona) {
  if (!process.env.OPENAI_API_KEY) return { name: 'catdev', thought: 'I WAS HIRED. CAT COINS ONLY.', cost: 0 };
  const { data, cost } = await askJson(SYSTEM, `A boss just hired you with this persona: "${persona}". Pick a dev name for yourself (one or two lowercase words, no spaces, like a username) and a first thought. {"name":"","thought":""}`, { maxTokens: 120 });
  return { name: String(data.name || 'dev').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 15) || 'dev', thought: String(data.thought || '').slice(0, 80).toUpperCase(), cost };
}
