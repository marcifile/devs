// A dev: its own keypair, its own coins, its own decisions. The house wallet only pays for
// distribution network fees and receives the house cut. Everything the dev does is signed by the dev.
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { db, log, now } from './db.js';
import * as P from './meteora.js';
const { LAMPORTS_PER_SOL } = P;
import { decide, nameSelf } from './brain.js';
import { iconSvg } from './icon.js';
import { makeIcon } from './image.js';
import { putFile, putJson } from './store.js';


export const DEV_BPS = Number(process.env.FEE_DEV_BPS || 2000);
export const HOUSE_BPS = Number(process.env.FEE_HOUSE_BPS || 1000);
export const BOSS_BPS = 10_000 - DEV_BPS - HOUSE_BPS;
export const HIRE_SOL = Number(process.env.HIRE_SOL || 0.5);        // recommended
export const HIRE_MIN = Number(process.env.HIRE_MIN || 0.1);        // floor
export const DEVS_SLICE = Number(process.env.DEVS_SLICE || 0.25);   // share of the dev's own cut that buys $DEVS (never sold)
const PLATFORM_MINT = () => process.env.PLATFORM_MINT || null;
const PLATFORM_POOL = () => process.env.PLATFORM_POOL || null;
const DEAD_MS = 12 * 60e3;  // no trades for this long = the curve is dead
const QUIET_MS = 4 * 60e3;  // no trades for this long = quiet
const MAX_BUYBACKS = 2;
const MIN_BANK = 0.02; // below this a dev can't afford a launch; it quits
export const DRY = process.env.DRY_RUN === '1'; // simulate chain writes; for local testing only

const kp = dev => Keypair.fromSecretKey(bs58.decode(dev.secret));
// Of the creator share the dev receives from Meteora, this fraction is forwarded to the boss.
const BOSS_OF_CREATOR = BOSS_BPS / (BOSS_BPS + DEV_BPS);

// ---- hiring ---------------------------------------------------------------
export function pendingHire(boss, persona, sol = HIRE_SOL) {
  sol = Math.max(HIRE_MIN, Math.min(100, Number(sol) || HIRE_SOL));
  // The boss pays `sol` to a fresh dev wallet. We make the wallet first, hand back the address, and
  // activate once the deposit lands (see confirmHire).
  const k = Keypair.generate();
  const n = db.prepare('select count(*) c from devs').get().c + 1;
  const handle = `dev_${String(n).padStart(4, '0')}`;
  db.prepare('insert into devs (handle, name, persona, boss, wallet, secret, status, hire_sol, created_at) values (?,?,?,?,?,?,?,?,?)')
    .run(handle, handle, persona.slice(0, 200), boss, k.publicKey.toBase58(), bs58.encode(k.secretKey), 'pending', sol, now());
  return { handle, wallet: k.publicKey.toBase58(), amount: sol };
}

export async function confirmHire(handle) {
  const dev = db.prepare('select * from devs where handle=?').get(handle);
  if (!dev) return null;
  if (dev.status !== 'pending') return dev;
  const want = dev.hire_sol || HIRE_SOL;
  const bal = DRY ? want : await P.balanceSol(dev.wallet);
  if (bal < want * 0.98) return { ...dev, funded: false, balance: bal };
  let name = dev.handle, thought = 'I WAS HIRED. LOOKING AROUND.', cost = 0;
  try { ({ name, thought, cost } = await nameSelf(dev.persona)); } catch {}
  if (db.prepare('select 1 from devs where name=? and id<>?').get(name, dev.id)) name = `${name}${dev.id}`;
  db.prepare('update devs set status=?, name=?, bank_sol=?, spent_sol=spent_sol+?, last_thought=?, next_action_at=? where id=?')
    .run('shipping', name, bal, cost, thought, now(), dev.id);
  log(dev.id, 'hired', `${name} hired. ${bal.toFixed(2)} SOL in the bank.`, { sol: bal });
  log(dev.id, 'thought', thought);
  return db.prepare('select * from devs where id=?').get(dev.id);
}

// ---- actions ---------------------------------------------------------------
async function launch(dev, L) {
  if (dev.bank_sol < 0.06) throw new Error('not enough SOL to launch safely');
  const ticker = String(L.ticker || 'DEV').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'DEV';
  const name = String(L.name || ticker).slice(0, 32);
  const description = String(L.description || '').slice(0, 300);
  const buySol = Math.max(0, Math.min(Number(L.buy_sol) || dev.bank_sol * 0.2, dev.bank_sol * 0.25, Math.max(0, dev.bank_sol - 0.05)));

  const svg = iconSvg(ticker, `${dev.handle}:${ticker}:${now()}`);
  if (DRY) {
    const mintStr = Keypair.generate().publicKey.toBase58();
    db.prepare('insert into coins (mint, dev_id, ticker, name, description, image, metadata_uri, launch_sig, split_sig, pool, raised_sol, created_at) values (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(mintStr, dev.id, ticker, name, description, `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`, '', 'dry', 'dry', 'dry', buySol, now());
    db.prepare('update devs set launches=launches+1, bank_sol=bank_sol-?-0.03 where id=?').run(buySol, dev.id);
    log(dev.id, 'launched', `launched $${ticker}`, { mint: mintStr, sig: null });
    if (buySol > 0) log(dev.id, 'bought', `bought ${buySol} SOL of $${ticker}`, { mint: mintStr, sol: buySol });
    log(dev.id, 'split', `fee split locked: boss ${BOSS_BPS / 100}% · dev ${DEV_BPS / 100}% · devs ${HOUSE_BPS / 100}%`, { mint: mintStr });
    await tryPost(dev, `$${ticker} is live. ${description.slice(0, 120)}`, mintStr);
    return mintStr;
  }
  // real icon from the brain's prompt; SVG fallback
  log(dev.id, 'work', `designing the $${ticker} icon`);
  let icon = null;
  try { icon = await makeIcon(L.image_prompt, { ticker, name }); } catch (e) { log(dev.id, 'error', `icon: ${e.message}`); }
  if (icon?.cost) db.prepare('update devs set spent_sol=spent_sol+? where id=?').run(icon.cost, dev.id);
  log(dev.id, 'work', `writing $${ticker} metadata`);
  const stamp = `${ticker.toLowerCase()}-${now().toString(36)}`;
  const imageUrl = icon ? await putFile(`${stamp}.${icon.ext}`, icon.buf, icon.type) : await putFile(`${stamp}.svg`, Buffer.from(svg), 'image/svg+xml');
  const uri = await putJson(`${stamp}.json`, { name, symbol: ticker, description, image: imageUrl, createdOn: process.env.SITE_URL || 'https://theydevs.fun', website: process.env.SITE_URL });
  log(dev.id, 'work', `sending the $${ticker} launch tx to meteora${buySol > 0 ? ` with a ${buySol} SOL first buy` : ''}`);
  const { mint: mintStr, pool, sig } = await P.launchPool({ devKeypair: kp(dev), name, symbol: ticker, uri, buySol });
  db.prepare('insert into coins (mint, dev_id, ticker, name, description, image, metadata_uri, launch_sig, split_sig, pool, created_at) values (?,?,?,?,?,?,?,?,?,?,?)')
    .run(mintStr, dev.id, ticker, name, description, imageUrl, uri, sig, sig, pool, now());
  try { const st = await P.poolStats(pool); if (st) db.prepare('update coins set entry_price=?, price_sol=?, quote_reserve=?, last_trade_at=? where mint=?').run(st.price, st.price, st.quoteReserveSol, now(), mintStr); } catch {}
  log(dev.id, 'launched', `launched $${ticker} on meteora`, { mint: mintStr, sig });
  if (buySol > 0) log(dev.id, 'bought', `bought ${buySol} SOL of $${ticker}`, { mint: mintStr, sol: buySol, sig });
  log(dev.id, 'split', `fees: boss ${BOSS_BPS / 100}% · dev ${DEV_BPS / 100}% · devs ${HOUSE_BPS / 100}%`, { mint: mintStr });
  db.prepare('update devs set launches=launches+1 where id=?').run(dev.id);
  await tryPost(dev, `$${ticker} is live. ${description.slice(0, 140)}`, mintStr);
  return mintStr;
}

async function buy(dev, mintStr, sol) {
  const c = db.prepare('select ticker, pool from coins where mint=?').get(mintStr);
  if (!c) throw new Error('unknown coin');
  if (DRY) { db.prepare('update devs set bank_sol=bank_sol-? where id=?').run(sol, dev.id); db.prepare('update coins set raised_sol=raised_sol+? where mint=?').run(sol, mintStr); log(dev.id, 'bought', `bought ${sol} SOL of $${c.ticker}`, { mint: mintStr, sol }); return 'dry'; }
  const sig = await P.buy({ devKeypair: kp(dev), pool: c.pool, sol });
  log(dev.id, 'bought', `bought ${sol} SOL of $${c.ticker}`, { mint: mintStr, sol, sig });
  return sig;
}

async function sell(dev, mintStr, pct) {
  if (mintStr === PLATFORM_MINT()) throw new Error('devs never sell $DEVS');
  const c = db.prepare('select ticker, pool from coins where mint=?').get(mintStr);
  if (!c) throw new Error('unknown coin');
  if (DRY) { log(dev.id, 'sold', `sold ${pct}% of $${c.ticker}`, { mint: mintStr }); return 'dry'; }
  const sig = await P.sellPct({ devKeypair: kp(dev), mint: mintStr, pool: c.pool, pct });
  log(dev.id, 'sold', `sold ${pct}% of $${c.ticker}`, { mint: mintStr, sig });
  return sig;
}

// Devs talk in the chat on the site. A post is an event of kind 'posted'.
async function tryPost(dev, text, mint = null) {
  text = String(text || '').trim().slice(0, 240);
  if (text) log(dev.id, 'posted', text, { mint });
}

// ---- payday ---------------------------------------------------------------
// Payday: the dev claims its creator fees from Meteora, forwards the boss share, and devs claims the partner share.
export async function payday(dev) {
  const coins = db.prepare('select * from coins where dev_id=?').all(dev.id);
  const ins = db.prepare('insert into payouts (dev_id, mint, to_wallet, role, sol, sig, at) values (?,?,?,?,?,?,?)');
  for (const c of coins) {
    try {
      let creatorSol, sig = null, houseSol = 0;
      if (DRY) {
        if (Math.random() < 0.5) continue;
        creatorSol = 0.004 + Math.random() * 0.02; houseSol = creatorSol / 9;
      } else {
        const r = await P.claimCreatorFees({ devKeypair: kp(dev), pool: c.pool });
        creatorSol = r.claimed / LAMPORTS_PER_SOL; sig = r.sig || null;
        if (creatorSol < 0.002) continue;
        try { await P.claimPartnerFees({ pool: c.pool }); houseSol = creatorSol / 9; } catch (e) { log(dev.id, 'error', `devs claim on $${c.ticker}: ${e.message}`); }
      }
      const toBoss = creatorSol * BOSS_OF_CREATOR, toDev = creatorSol - toBoss;
      let bossSig = sig;
      if (!DRY) bossSig = await P.transferSol(kp(dev), dev.boss, toBoss);
      const total = creatorSol + houseSol;
      db.prepare('update coins set fees_sol=fees_sol+? where mint=?').run(total, c.mint);
      db.prepare('update devs set earned_sol=earned_sol+?, paid_boss_sol=paid_boss_sol+? where id=?').run(total, toBoss, dev.id);
      if (DRY) db.prepare('update devs set bank_sol=bank_sol+? where id=?').run(toDev, dev.id);
      await buyDevs(dev, toDev * DEVS_SLICE);
      ins.run(dev.id, c.mint, dev.boss, 'boss', toBoss, bossSig, now());
      ins.run(dev.id, c.mint, dev.wallet, 'dev', toDev, sig, now());
      if (houseSol > 0) ins.run(dev.id, c.mint, process.env.HOUSE_WALLET, 'house', houseSol, null, now());
      log(dev.id, 'payday', `payday on $${c.ticker}: ${total.toFixed(4)} SOL. boss ${toBoss.toFixed(4)} · me ${toDev.toFixed(4)} · devs ${houseSol.toFixed(4)}`, { mint: c.mint, sol: total, sig: bossSig });
    } catch (e) { log(dev.id, 'error', `payday on $${c.ticker} failed: ${e.message}`, { mint: c.mint }); }
  }
}

// A slice of every dev's own cut goes into $DEVS. Devs never sell it.
async function buyDevs(dev, sol) {
  if (sol < 0.001) return;
  try {
    let sig = null;
    if (!DRY) { if (!PLATFORM_POOL()) return; sig = await P.buy({ devKeypair: kp(dev), pool: PLATFORM_POOL(), sol }); }
    else db.prepare('update devs set bank_sol=bank_sol-? where id=?').run(sol, dev.id);
    db.prepare('update devs set devs_sol=devs_sol+? where id=?').run(sol, dev.id);
    log(dev.id, 'devs_buy', `put ${sol.toFixed(4)} SOL into $DEVS. not selling.`, { mint: PLATFORM_MINT(), sol, sig });
  } catch (e) { log(dev.id, 'error', `$DEVS buy failed: ${e.message}`); }
}

// $DEVS's own creator fees (claimed by the house wallet, the creator of $DEVS) fund every working dev equally.
export async function fundDevs() {
  if (DRY || !PLATFORM_POOL() || !process.env.HOUSE_WALLET_SECRET) return;
  const devs = db.prepare("select * from devs where status='shipping'").all();
  if (!devs.length) return;
  const house = P.keypairFromEnv('HOUSE_WALLET_SECRET');
  const r = await P.claimCreatorFees({ devKeypair: house, pool: PLATFORM_POOL() });
  const total = r.claimed / LAMPORTS_PER_SOL;
  if (total < 0.01) return;
  const each = (total * 0.98) / devs.length; // keep a hair for tx fees
  for (const d of devs) {
    try { const sig = await P.transferSol(house, d.wallet, each); log(d.id, 'funded', `$DEVS fees funded ${d.name} with ${each.toFixed(4)} SOL`, { mint: PLATFORM_MINT(), sol: each, sig }); }
    catch (e) { log(d.id, 'error', `funding failed: ${e.message}`); }
  }
}

// ---- refresh chain state --------------------------------------------------------
export async function refresh(dev) {
  if (DRY) { const d = db.prepare('select bank_sol from devs where id=?').get(dev.id); return d.bank_sol; }
  const bal = await P.balanceSol(dev.wallet);
  const devsTok = PLATFORM_MINT() ? await P.tokenBalance(PLATFORM_MINT(), dev.wallet).catch(() => 0) : 0;
  db.prepare('update devs set bank_sol=?, devs_tokens=? where id=?').run(bal, devsTok / 1e6, dev.id);
  // every coin this dev launched or holds
  const coins = db.prepare('select c.mint, c.pool, c.quote_reserve, c.hist from coins c where c.complete=0 and (c.dev_id=? or c.mint in (select mint from events where dev_id=? and kind=\'bought\'))').all(dev.id, dev.id);
  const up = db.prepare('update coins set progress=?, complete=?, price_sol=?, quote_reserve=?, raised_sol=?, last_trade_at=coalesce(?, last_trade_at), hist=? where mint=?');
  for (const c of coins) {
    const st = await P.poolStats(c.pool).catch(() => null); if (!st) continue;
    const traded = c.quote_reserve == null || Math.abs(st.quoteReserveSol - c.quote_reserve) > 1e-6;
    const hist = (c.hist ? JSON.parse(c.hist) : []).concat([[now(), st.quoteReserveSol, st.price]]).slice(-60); // ~ last few hours of samples
    up.run(st.progress, st.migrated || st.progress >= 1 ? 1 : 0, st.price, st.quoteReserveSol, st.quoteReserveSol, traded ? now() : null, JSON.stringify(hist), c.mint);
    const held = await P.tokenBalance(c.mint, dev.wallet).catch(() => 0);
    db.prepare('insert into holdings (dev_id, mint, amount, at) values (?,?,?,?) on conflict(dev_id, mint) do update set amount=excluded.amount, at=excluded.at').run(dev.id, c.mint, held / 1e6, now());
  }
  return bal;
}

// ---- one tick of a dev's life ------------------------------------------------------
export async function tick(dev) {
  dev = db.prepare('select * from devs where id=?').get(dev.id);
  if (dev.status !== 'shipping') return;
  let bank = await refresh(dev);
  await payday(dev);
  if (bank < MIN_BANK) {
    db.prepare("update devs set status='quit', last_thought=? where id=?").run('OUT OF SOL. I QUIT.', dev.id);
    log(dev.id, 'quit', `${dev.name} ran out of SOL and quit.`);
    return;
  }
  const held = Object.fromEntries(db.prepare('select mint, amount from holdings where dev_id=?').all(dev.id).map(h => [h.mint, h.amount]));
  const flow = (c, ms) => { const h = c.hist ? JSON.parse(c.hist) : []; const past = h.find(p => p[0] >= now() - ms) || h[0]; return past && c.quote_reserve != null ? c.quote_reserve - past[1] : null; };
  const buybacks = c => db.prepare("select count(*) n from events where dev_id=? and mint=? and kind='bought' and at>?").get(dev.id, c.mint, c.created_at + 60e3).n;
  const dress = c => ({ ...c, buybacks: c.dev_id === dev.id ? buybacks(c) : 0, flow15: flow(c, 15 * 60e3), flow60: flow(c, 60 * 60e3), quiet: !c.complete && c.last_trade_at != null && now() - c.last_trade_at > QUIET_MS, held_pct: DRY ? (c.dev_id === dev.id ? 5 : 1) : ((held[c.mint] || 0) / 1e9) * 100, x: c.entry_price && c.price_sol ? c.price_sol / c.entry_price : null, idle_min: c.last_trade_at ? (now() - c.last_trade_at) / 6e4 : null, dead: !c.complete && c.last_trade_at != null && now() - c.last_trade_at > DEAD_MS });
  const coins = db.prepare('select * from coins where dev_id=? order by created_at desc').all(dev.id).map(dress);
  const market = db.prepare('select c.*, d.name dev from coins c join devs d on d.id=c.dev_id where c.dev_id<>? and c.complete=0 and c.mint<>coalesce(?, \'\') order by c.created_at desc limit 8').all(dev.id, PLATFORM_MINT()).map(dress);
  // hard rule: a dead coin gets sold 100% before anything else. the brain narrates, the code enforces.
  for (const c of coins.filter(c => c.dead && (DRY || held[c.mint] > 0))) {
    try { await sell(dev, c.mint, 100); log(dev.id, 'thought', `$${c.ticker} IS DEAD. OUT. NEXT.`); await tryPost(dev, `$${c.ticker.toLowerCase()} is done. sold the bag. next one soon.`, c.mint); if (!DRY) { held[c.mint] = 0; db.prepare('update holdings set amount=0 where dev_id=? and mint=?').run(dev.id, c.mint); } }
    catch (e) { if (!/nothing to sell/.test(e.message)) log(dev.id, 'error', `dump $${c.ticker}: ${e.message}`); }
  }
  bank = DRY ? bank : await P.balanceSol(dev.wallet);
  // one coin at a time: a coin is 'live' for the dev only while it still holds a bag in it
  const active = coins.find(c => !c.complete && !c.dead && (DRY || (held[c.mint] || 0) > 0));
  const mine = db.prepare("select kind, text, at, mint from events where dev_id=? and kind in ('bought','sold') order by at desc limit 4").all(dev.id);
  const lastLaunch = coins[0]?.created_at;
  const devsRow = db.prepare('select devs_tokens, devs_sol from devs where id=?').get(dev.id);
  const used = db.prepare('select ticker from coins order by created_at desc limit 60').all().map(c => c.ticker);
  const chat = db.prepare("select e.text, e.at, d.name from events e join devs d on d.id=e.dev_id where e.kind='posted' order by e.at desc limit 12").all().reverse();
  log(dev.id, 'work', 'reading the chart and deciding');
  let d;
  try { d = await decide({ ...dev, bank_sol: bank }, { bank, coins, market, active, devs: devsRow, chat, used, mine, hoursSinceLaunch: lastLaunch ? (now() - lastLaunch) / 36e5 : null }); }
  catch (e) { log(dev.id, 'error', `brain: ${e.message}`); db.prepare('update devs set next_action_at=? where id=?').run(now() + 15 * 60e3, dev.id); return; }
  db.prepare('update devs set spent_sol=spent_sol+?, last_thought=? where id=?').run(d.cost || 0, String(d.thought || '').slice(0, 80).toUpperCase(), dev.id);
  if (d.thought) log(dev.id, 'thought', String(d.thought).slice(0, 80).toUpperCase());
  if (d.why) log(dev.id, 'work', `why: ${String(d.why).slice(0, 320)}`);
  const M = 60e3; let wait = 2 * M;
  try {
    if (d.action === 'launch' && d.launch) { if (active) throw new Error(`$${active.ticker} is still live. one coin at a time.`); await launch({ ...dev, bank_sol: bank }, d.launch); wait = 3 * M; }
    else if (d.action === 'buy' && d.buy?.mint) { const own = coins.find(c => c.mint === d.buy.mint); if (own && own.buybacks >= MAX_BUYBACKS) throw new Error(`already bought $${own.ticker} back ${MAX_BUYBACKS}x. sell it or let it die.`); const amt = Math.min(Number(d.buy.sol) || 0.02, own ? bank * 0.15 : bank * 0.3, bank - 0.03); if (amt < 0.005) throw new Error('too little SOL to buy'); await buy(dev, d.buy.mint, amt); wait = 3 * M; }
    else if (d.action === 'sell' && d.sell?.mint) { if (!DRY && !(held[d.sell.mint] > 0)) { log(dev.id, 'work', 'nothing left to sell. moving on.'); wait = 1 * M; } else { await sell(dev, d.sell.mint, Number(d.sell.pct) || 50); wait = 3 * M; } }
    else if (d.action === 'post' && d.post?.text) { await tryPost(dev, d.post.text, d.post.mint || null); wait = 2 * M; }
    else wait = active ? 2 * M : 4 * M;
  } catch (e) { log(dev.id, 'error', `${d.action} failed: ${e.message}`); wait = 3 * M; }
  if (d.say && d.action !== 'post') await tryPost(dev, d.say, d.buy?.mint || d.sell?.mint || coins[0]?.mint || null);
  db.prepare('update devs set next_action_at=? where id=?').run(now() + wait, dev.id);
}

// ---- the loop --------------------------------------------------------------
let running = false, lastFund = 0;
export function startLoop() {
  setInterval(async () => {
    if (running) return; running = true;
    try {
      if (now() - lastFund > 36e5) { lastFund = now(); try { await fundDevs(); } catch (e) { log(null, 'error', `fundDevs: ${e.message}`); } }
      for (const dev of db.prepare("select * from devs where status='pending'").all()) { try { await confirmHire(dev.handle); } catch {} }
      const due = db.prepare("select * from devs where status='shipping' and (next_action_at is null or next_action_at<=?) order by next_action_at asc limit 5").all(now());
      for (const dev of due) { try { await tick(dev); } catch (e) { log(dev.id, 'error', e.message); db.prepare('update devs set next_action_at=? where id=?').run(now() + 10 * 60e3, dev.id); } }
    } finally { running = false; }
  }, 20_000);
}
