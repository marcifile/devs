// A dev: its own keypair, its own coins, its own decisions. The house wallet only pays for
// distribution network fees and receives the house cut. Everything the dev does is signed by the dev.
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import BN from 'bn.js';
import { createRequire } from 'node:module';
import { db, log, now } from './db.js';
import * as P from './pump.js';
import { decide, nameSelf } from './brain.js';
import { iconSvg } from './icon.js';
import { pinBuffer, pinJson, gatewayUrl } from './pinata.js';
import * as X from './x.js';

const pkg = createRequire(import.meta.url)('@pump-fun/pump-sdk');
const { PUMP_SDK, OnlinePumpSdk, getBuyTokenAmountFromSolAmount, bondingCurvePda } = pkg;
let online; const sdk = () => (online ||= new OnlinePumpSdk(P.connection()));

export const DEV_BPS = Number(process.env.FEE_DEV_BPS || 2000);
export const HOUSE_BPS = Number(process.env.FEE_HOUSE_BPS || 1000);
export const BOSS_BPS = 10_000 - DEV_BPS - HOUSE_BPS;
export const HIRE_SOL = Number(process.env.HIRE_SOL || 0.5);
const MIN_BANK = 0.02; // below this a dev can't afford a launch; it quits
export const DRY = process.env.DRY_RUN === '1'; // simulate chain writes; for local testing only

const kp = dev => Keypair.fromSecretKey(bs58.decode(dev.secret));
const cu = units => [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150_000 })];

async function send(payer, ixs, signers) {
  const { blockhash, lastValidBlockHeight } = await P.connection().getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  tx.sign([payer, ...signers]);
  const sig = await P.connection().sendTransaction(tx, { maxRetries: 3 });
  const conf = await P.connection().confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (conf.value.err) throw new Error(`tx failed: ${JSON.stringify(conf.value.err)}`);
  return sig;
}

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
    db.prepare('insert into coins (mint, dev_id, ticker, name, description, image, metadata_uri, launch_sig, split_sig, raised_sol, created_at) values (?,?,?,?,?,?,?,?,?,?,?)')
      .run(mintStr, dev.id, ticker, name, description, `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`, '', 'dry', 'dry', buySol, now());
    db.prepare('update devs set launches=launches+1, bank_sol=bank_sol-?-0.03 where id=?').run(buySol, dev.id);
    log(dev.id, 'launched', `launched $${ticker}`, { mint: mintStr, sig: null });
    if (buySol > 0) log(dev.id, 'bought', `bought ${buySol} SOL of $${ticker}`, { mint: mintStr, sol: buySol });
    log(dev.id, 'split', `fee split locked: boss ${BOSS_BPS / 100}% · dev ${DEV_BPS / 100}% · devs ${HOUSE_BPS / 100}%`, { mint: mintStr });
    await tryPost(dev, `$${ticker} is live. ${description.slice(0, 120)}`);
    return mintStr;
  }
  const img = await pinBuffer(Buffer.from(svg), `${ticker}.svg`, 'image/svg+xml');
  const meta = await pinJson({ name, symbol: ticker, description, image: gatewayUrl(img.cid), showName: true, createdOn: 'https://devs.fun', twitter: process.env.X_PROJECT_URL || undefined, website: process.env.SITE_URL }, `${ticker}.json`);
  const uri = gatewayUrl(meta.cid);

  const signer = kp(dev), user = signer.publicKey, mint = Keypair.generate();
  const global = await sdk().fetchGlobal();
  let createIxs, buyIxs = [];
  if (buySol > 0) {
    const solAmount = new BN(Math.round(buySol * LAMPORTS_PER_SOL));
    const feeConfig = await sdk().fetchFeeConfig().catch(() => null);
    const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: solAmount });
    const all = await PUMP_SDK.createV2AndBuyInstructions({ global, mint: mint.publicKey, name, symbol: ticker, uri, creator: user, user, amount, solAmount, mayhemMode: false });
    createIxs = [all[0]]; buyIxs = all.slice(1);
  } else {
    createIxs = [await PUMP_SDK.createV2Instruction({ mint: mint.publicKey, name, symbol: ticker, uri, creator: user, user, mayhemMode: false })];
  }
  const launchSig = await send(signer, [...cu(300_000), ...createIxs], [mint]);
  db.prepare('insert into coins (mint, dev_id, ticker, name, description, image, metadata_uri, launch_sig, created_at) values (?,?,?,?,?,?,?,?,?)')
    .run(mint.publicKey.toBase58(), dev.id, ticker, name, description, gatewayUrl(img.cid), uri, launchSig, now());
  log(dev.id, 'launched', `launched $${ticker}`, { mint: mint.publicKey.toBase58(), sig: launchSig });
  if (buyIxs.length) {
    try { const s = await send(signer, [...cu(300_000), ...buyIxs], []); log(dev.id, 'bought', `bought ${buySol} SOL of $${ticker}`, { mint: mint.publicKey.toBase58(), sol: buySol, sig: s }); } catch (e) { log(dev.id, 'error', `first buy failed: ${e.message}`, { mint: mint.publicKey.toBase58() }); }
  }
  // Fee split: boss / dev / house. Set once, then locked by pump.fun.
  try {
    const shares = [
      { address: new PublicKey(dev.boss), shareBps: BOSS_BPS },
      { address: user, shareBps: DEV_BPS },
      { address: P.houseWallet(), shareBps: HOUSE_BPS },
    ];
    const ixs = [
      await PUMP_SDK.createFeeSharingConfig({ creator: user, mint: mint.publicKey, pool: null }),
      await PUMP_SDK.updateFeeShares({
        authority: user, mint: mint.publicKey, currentShareholders: [user], bondingCurveComplete: false,
        newShareholders: shares,
      }),
    ];
    const s = await send(signer, [...cu(250_000), ...ixs], []);
    db.prepare('update coins set split_sig=? where mint=?').run(s, mint.publicKey.toBase58());
    log(dev.id, 'split', `fee split locked: boss ${BOSS_BPS / 100}% · dev ${DEV_BPS / 100}% · devs ${HOUSE_BPS / 100}%`, { mint: mint.publicKey.toBase58(), sig: s });
  } catch (e) { log(dev.id, 'error', `fee split failed: ${e.message}`, { mint: mint.publicKey.toBase58() }); }
  db.prepare('update devs set launches=launches+1 where id=?').run(dev.id);
  await tryPost(dev, `$${ticker} is live. ${description.slice(0, 120)} ${process.env.SITE_URL}/c/${mint.publicKey.toBase58()}`);
  return mint.publicKey.toBase58();
}

async function buy(dev, mintStr, sol) {
  if (DRY) { const c = db.prepare('select ticker from coins where mint=?').get(mintStr); if (!c) throw new Error('unknown coin'); db.prepare('update devs set bank_sol=bank_sol-? where id=?').run(sol, dev.id); db.prepare('update coins set raised_sol=raised_sol+? where mint=?').run(sol, mintStr); log(dev.id, 'bought', `bought ${sol} SOL of $${c.ticker}`, { mint: mintStr, sol }); return 'dry'; }
  const signer = kp(dev), mint = new PublicKey(mintStr);
  const global = await sdk().fetchGlobal();
  const curveInfo = await P.connection().getAccountInfo(bondingCurvePda(mint));
  if (!curveInfo) throw new Error('no curve');
  const bondingCurve = PUMP_SDK.decodeBondingCurve(curveInfo);
  if (bondingCurve.complete) throw new Error('graduated');
  const solAmount = new BN(Math.round(sol * LAMPORTS_PER_SOL));
  const feeConfig = await sdk().fetchFeeConfig().catch(() => null);
  const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: bondingCurve.tokenTotalSupply, bondingCurve, amount: solAmount });
  const ixs = await sdk().buyInstructions({ global, bondingCurveAccountInfo: curveInfo, bondingCurve, mint, user: signer.publicKey, amount, solAmount, slippage: 5 });
  const sig = await send(signer, [...cu(300_000), ...ixs], []);
  const c = db.prepare('select ticker from coins where mint=?').get(mintStr);
  log(dev.id, 'bought', `bought ${sol} SOL of $${c?.ticker || mintStr.slice(0, 4)}`, { mint: mintStr, sol, sig });
  return sig;
}

async function sell(dev, mintStr, pct) {
  if (DRY) { const c = db.prepare('select ticker from coins where mint=?').get(mintStr); if (!c) throw new Error('unknown coin'); log(dev.id, 'sold', `sold ${pct}% of $${c.ticker}`, { mint: mintStr }); return 'dry'; }
  const signer = kp(dev), mint = new PublicKey(mintStr);
  const { getAssociatedTokenAddressSync, getAccount } = await import('@solana/spl-token');
  const ata = getAssociatedTokenAddressSync(mint, signer.publicKey);
  const acct = await getAccount(P.connection(), ata).catch(() => null);
  if (!acct || acct.amount === 0n) throw new Error('nothing to sell');
  const amount = new BN((acct.amount * BigInt(Math.round(Math.max(1, Math.min(100, pct))))) / 100n + '');
  const global = await sdk().fetchGlobal();
  const curveInfo = await P.connection().getAccountInfo(bondingCurvePda(mint));
  const bondingCurve = PUMP_SDK.decodeBondingCurve(curveInfo);
  const ixs = await sdk().sellInstructions({ global, bondingCurveAccountInfo: curveInfo, bondingCurve, mint, user: signer.publicKey, amount, solAmount: new BN(0), slippage: 10 });
  const sig = await send(signer, [...cu(300_000), ...ixs], []);
  const c = db.prepare('select ticker from coins where mint=?').get(mintStr);
  log(dev.id, 'sold', `sold ${pct}% of $${c?.ticker || mintStr.slice(0, 4)}`, { mint: mintStr, sig });
  return sig;
}

async function tryPost(dev, text) {
  try {
    const id = await X.post(`${dev.name}: ${text}`.slice(0, 280));
    if (id) log(dev.id, 'posted', text.slice(0, 200), { sig: id });
  } catch (e) { log(dev.id, 'error', `post failed: ${e.message}`); }
}

// ---- payday ---------------------------------------------------------------
// Distribute creator fees on each of the dev's coins. pump.fun pays the three shareholders directly.
export async function payday(dev) {
  const coins = db.prepare('select * from coins where dev_id=?').all(dev.id);
  for (const c of coins) {
    try {
      const r = DRY
        ? (Math.random() < 0.5 ? { distributed: false } : (() => { const t = 0.004 + Math.random() * 0.02, L = Math.round(t * LAMPORTS_PER_SOL); return { distributed: true, signature: null, total_lamports: String(L), fee_lamports: 5000, deltas: { [dev.boss]: Math.round(L * BOSS_BPS / 1e4), [dev.wallet]: Math.round(L * DEV_BPS / 1e4), [process.env.HOUSE_WALLET]: Math.round(L * HOUSE_BPS / 1e4) - 5000 } }; })())
        : await P.distribute(c.mint);
      if (!r.distributed) continue;
      const total = Number(r.total_lamports) / LAMPORTS_PER_SOL;
      const toBoss = (r.deltas[dev.boss] || 0) / LAMPORTS_PER_SOL;
      const toDev = (r.deltas[dev.wallet] || 0) / LAMPORTS_PER_SOL;
      const toHouse = Math.max(0, ((r.deltas[process.env.HOUSE_WALLET] || 0) + r.fee_lamports) / LAMPORTS_PER_SOL); // house also paid the network fee
      db.prepare('update coins set fees_sol=fees_sol+? where mint=?').run(total, c.mint);
      db.prepare('update devs set earned_sol=earned_sol+?, paid_boss_sol=paid_boss_sol+? where id=?').run(total, toBoss, dev.id);
      if (DRY) db.prepare('update devs set bank_sol=bank_sol+? where id=?').run(toDev, dev.id);
      const ins = db.prepare('insert into payouts (dev_id, mint, to_wallet, role, sol, sig, at) values (?,?,?,?,?,?,?)');
      if (toBoss > 0) ins.run(dev.id, c.mint, dev.boss, 'boss', toBoss, r.signature, now());
      if (toDev > 0) ins.run(dev.id, c.mint, dev.wallet, 'dev', toDev, r.signature, now());
      if (toHouse > 0) ins.run(dev.id, c.mint, process.env.HOUSE_WALLET, 'house', toHouse, r.signature, now());
      log(dev.id, 'payday', `payday on $${c.ticker}: ${total.toFixed(4)} SOL. boss ${toBoss.toFixed(4)} · me ${toDev.toFixed(4)} · devs ${toHouse.toFixed(4)}`, { mint: c.mint, sol: total, sig: r.signature });
    } catch (e) { log(dev.id, 'error', `payday on $${c.ticker} failed: ${e.message}`, { mint: c.mint }); }
  }
}

// ---- refresh chain state --------------------------------------------------------
export async function refresh(dev) {
  if (DRY) { const d = db.prepare('select bank_sol from devs where id=?').get(dev.id); return d.bank_sol; }
  const bal = await P.balanceSol(dev.wallet);
  db.prepare('update devs set bank_sol=? where id=?').run(bal, dev.id);
  const coins = db.prepare('select mint from coins where dev_id=? and complete=0').all(dev.id).map(c => c.mint);
  if (coins.length) {
    const prices = await P.curvePrices(coins);
    const up = db.prepare('update coins set price_sol=?, raised_sol=?, complete=? where mint=?');
    for (const m of coins) { const p = prices[m]; if (p) up.run(p.price_sol, p.raised_sol, 0, m); else up.run(null, null, 1, m); }
  }
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
