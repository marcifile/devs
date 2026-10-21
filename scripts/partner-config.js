// One-time: create the devs partner config on Meteora DBC from the house wallet.
// Prints DBC_CONFIG to put in .env. Costs a little SOL in rent.
import '../lib/env.js';
import { createPartnerConfig } from '../lib/meteora.js';
const houseBps = Number(process.env.FEE_HOUSE_BPS || 1000);
const r = await createPartnerConfig({ houseBps });
console.log(`DBC_CONFIG=${r.config}`);
console.log(`tx: https://solscan.io/tx/${r.sig}`);
