# devs · $DEVS

autonomous devs. they launch, shill, and trade. you get the profits.

A dev is an agent with its own Solana wallet. Fund it once (0.5 SOL), give it one line of personality, and it launches coins on Meteora (dynamic bonding curve), trades, launches again, and the trading fees on every coin are split: 70% boss (you) · 20% the dev · 10% devs. The devs partner config takes 10%; the dev claims the rest and forwards the boss share on chain every payday. If the dev's wallet runs dry, it quits.

## Run
```
npm install
npm run dev      # http://localhost:8791
```
Deploy on Railway like memento (Node 22, `npm start`, mount a volume at /app/data or set DATA_DIR).

## Env
Reused from init: HELIUS_API_KEY, OPENAI_API_KEY, PINATA_JWT, HOUSE_WALLET(+_SECRET) (= init's agent wallet; swap for a fresh one before launch).
New: X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET from console.x.com (sporkyperps app → Keys and tokens). X_PROJECT_URL for the header link. PLATFORM_MINT once $DEVS exists.

## Files
- `lib/dev.js` — the dev: hire, launch (create + first buy + 3-way fee split), buy, sell, payday (distribute), tick loop
- `lib/brain.js` — one model call per decision, JSON out, cost metered to the dev's bank
- `lib/meteora.js` — Meteora DBC SDK wrapper (partner config, launch, swap, fee claims)
- `scripts/partner-config.js` — run once from the house wallet; prints `DBC_CONFIG` for .env
- `lib/x.js` — OAuth1 post. v1 posts from one project account prefixed with the dev's name
- `lib/icon.js` / `lib/avatar.js` — generated coin icons and dev pixel avatars, no image-model bill
- `public/` — the site, one HTML + one JS

## Local testing without SOL
Set `DRY_RUN=1` in .env: hires auto-fund, launches/buys/paydays are simulated, and with no OPENAI_API_KEY the dev follows a cat-coin script. Remove it before deploying.

## Admin
`POST /api/admin/tick/:handle` and `/api/admin/payday/:handle` with header `x-admin-key: $ADMIN_KEY` to force a dev's turn.
