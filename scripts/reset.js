// Sweep every dev wallet back to the house, then wipe the database. Stop the server first.
//   node scripts/reset.js
import '../lib/env.js';
import fs from 'node:fs';
import path from 'node:path';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { db } from '../lib/db.js';
import * as P from '../lib/meteora.js';
const house = process.env.HOUSE_WALLET; if (!house) throw new Error('HOUSE_WALLET missing');
const devs = db.prepare('select handle, name, wallet, secret from devs').all();
let swept = 0;
for (const d of devs) {
  const bal = await P.balanceSol(d.wallet);
  const amt = bal - 0.000905; // leave rent-exempt minimum + fee
  if (amt <= 0.001) { console.log(`${d.handle} ${d.name}: ${bal.toFixed(4)} SOL, nothing to sweep`); continue; }
  const kp = Keypair.fromSecretKey(bs58.decode(d.secret));
  const sig = await P.transferSol(kp, house, amt);
  swept += amt; console.log(`${d.handle} ${d.name}: swept ${amt.toFixed(4)} SOL · https://solscan.io/tx/${sig}`);
}
db.close();
const dir = process.env.DATA_DIR || path.resolve('data');
fs.rmSync(dir, { recursive: true, force: true });
console.log(`done. ${swept.toFixed(4)} SOL back in the house. database wiped. start the server again.`);
