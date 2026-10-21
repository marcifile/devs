// A dev: its own keypair, its own coins, its own decisions. The house wallet only pays for
// distribution network fees and receives the house cut. Everything the dev does is signed by the dev.
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { db, log, now } from './db.js';
import * as P from './meteora.js';
const { LAMPORTS_PER_SOL } = P;
import { decide, nameSelf } from './brain.js';
import { iconSvg } from './icon.js';
import { pinBuffer, pinJson, gatewayUrl } from './pinata.js';
import * as X from './x.js';


export const DEV_BPS = Number(process.env.FEE_DEV_BPS || 2000);
export const HOUSE_BPS = Number(process.env.FEE_HOUSE_BPS || 1000);
export const BOSS_BPS = 10_000 - DEV_BPS - HOUSE_BPS;
export const HIRE_SOL = Number(process.env.HIRE_SOL || 0.5);
const MIN_BANK = 0.02; // below this a dev can't afford a launch; it quits
export const DRY = process.env.DRY_RUN === '1'; // simulate chain writes; for local testing only

const kp = dev => Keypair.fromSecretKey(bs58.decode(dev.secret));
// Of the creator share the dev receives from Meteora, this fraction is forwarded to the boss.
const BOSS_OF_CREATOR = BOSS_BPS / (BOSS_BPS + DEV_BPS);

// ---- hiring ---------------------------------------------------------------
export function pendingHire(boss, persona) {
  // The boss pays HIRE_SOL to a fresh dev wallet. We make the wallet first, hand back the address, and
  // activate once the deposit lands (see confirmHire).
  const k = Keypair.generate();
  const n = db.prepare('select count(*) c from devs').get().c + 1;
  const handle = `dev_${String(n).padStart(4, '0')}`;
  db.prepare('insert into devs (handle, name, persona, boss, wallet, secret, status, created_at) values (?,?,?,?,?,?,?,?)')
    .run(handle, handle, persona.slice(0, 200), boss, k.publicKey.toBase58(), bs58.encode(k.secretKey), 'pending', now());
  return { handle, wallet: k.publicKey.toBase58(), amount: HIRE_SOL };
}

export async function confirmHire(handle) {
  const dev = db.prepare('select * from devs where handle=?').get(handle);
  if (!dev) return null;
  if (dev.status !== 'pending') return dev;
  const bal = DRY ? HIRE_SOL : await P.balanceSol(dev.wallet);
  if (bal < HIRE_SOL * 0.98) return { ...dev, funded: false, balance: bal };
  let name = dev.handle, thought = 'I WAS HIRED. LOOKING AROUND.', cost = 0;
  try { ({ name, thought, cost } = await nameSelf(dev.persona)); } catch {}
  if (db.prepare('select 1 from devs where name=? and id<>?').get(name, dev.id)) name = `${name}${dev.id}`;
  db.prepare('update devs set status=?, name=?, bank_sol=?, spent_sol=spent_sol+?, last_thought=?, next_action_at=? where id=?')
    .run('shipping', name, bal, cost, thought, now() + 30_000, dev.id);
  log(dev.id, 'hired', `${name} hired. ${bal.toFixed(2)} SOL in the bank.`, { sol: bal });
  log(dev.id, 'thought', thought);
  return db.prepare('select * from devs where id=?').get(dev.id);
}

// ---- actions ---------------------------------------------------------------
async function launch(dev, L) {
  if (dev.bank_sol < 0.08) throw new Error('not enough SOL to launch safely');
  const ticker = String(L.ticker || 'DEV').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'DEV';
  const name = String(L.name || ticker).slice(0, 32);
  const description = String(L.description || '').slice(0, 300);
  const buySol = Math.max(0, Math.min(Number(L.buy_sol) || 0, Math.max(0, dev.bank_sol - 0.05)));

  const svg = iconSvg(ticker, `${dev.handle}:${ticker}:${now()}`);
  if (DRY) {
    const mintStr = Keypair.generate().publicKey.toBase58();
    db.prepare('insert into coins (mint, dev_id, ticker, name, description, image, metadata_uri, launch_sig, split_sig, pool, raised_sol, created_at) values (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(mintStr, dev.id, ticker, name, description, `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`, '', 'dry', 'dry', 'dry', buySol, now());
    db.prepare('update devs set launches=launches+1, bank_sol=bank_sol-?-0.03 where id=?').run(buySol, dev.id);
    log(dev.id, 'launched', `launched $${ticker}`, { mint: mintStr, sig: null });
    if (buySol > 0) log(dev.id, 'bought', `bought ${buySol} SOL of $${ticker}`, { mint: mintStr, sol: buySol });
    log(dev.id, 'split', `fee split locked: boss ${BOSS_BPS / 100}% · dev ${DEV_BPS / 100}% · devs ${HOUSE_BPS / 100}%`, { mint: mintStr });
    await tryPost(dev, `$${ticker} is live. ${description.slice(0, 120)}`);
    return mintStr;
  }
  const img = await pinBuffer(Buffer.from(svg), `${ticker}.svg`, 'image/svg+xml');
  const meta = await pinJson({ name, symbol: ticker, description, image: gatewayUrl(img.cid), createdOn: 'https://devs.fun', website: process.env.SITE_URL }, `${ticker}.json`);
  const uri = gatewayUrl(meta.cid);
  const { mint: mintStr, pool, sig } = await P.launchPool({ devKeypair: kp(dev), name, symbol: ticker, uri, buySol });
  db.prepare('insert into coins (mint, dev_id, ticker, name, description, image, metadata_uri, launch_sig, split_sig, pool, created_at) values (?,?,?,?,?,?,?,?,?,?,?)')
    .run(mintStr, dev.id, ticker, name, description, gatewayUrl(img.cid), uri, sig, sig, pool, now());
  log(dev.id, 'launched', `launched $${ticker} on meteora`, { mint: mintStr, sig });
  if (buySol > 0) log(dev.id, 'bought', `bought ${buySol} SOL of $${ticker}`, { mint: mintStr, sol: buySol, sig });
  log(dev.id, 'split', `fees: boss ${BOSS_BPS / 100}% · dev ${DEV_BPS / 100}% · devs ${HOUSE_BPS / 100}%`, { mint: mintStr });
  db.prepare('update devs set launches=launches+1 where id=?').run(dev.id);
  await tryPost(dev, `$${ticker} is live on meteora. ${description.slice(0, 110)} ${process.env.SITE_URL}/c/${mintStr}`);
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
  const c = db.prepare('select ticker, pool from coins where mint=?').get(mintStr);
  if (!c) throw new Error('unknown coin');
  if (DRY) { log(dev.id, 'sold', `sold ${pct}% of $${c.ticker}`, { mint: mintStr }); return 'dry'; }
  const sig = await P.sellPct({ devKeypair: kp(dev), mint: mintStr, pool: c.pool, pct });
  log(dev.id, 'sold', `sold ${pct}% of $${c.ticker}`, { mint: mintStr, sig });
  return sig;
}

async function tryPost(dev, text) {
  try {
    const id = await X.post(`${dev.name}: ${text}`.slice(0, 280));
    if (id) log(dev.id, 'posted', text.slice(0, 200), { sig: id });
  } catch (e) { log(dev.id, 'error', `post failed: ${e.message}`); }
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
      ins.run(dev.id, c.mint, dev.boss, 'boss', toBoss, bossSig, now());
      ins.run(dev.id, c.mint, dev.wallet, 'dev', toDev, sig, now());
      if (houseSol > 0) ins.run(dev.id, c.mint, process.env.HOUSE_WALLET, 'house', houseSol, null, now());
      log(dev.id, 'payday', `payday on $${c.ticker}: ${total.toFixed(4)} SOL. boss ${toBoss.toFixed(4)} · me ${toDev.toFixed(4)} · devs ${houseSol.toFixed(4)}`, { mint: c.mint, sol: total, sig: bossSig });
    } catch (e) { log(dev.id, 'error', `payday on $${c.ticker} failed: ${e.message}`, { mint: c.mint }); }
  }
}

// ---- refresh chain state --------------------------------------------------------
export async function refresh(dev) {
  if (DRY) { const d = db.prepare('select bank_sol from devs where id=?').get(dev.id); return d.bank_sol; }
  const bal = await P.balanceSol(dev.wallet);
  db.prepare('update devs set bank_sol=? where id=?').run(bal, dev.id);
  const coins = db.prepare('select mint, pool from coins where dev_id=? and complete=0').all(dev.id);
  const up = db.prepare('update coins set progress=?, complete=? where mint=?');
  for (const c of coins) { const p = await P.progress(c.pool); if (p != null) up.run(p, p >= 1 ? 1 : 0, c.mint); }
  return bal;
}

// ---- one tick of a dev's life ------------------------------------------------------
export async function tick(dev) {
  dev = db.prepare('select * from devs where id=?').get(dev.id);
  if (dev.status !== 'shipping') return;
  const bank = await refresh(dev);
  await payday(dev);
  if (bank < MIN_BANK) {
    db.prepare("update devs set status='quit', last_thought=? where id=?").run('OUT OF SOL. I QUIT.', dev.id);
    log(dev.id, 'quit', `${dev.name} ran out of SOL and quit.`);
    return;
  }
  const coins = db.prepare('select * from coins where dev_id=? order by created_at desc').all(dev.id);
  const market = db.prepare('select c.ticker, c.mint, c.raised_sol, d.name dev from coins c join devs d on d.id=c.dev_id where c.dev_id<>? and c.complete=0 order by c.created_at desc limit 8').all(dev.id);
  const lastLaunch = coins[0]?.created_at;
  let d;
  try { d = await decide({ ...dev, bank_sol: bank }, { bank, coins, market, hoursSinceLaunch: lastLaunch ? (now() - lastLaunch) / 36e5 : null }); }
  catch (e) { log(dev.id, 'error', `brain: ${e.message}`); db.prepare('update devs set next_action_at=? where id=?').run(now() + 15 * 60e3, dev.id); return; }
  db.prepare('update devs set spent_sol=spent_sol+?, last_thought=? where id=?').run(d.cost || 0, String(d.thought || '').slice(0, 80).toUpperCase(), dev.id);
  if (d.thought) log(dev.id, 'thought', String(d.thought).slice(0, 80).toUpperCase());
  let wait = 20 * 60e3;
  try {
    if (d.action === 'launch' && d.launch) { await launch({ ...dev, bank_sol: bank }, d.launch); wait = 60 * 60e3; }
    else if (d.action === 'buy' && d.buy?.mint) { const amt = Math.min(Number(d.buy.sol) || 0.02, bank * 0.3, bank - 0.03); if (amt < 0.005) throw new Error('too little SOL to buy'); await buy(dev, d.buy.mint, amt); wait = 15 * 60e3; }
    else if (d.action === 'sell' && d.sell?.mint) { await sell(dev, d.sell.mint, Number(d.sell.pct) || 50); wait = 15 * 60e3; }
    else if (d.action === 'post' && d.post?.text) { await tryPost(dev, d.post.text); wait = 30 * 60e3; }
    else wait = 10 * 60e3;
  } catch (e) { log(dev.id, 'error', `${d.action} failed: ${e.message}`); }
  db.prepare('update devs set next_action_at=? where id=?').run(now() + wait, dev.id);
}

// ---- the loop --------------------------------------------------------------
let running = false;
export function startLoop() {
  setInterval(async () => {
    if (running) return; running = true;
    try {
      for (const dev of db.prepare("select * from devs where status='pending'").all()) { try { await confirmHire(dev.handle); } catch {} }
      const due = db.prepare("select * from devs where status='shipping' and (next_action_at is null or next_action_at<=?) order by next_action_at asc limit 3").all(now());
      for (const dev of due) { try { await tick(dev); } catch (e) { log(dev.id, 'error', e.message); db.prepare('update devs set next_action_at=? where id=?').run(now() + 10 * 60e3, dev.id); } }
    } finally { running = false; }
  }, 20_000);
}
