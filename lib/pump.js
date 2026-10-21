// pump.fun integration, carried over from init (proven on mainnet): RPC with fallback, curve reads,
// fee distribution. Launch/buy/sell instructions for devs live in dev.js because each dev signs for itself.
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, LAMPORTS_PER_SOL, SystemProgram } from '@solana/web3.js';
import bs58 from 'bs58';
import { createRequire } from 'node:module';
const pkg = createRequire(import.meta.url)('@pump-fun/pump-sdk');
const { PUMP_SDK, OnlinePumpSdk, feeSharingConfigPda, bondingCurvePda, isSharingConfigEditable } = pkg;

const PUBLIC_RPC = process.env.SOLANA_FALLBACK_RPC || 'https://api.mainnet-beta.solana.com';
const primaryRpc = () => process.env.SOLANA_RPC_URL || (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : PUBLIC_RPC);
let downUntil = 0;
export const rpcState = () => ({ primary_ok: Date.now() >= downUntil, using: Date.now() < downUntil ? 'public Solana RPC (paid RPC unavailable)' : primaryRpc() === PUBLIC_RPC ? 'public Solana RPC' : 'Helius' });
async function rpcFetch(url, init) {
  const primary = primaryRpc();
  if (primary !== PUBLIC_RPC && String(url) === primary && Date.now() < downUntil) url = PUBLIC_RPC;
  const r = await fetch(url, init);
  if (String(url) === primary && primary !== PUBLIC_RPC && [401, 403, 429].includes(r.status)) {
    const t = await r.clone().text().catch(() => '');
    if (/max usage|credit|suspend|invalid|unauthori|not allowed|limit/i.test(t) || r.status !== 429) {
      if (Date.now() >= downUntil) console.warn(`[rpc] paid RPC answered ${r.status}; using the public Solana RPC for 10 minutes`);
      downUntil = Date.now() + 10 * 60e3;
      return fetch(PUBLIC_RPC, init);
    }
  }
  return r;
}
let conn, online;
export const connection = () => (conn ||= new Connection(primaryRpc(), { commitment: 'confirmed', fetch: rpcFetch }));
const sdk = () => (online ||= new OnlinePumpSdk(connection()));
export const houseWallet = () => new PublicKey(process.env.HOUSE_WALLET);
export const keypairFromEnv = name => (process.env[name] ? Keypair.fromSecretKey(bs58.decode(process.env[name])) : null);

async function compile(payer, instructions, signers = []) {
  const { blockhash, lastValidBlockHeight } = await connection().getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message());
  if (signers.length) tx.sign(signers);
  return { tx, blockhash, lastValidBlockHeight };
}

const SOL_MINT_STR = 'So11111111111111111111111111111111111111112';
export const curveAddress = mintStr => bondingCurvePda(new PublicKey(mintStr));
export function priceFromCurve(info) {
  if (!info) return null;
  const c = PUMP_SDK.decodeBondingCurve(info);
  if (c.complete || c.virtualTokenReserves.isZero() || (c.quoteMint && c.quoteMint.toBase58() !== SOL_MINT_STR && c.quoteMint.toBase58() !== PublicKey.default.toBase58())) return null;
  const price_sol = (Number(c.virtualQuoteReserves) / 1e9) / (Number(c.virtualTokenReserves) / 1e6);
  return { price_sol, supply: Number(c.tokenTotalSupply) / 1e6, raised_sol: Number(c.realQuoteReserves) / 1e9 };
}
export async function curvePrices(mints) {
  const out = {};
  for (let i = 0; i < mints.length; i += 90) {
    const part = mints.slice(i, i + 90), infos = await connection().getMultipleAccountsInfo(part.map(curveAddress));
    part.forEach((m, k) => { try { out[m] = priceFromCurve(infos[k]); } catch { out[m] = null; } });
  }
  return out;
}
export async function readCoin(mintStr) {
  const mint = new PublicKey(mintStr);
  const [curveInfo, cfgInfo] = await connection().getMultipleAccountsInfo([bondingCurvePda(mint), feeSharingConfigPda(mint)]);
  if (!curveInfo) return { exists: false };
  const curve = PUMP_SDK.decodeBondingCurve(curveInfo);
  let split = null;
  if (cfgInfo) {
    const cfg = PUMP_SDK.decodeSharingConfig(cfgInfo);
    split = { shareholders: cfg.shareholders.map(s => ({ address: s.address.toBase58(), bps: s.shareBps })), locked: !isSharingConfigEditable({ sharingConfig: cfg }) };
  }
  return { exists: true, creator: curve.creator.toBase58(), complete: curve.complete, split };
}

// Anyone may trigger distribution; the house wallet pays the small network fee. pump.fun pays each shareholder directly.
export async function distribute(mintStr) {
  const payer = keypairFromEnv('HOUSE_WALLET_SECRET');
  if (!payer) throw new Error('HOUSE_WALLET_SECRET is not set');
  const mint = new PublicKey(mintStr);
  const check = await sdk().getMinimumDistributableFee(mint);
  if (!check.canDistribute) return { distributed: false, pending_lamports: check.distributableFees.toString() };
  if (Number(check.distributableFees) < Number(process.env.MIN_DISTRIBUTE_SOL || 0.003) * LAMPORTS_PER_SOL) return { distributed: false, waiting_for: 'more fees' };
  const { instructions } = await sdk().buildDistributeCreatorFeesInstructions(mint, { payer: payer.publicKey });
  const { tx, blockhash, lastValidBlockHeight } = await compile(payer.publicKey, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...instructions], [payer]);
  const sig = await connection().sendTransaction(tx, { maxRetries: 3 });
  const conf = await connection().confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (conf.value.err) throw new Error(`distribution failed on-chain: ${JSON.stringify(conf.value.err)}`);
  const parsed = await connection().getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  const keys = parsed.transaction.message.getAccountKeys({ accountKeysFromLookups: parsed.meta.loadedAddresses }).keySegments().flat().map(k => k.toBase58());
  const deltas = {}; keys.forEach((k, i) => { const d = parsed.meta.postBalances[i] - parsed.meta.preBalances[i]; if (d) deltas[k] = d; });
  return { distributed: true, signature: sig, total_lamports: check.distributableFees.toString(), fee_lamports: parsed.meta.fee, deltas };
}

export async function balanceSol(addr) { return (await connection().getBalance(new PublicKey(addr))) / LAMPORTS_PER_SOL; }
export async function payFrom(secretEnv, to, sol) {
  const payer = keypairFromEnv(secretEnv);
  const { tx, blockhash, lastValidBlockHeight } = await compile(payer.publicKey, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey(to), lamports: Math.floor(sol * LAMPORTS_PER_SOL) })], [payer]);
  const sig = await connection().sendTransaction(tx, { maxRetries: 3 });
  const conf = await connection().confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (conf.value.err) throw new Error(`transfer failed: ${JSON.stringify(conf.value.err)}`);
  return sig;
}
export { LAMPORTS_PER_SOL };
