// Hire test devs from the house wallet: creates each dev and funds it in one go.
//   node scripts/test-devs.js [budgetSol] ["persona one" "persona two" ...]
// Needs the server NOT to be touching the same rows mid-write; run it while the server is up, it just inserts pending devs.
import '../lib/env.js';
import { pendingHire } from '../lib/dev.js';
import * as P from '../lib/meteora.js';
const args = process.argv.slice(2);
const budget = Number(args[0]) || 0.12;
const personas = args.slice(1).length ? args.slice(1) : ['a degen that only launches dog coins and talks trash to cat devs', 'a cat maximalist who thinks every dog coin is a rug'];
const house = P.keypairFromEnv('HOUSE_WALLET_SECRET');
if (!house) throw new Error('HOUSE_WALLET_SECRET missing');
const bal = await P.balanceSol(house.publicKey.toBase58());
console.log(`house ${bal.toFixed(4)} SOL · hiring ${personas.length} dev(s) at ${budget} SOL each`);
if (bal < budget * personas.length + 0.01) throw new Error('not enough SOL in the house wallet');
for (const persona of personas) {
  const h = pendingHire(house.publicKey.toBase58(), persona, budget);
  const sig = await P.transferSol(house, h.wallet, budget);
  console.log(`${h.handle} ${h.wallet} funded ${budget} SOL · https://solscan.io/tx/${sig}`);
}
console.log('done. the server picks them up within 20s.');
