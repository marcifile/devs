// End of a test run: close every empty token account on the dev wallets and the house (reclaims rent),
// then send ALL remaining SOL from every dev wallet and the house to `to`.
//   node scripts/drain.js <destination wallet>
// Needs HOUSE_WALLET_SECRET in .env and the devs' secrets in the local DB (DATA_DIR). Does not touch the live site.
import '../lib/env.js';
import bs58 from 'bs58';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { createCloseAccountInstruction } from '@solana/spl-token';
import { db } from '../lib/db.js';
import * as P from '../lib/meteora.js';

const to = process.argv[2];
if (!to || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to)) { console.error('usage: node scripts/drain.js <destination wallet>'); process.exit(1); }
const dest = new PublicKey(to);
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

const wallets = db.prepare('select handle, name, wallet, secret from devs').all().map(d => ({ label: `${d.handle} ${d.name}`, kp: Keypair.fromSecretKey(bs58.decode(d.secret)) }));
const house = P.keypairFromEnv('HOUSE_WALLET_SECRET');
if (house) wallets.push({ label: 'house', kp: house }); else console.log('no HOUSE_WALLET_SECRET in .env — skipping the house');

let total = 0;
for (const { label, kp } of wallets) {
  const owner = kp.publicKey;
  // 1. close empty token accounts → rent comes back to the wallet
  const accts = await P.connection().getParsedTokenAccountsByOwner(owner, { programId: TOKEN });
  const empty = accts.value.filter(a => a.account.data.parsed.info.tokenAmount.amount === '0');
  const held = accts.value.filter(a => a.account.data.parsed.info.tokenAmount.amount !== '0');
  for (const h of held) console.log(`${label}: still holds ${h.account.data.parsed.info.tokenAmount.uiAmountString} of ${h.account.data.parsed.info.mint} — sell it first (admin sweep), not closing`);
  if (empty.length) {
    const tx = new Transaction();
    for (const a of empty) tx.add(createCloseAccountInstruction(a.pubkey, owner, owner));
    const sig = await P.send(tx, [], kp);
    console.log(`${label}: closed ${empty.length} empty token account(s) · https://solscan.io/tx/${sig}`);
  }
  // 2. send everything but the tx fee
  const bal = await P.balanceSol(owner.toBase58());
  const amt = Math.floor((bal - 0.000005) * 1e9) / 1e9;
  if (amt <= 0.0001) { console.log(`${label}: ${bal.toFixed(6)} SOL, nothing worth sending`); continue; }
  const sig = await P.transferSol(kp, dest, amt);
  total += amt;
  console.log(`${label}: sent ${amt.toFixed(6)} SOL → ${to.slice(0, 4)}…${to.slice(-4)} · https://solscan.io/tx/${sig}`);
}
db.close();
console.log(`done. ${total.toFixed(6)} SOL sent to ${to}.`);
