// Meteora Dynamic Bonding Curve: the launch tech dvd runs on.
//
// Roles, in Meteora's words:
//   partner  = dvd (the launchpad). Owns the config, gets the partner share of trading fees.
//   creator  = the dev. Each dev launches pools under the dvd config and gets the creator share.
// The boss is paid by the dev at payday (dev claims creator fees, forwards BOSS share to the boss).
// Partner share = FEE_HOUSE_BPS; creator share = the rest; the dev keeps FEE_DEV_BPS of that and sends the boss the remainder.
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import BN from 'bn.js';
import bs58 from 'bs58';
import { createRequire } from 'node:module';
const M = createRequire(import.meta.url)('@meteora-ag/dynamic-bonding-curve-sdk');

const SOL = new PublicKey('So11111111111111111111111111111111111111112');
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
export const rpcUrl = () => process.env.SOLANA_RPC_URL || (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : PUBLIC_RPC);
export const rpcState = () => ({ using: rpcUrl() === PUBLIC_RPC ? 'public Solana RPC' : 'Helius' });
let conn, client;
export const connection = () => (conn ||= new Connection(rpcUrl(), 'confirmed'));
export const dbc = () => (client ||= new M.DynamicBondingCurveClient(connection(), 'confirmed'));
export const keypairFromEnv = name => (process.env[name] ? Keypair.fromSecretKey(bs58.decode(process.env[name])) : null);
export const houseWallet = () => new PublicKey(process.env.HOUSE_WALLET);
export const configKey = () => (process.env.DBC_CONFIG ? new PublicKey(process.env.DBC_CONFIG) : null);
export const LAMPORTS_PER_SOL = 1e9;

export async function send(tx, signers, payer) {
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection().getLatestBlockhash()).blockhash;
  return sendAndConfirmTransaction(connection(), tx, [payer, ...signers.filter(s => s.publicKey.toBase58() !== payer.publicKey.toBase58())], { commitment: 'confirmed', maxRetries: 3 });
}

// ---- one-time: the dvd partner config --------------------------------------------------------
// Run `node scripts/partner-config.js` once from the house wallet. Every dev launch points at this config.
export function devsConfigParams({ houseBps }) {
  // creatorTradingFeePercentage is the creator's % of trading fees; the rest is the partner's.
  const creatorPct = Math.round((10_000 - houseBps) / 100);
  return M.buildCurveWithMarketCap({
    // in SOL (the quote token). ~$5k -> ~$70k at $180/SOL. Graduation threshold is derived from these.
    initialMarketCap: 28,
    migrationMarketCap: 400,
    token: { tokenType: M.TokenType.SPLToken, tokenBaseDecimal: M.TokenDecimal.SIX, tokenQuoteDecimal: 9, tokenAuthorityOption: M.TokenAuthorityOption.Immutable, totalTokenSupply: 1_000_000_000, leftover: 0 },
    fee: {
      baseFeeParams: { baseFeeMode: M.BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 } },
      dynamicFeeEnabled: true, collectFeeMode: M.CollectFeeMode.QuoteToken, creatorTradingFeePercentage: creatorPct, poolCreationFee: 0, enableFirstSwapWithMinFee: false,
    },
    migration: { migrationOption: M.MigrationOption.MET_DAMM_V2, migrationFeeOption: M.MigrationFeeOption.FixedBps100, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
    liquidityDistribution: { partnerPermanentLockedLiquidityPercentage: 50, partnerLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 50, creatorLiquidityPercentage: 0 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: M.ActivationType.Slot,
  });
}

export async function createPartnerConfig({ houseBps }) {
  const house = keypairFromEnv('HOUSE_WALLET_SECRET');
  const config = Keypair.generate();
  const params = devsConfigParams({ houseBps });
  const tx = await dbc().partner.createConfig({ ...params, config: config.publicKey, feeClaimer: house.publicKey, leftoverReceiver: house.publicKey, quoteMint: SOL, payer: house.publicKey });
  const sig = await send(tx, [config], house);
  return { config: config.publicKey.toBase58(), sig };
}

// ---- per dev: launch, trade, claim -----------------------------------------------------------------
export async function launchPool({ devKeypair, name, symbol, uri, buySol = 0 }) {
  const config = configKey(); if (!config) throw new Error('DBC_CONFIG is not set (run scripts/partner-config.js)');
  const baseMint = Keypair.generate();
  const createPoolParam = { name, symbol, uri, payer: devKeypair.publicKey, poolCreator: devKeypair.publicKey, config, baseMint: baseMint.publicKey };
  const tx = buySol > 0
    ? await dbc().creator.createPoolWithFirstBuy({ createPoolParam, firstBuyParam: { buyer: devKeypair.publicKey, buyAmount: new BN(Math.round(buySol * LAMPORTS_PER_SOL)), minimumAmountOut: new BN(1), referralTokenAccount: null } })
    : await dbc().creator.createPool(createPoolParam);
  const sig = await send(tx, [baseMint], devKeypair);
  const pool = M.deriveDbcPoolAddress(SOL, baseMint.publicKey, config);
  return { mint: baseMint.publicKey.toBase58(), pool: pool.toBase58(), sig };
}

export async function poolByMint(mintStr) {
  return dbc().state.getPoolByBaseMint(new PublicKey(mintStr));
}

export async function swap({ devKeypair, pool, amountIn, baseForQuote }) {
  const tx = await dbc().pool.swap({ owner: devKeypair.publicKey, pool: new PublicKey(pool), amountIn, minimumAmountOut: new BN(1), swapBaseForQuote: baseForQuote, referralTokenAccount: null });
  return send(tx, [], devKeypair);
}

export async function buy({ devKeypair, pool, sol }) {
  return swap({ devKeypair, pool, amountIn: new BN(Math.round(sol * LAMPORTS_PER_SOL)), baseForQuote: false });
}

export async function sellPct({ devKeypair, mint, pool, pct }) {
  const { getAssociatedTokenAddressSync, getAccount } = await import('@solana/spl-token');
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), devKeypair.publicKey);
  const acct = await getAccount(connection(), ata).catch(() => null);
  if (!acct || acct.amount === 0n) throw new Error('nothing to sell');
  const amount = new BN(((acct.amount * BigInt(Math.round(Math.max(1, Math.min(100, pct))))) / 100n).toString());
  return swap({ devKeypair, pool, amountIn: amount, baseForQuote: true });
}

// Creator (dev) claims its trading fees in SOL. Returns lamports received.
export async function claimCreatorFees({ devKeypair, pool }) {
  if ((await unclaimedCreatorSol(pool)) < 0.001) return { claimed: 0 };
  const before = await connection().getBalance(devKeypair.publicKey);
  const tx = await dbc().creator.claimCreatorTradingFee({ creator: devKeypair.publicKey, payer: devKeypair.publicKey, pool: new PublicKey(pool), maxBaseAmount: new BN(0), maxQuoteAmount: new BN('18446744073709551615') });
  const sig = await send(tx, [], devKeypair);
  const after = await connection().getBalance(devKeypair.publicKey);
  return { claimed: Math.max(0, after - before), sig };
}

// Partner (dvd) claims its share from the house wallet.
export async function claimPartnerFees({ pool }) {
  const house = keypairFromEnv('HOUSE_WALLET_SECRET');
  const tx = await dbc().partner.claimPartnerTradingFee({ feeClaimer: house.publicKey, payer: house.publicKey, pool: new PublicKey(pool), maxBaseAmount: new BN(0), maxQuoteAmount: new BN('18446744073709551615') });
  return send(tx, [], house);
}

export async function progress(pool) {
  const p = await dbc().state.getPoolQuoteTokenCurveProgress(new PublicKey(pool)).catch(() => null);
  return p == null ? null : Number(p);
}

// One read of everything the brain wants to know about a pool.
export async function poolStats(pool) {
  const pk = new PublicKey(pool);
  const v = await dbc().state.getPool(pk);
  if (!v) return null;
  const ps = v.poolState || v;
  const sqrt = BigInt(ps.sqrtPrice.toString());
  // sqrtPrice is Q64.64 of (quote lamports / base units); human price = raw * 10^(6-9)
  const price = Number((sqrt * sqrt) >> 64n) / 2 ** 64 * 1e-3;
  const p = await progress(pool);
  return { progress: p ?? 0, quoteReserveSol: Number(ps.quoteReserve.toString()) / LAMPORTS_PER_SOL, price, migrated: Number(ps.isMigrated || 0) > 0 };
}

export async function unclaimedCreatorSol(pool) {
  const b = await dbc().state.getPoolFeeBreakdown(new PublicKey(pool)).catch(() => null);
  return b ? Number(b.creator.unclaimedQuoteFee.toString()) / LAMPORTS_PER_SOL : 0;
}

export async function tokenBalance(mint, owner) {
  const { getAssociatedTokenAddressSync, getAccount } = await import('@solana/spl-token');
  const acct = await getAccount(connection(), getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner))).catch(() => null);
  return acct ? Number(acct.amount) : 0;
}

export async function balanceSol(addr) { return (await connection().getBalance(new PublicKey(addr))) / LAMPORTS_PER_SOL; }

export async function transferLamports(fromKeypair, to, lamports) {
  const { SystemProgram } = await import('@solana/web3.js');
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: fromKeypair.publicKey, toPubkey: new PublicKey(to), lamports }));
  return send(tx, [], fromKeypair);
}
export async function transferSol(fromKeypair, to, sol) {
  const { SystemProgram } = await import('@solana/web3.js');
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: fromKeypair.publicKey, toPubkey: new PublicKey(to), lamports: Math.floor(sol * LAMPORTS_PER_SOL) }));
  return send(tx, [], fromKeypair);
}
