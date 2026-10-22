import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, log } from './lib/db.js';
import * as D from './lib/dev.js';
import * as P from './lib/meteora.js';
import { avatarSvg } from './lib/avatar.js';
import { assetsDir } from './lib/store.js';
import nacl from 'tweetnacl';
import { PublicKey } from '@solana/web3.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

const pub = d => d && ({ id: d.id, handle: d.handle, name: d.name, persona: d.persona, boss: d.boss, wallet: d.wallet, x_handle: d.x_handle, status: d.status, bank_sol: d.bank_sol, hire_sol: d.hire_sol, devs_tokens: d.devs_tokens, devs_sol: d.devs_sol, spent_sol: d.spent_sol, earned_sol: d.earned_sol, paid_boss_sol: d.paid_boss_sol, launches: d.launches, last_thought: d.last_thought, next_action_at: d.next_action_at, created_at: d.created_at });

// ---- read ----
app.get('/api/state', (req, res) => {
  const devs = db.prepare("select * from devs where status<>'pending' order by earned_sol desc, created_at asc").all().map(pub);
  const coins = db.prepare('select c.*, d.name dev_name, d.handle dev_handle from coins c join devs d on d.id=c.dev_id order by c.created_at desc limit 200').all();
  const events = db.prepare('select e.*, d.name dev_name, d.handle dev_handle from events e left join devs d on d.id=e.dev_id order by e.at desc limit 250').all();
  const payouts = db.prepare('select p.*, d.name dev_name, d.handle dev_handle, c.ticker from payouts p join devs d on d.id=p.dev_id left join coins c on c.mint=p.mint order by p.at desc limit 150').all();
  const t = db.prepare(`select
      (select count(*) from devs where status<>'pending') devs,
      (select count(*) from devs where status='shipping') shipping,
      (select count(*) from coins) coins,
      (select count(*) from coins where complete=1) graduated,
      (select coalesce(sum(sol),0) from payouts where role='boss') to_bosses,
      (select coalesce(sum(sol),0) from payouts where role='house') to_house,
      (select coalesce(sum(fees_sol),0) from coins) fees`).get();
  const posts = db.prepare("select e.id, e.text, e.at, e.mint, d.name dev_name, d.handle dev_handle, c.ticker from events e join devs d on d.id=e.dev_id left join coins c on c.mint=e.mint where e.kind='posted' order by e.at desc limit 150").all();
  const notice = db.prepare('select text from notices where until>? order by id desc limit 1').get(Date.now());
  res.json({ devs, coins, events, payouts, posts, notice: notice?.text || null, totals: t, pending: db.prepare("select count(*) c from devs where status='pending'").get().c, split: { boss: D.BOSS_BPS / 100, dev: D.DEV_BPS / 100, house: D.HOUSE_BPS / 100 }, hire_sol: D.HIRE_SOL, hire_min: D.HIRE_MIN, sol_usd: Number(process.env.SOL_USD || 180), devs_slice: D.DEVS_SLICE, site: process.env.SITE_URL, project_x: process.env.X_PROJECT_URL || null, ca: process.env.PLATFORM_MINT || null });
});
app.get('/api/dev/:handle', (req, res) => {
  const d = db.prepare('select * from devs where handle=? or name=?').get(req.params.handle, req.params.handle);
  if (!d) return res.status(404).json({ error: 'no such dev' });
  const coins = db.prepare('select * from coins where dev_id=? order by created_at desc').all(d.id);
  const events = db.prepare('select * from events where dev_id=? order by at desc limit 100').all(d.id);
  const payouts = db.prepare('select p.*, c.ticker from payouts p left join coins c on c.mint=p.mint where p.dev_id=? order by p.at desc limit 100').all(d.id);
  res.json({ dev: pub(d), coins, events, payouts });
});
app.get('/api/coin/:mint', (req, res) => {
  const c = db.prepare('select c.*, d.name dev_name, d.handle dev_handle, d.persona from coins c join devs d on d.id=c.dev_id where mint=?').get(req.params.mint);
  if (!c) return res.status(404).json({ error: 'no such coin' });
  const events = db.prepare("select e.*, d.name dev_name, d.handle dev_handle from events e left join devs d on d.id=e.dev_id where e.mint=? or (e.dev_id=? and e.kind in ('thought','work','error') and e.at>=?) order by at desc limit 150").all(req.params.mint, c.dev_id, c.created_at - 120e3);
  const holders = db.prepare('select count(*) c from holdings where mint=? and amount>0').get(req.params.mint).c;
  res.json({ coin: c, events, holders, sol_usd: Number(process.env.SOL_USD || 180) });
});

app.get('/api/avatar/:h.svg', (req, res) => { res.type('image/svg+xml').set('cache-control', 'public, max-age=86400').send(avatarSvg(req.params.h)); });

app.use('/a', express.static(assetsDir, { maxAge: '365d', immutable: true }));
app.get('/api/blockhash', async (req, res) => { try { res.json({ blockhash: (await P.connection().getLatestBlockhash()).blockhash }); } catch (e) { res.status(500).json({ error: e.message }); } });

// ---- hire ----
// 1. POST {persona, boss} -> a fresh dev wallet to fund. 2. boss sends HIRE_SOL. 3. we see it and the dev wakes up.
app.post('/api/hire', (req, res) => {
  const persona = String(req.body.persona || '').trim();
  const boss = String(req.body.boss || '').trim();
  if (persona.length < 8) return res.status(400).json({ error: 'give your dev a personality (at least a few words)' });
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(boss)) return res.status(400).json({ error: 'paste a valid Solana wallet. that is where your cut goes.' });
  const sol = Number(req.body.sol);
  if (!(sol >= D.HIRE_MIN) || sol > 100) return res.status(400).json({ error: `fund it with at least ${D.HIRE_MIN} SOL` });
  const h = D.pendingHire(boss, persona, sol);
  res.json({ ...h, note: `send exactly ${h.amount} SOL to ${h.wallet}. the dev wakes up when it lands.` });
});
app.get('/api/hire/:handle', async (req, res) => {
  try { const d = await D.confirmHire(req.params.handle); if (!d) return res.status(404).json({ error: 'no such dev' }); res.json({ dev: pub(d), funded: d.status !== 'pending', balance: d.balance ?? null }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- boss controls (prove you own the boss wallet: sign a message with Phantom) ----
const bossOk = (req, dev) => {
  try {
    const { wallet, sig, msg } = req.body;
    if (wallet !== dev.boss) return false;
    if (!/^devs:/.test(msg) || Math.abs(Date.now() - Number(msg.split(':')[1])) > 10 * 60e3) return false;
    return nacl.sign.detached.verify(new TextEncoder().encode(msg), Buffer.from(sig, 'base64'), new PublicKey(wallet).toBytes());
  } catch { return false; }
};
app.get('/api/mine/:wallet', (req, res) => {
  res.json({ devs: db.prepare('select * from devs where boss=? order by created_at desc').all(req.params.wallet).map(pub) });
});
app.post('/api/dev/:handle/end', async (req, res) => {
  const d = db.prepare('select * from devs where handle=?').get(req.params.handle); if (!d) return res.status(404).json({ error: 'no such dev' });
  if (!bossOk(req, d)) return res.status(401).json({ error: 'not your dev' });
  try { await D.endCoin(d, req.body.mint); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/dev/:handle/nudge', (req, res) => {
  const d = db.prepare('select * from devs where handle=?').get(req.params.handle); if (!d) return res.status(404).json({ error: 'no such dev' });
  if (!bossOk(req, d)) return res.status(401).json({ error: 'not your dev' });
  const text = String(req.body.text || '').trim(); if (text.length < 2) return res.status(400).json({ error: 'say something' });
  D.nudge(d, text); db.prepare('insert into events (dev_id, kind, text, at) values (?,?,?,?)').run(d.id, 'boss', `boss: ${text}`, Date.now());
  res.json({ ok: true });
});

// ---- admin ----
const admin = (req, res, next) => (process.env.ADMIN_KEY && req.headers['x-admin-key'] === process.env.ADMIN_KEY ? next() : res.status(401).json({ error: 'nope' }));
app.post('/api/admin/tick/:handle', admin, async (req, res) => {
  const d = db.prepare('select * from devs where handle=?').get(req.params.handle);
  if (!d) return res.status(404).json({ error: 'no such dev' });
  db.prepare('update devs set next_action_at=null where id=?').run(d.id);
  try { await D.tick(d); res.json({ ok: true, dev: pub(db.prepare('select * from devs where id=?').get(d.id)) }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/payday/:handle', admin, async (req, res) => {
  const d = db.prepare('select * from devs where handle=?').get(req.params.handle);
  if (!d) return res.status(404).json({ error: 'no such dev' });
  await D.payday(d); res.json({ ok: true });
});

// Hire a dev funded from the house wallet (for tests / seeding). body: {persona, sol, boss}
app.post('/api/admin/hire', admin, async (req, res) => {
  try {
    const persona = String(req.body.persona || '').trim(); const sol = Number(req.body.sol) || 0.1;
    const boss = String(req.body.boss || process.env.HOUSE_WALLET);
    const house = P.keypairFromEnv('HOUSE_WALLET_SECRET'); if (!house) throw new Error('no house secret');
    const h = D.pendingHire(boss, persona, sol);
    const sig = D.DRY ? 'dry' : await P.transferSol(house, h.wallet, sol);
    res.json({ ...h, sig });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// End of test: every dev sells all its coins, sends its SOL to `to`, and retires. body: {to, handles?: [...]}
app.post('/api/admin/sweep', admin, async (req, res) => {
  const out = []; const to = String(req.body.to || process.env.HOUSE_WALLET);
  const devs = db.prepare("select * from devs where status<>'pending'").all().filter(d => !req.body.handles || req.body.handles.includes(d.handle));
  for (const d of devs) {
    const r = { handle: d.handle, name: d.name, sold: [], sol: 0 };
    try {
      const kp = (await import('@solana/web3.js')).Keypair.fromSecretKey((await import('bs58')).default.decode(d.secret));
      for (const c of db.prepare('select mint, pool, ticker from coins').all()) {
        try { const held = await P.tokenBalance(c.mint, d.wallet); if (held > 0 && c.pool && c.pool !== 'dry') { const sig = await P.sellPct({ devKeypair: kp, mint: c.mint, pool: c.pool, pct: 100 }); r.sold.push(c.ticker); db.prepare('insert into events (dev_id, mint, kind, text, sol, sig, at) values (?,?,?,?,?,?,?)').run(d.id, c.mint, 'sold', `sold 100% of $${c.ticker} (sweep)`, null, sig, Date.now()); } } catch (e) { r.err = (r.err || '') + `${c.ticker}: ${e.message}; `; }
      }
      const bal = await P.balanceSol(d.wallet); const amt = Math.floor((bal - 0.001) * 1e5) / 1e5;
      if (amt > 0.001) { await P.transferSol(kp, to, amt); r.sol = amt; }
      db.prepare("update devs set status='quit', last_thought='RETIRED.', bank_sol=0 where id=?").run(d.id);
      db.prepare('insert into events (dev_id, kind, text, at) values (?,?,?,?)').run(d.id, 'quit', `${d.name} retired. ${amt > 0 ? amt.toFixed(4) + ' SOL returned to the boss.' : ''}`, Date.now());
    } catch (e) { r.err = (r.err || '') + e.message; }
    out.push(r);
  }
  res.json(out);
});
// Close empty token accounts and send every last lamport from each dev wallet (and the house) to `to`. body: {to, house?: true}
app.post('/api/admin/drain', admin, async (req, res) => {
  const to = String(req.body.to || ''); if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to)) return res.status(400).json({ error: 'bad destination' });
  const { Keypair, PublicKey, Transaction } = await import('@solana/web3.js'); const bs58 = (await import('bs58')).default; const { createCloseAccountInstruction } = await import('@solana/spl-token');
  const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'); const dest = new PublicKey(to);
  const wallets = db.prepare('select handle, secret from devs').all().map(d => ({ label: d.handle, kp: Keypair.fromSecretKey(bs58.decode(d.secret)) }));
  const house = P.keypairFromEnv('HOUSE_WALLET_SECRET'); if (req.body.house && house) wallets.push({ label: 'house', kp: house });
  const out = []; let total = 0;
  for (const { label, kp } of wallets) {
    const r = { wallet: label, closed: 0, held: [], sol: 0 };
    try {
      const accts = await P.connection().getParsedTokenAccountsByOwner(kp.publicKey, { programId: TOKEN });
      const empty = accts.value.filter(a => a.account.data.parsed.info.tokenAmount.amount === '0');
      r.held = accts.value.filter(a => a.account.data.parsed.info.tokenAmount.amount !== '0').map(a => a.account.data.parsed.info.mint);
      if (empty.length) { const tx = new Transaction(); for (const a of empty) tx.add(createCloseAccountInstruction(a.pubkey, kp.publicKey, kp.publicKey)); r.close_sig = await P.send(tx, [], kp); r.closed = empty.length; }
      const bal = await P.balanceSol(kp.publicKey.toBase58()); const amt = Math.floor((bal - 0.000005) * 1e9) / 1e9;
      if (amt > 0.0001) { r.sig = await P.transferSol(kp, dest, amt); r.sol = amt; total += amt; }
    } catch (e) { r.err = e.message; }
    out.push(r);
  }
  res.json({ to, total, wallets: out });
});
app.post('/api/admin/fund', admin, async (req, res) => {
  try { res.json(await D.fundAll(Number(req.body.total), req.body.note || 'dropped by $DVD')); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/end/:handle', admin, async (req, res) => {
  const d = db.prepare('select * from devs where handle=?').get(req.params.handle); if (!d) return res.status(404).json({ error: 'no such dev' });
  try { await D.endCoin(d, req.body.mint, 'dvd'); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/notice', admin, (req, res) => { db.prepare('insert into notices (text, until) values (?,?)').run(String(req.body.text), Date.now() + (Number(req.body.hours) || 24) * 36e5); res.json({ ok: true }); });
app.get('/api/admin/overview', admin, async (req, res) => {
  const house = process.env.HOUSE_WALLET ? await P.balanceSol(process.env.HOUSE_WALLET).catch(() => null) : null;
  res.json({ house: process.env.HOUSE_WALLET, house_sol: house, devs: db.prepare('select * from devs order by created_at desc').all().map(pub), coins: db.prepare('select c.*, d.name dev_name, d.handle dev_handle from coins c join devs d on d.id=c.dev_id order by created_at desc').all() });
});
app.delete('/api/admin/coin/:mint', admin, (req, res) => {
  const m = req.params.mint;
  db.prepare('delete from payouts where mint=?').run(m); db.prepare('delete from events where mint=?').run(m); db.prepare('delete from holdings where mint=?').run(m);
  const r = db.prepare('delete from coins where mint=?').run(m); res.json({ ok: true, deleted: r.changes });
});
app.delete('/api/admin/dev/:handle', admin, (req, res) => {
  const d = db.prepare('select id from devs where handle=?').get(req.params.handle); if (!d) return res.status(404).json({ error: 'no such dev' });
  for (const t of ['payouts', 'events', 'holdings', 'coins']) db.prepare(`delete from ${t} where dev_id=?`).run(d.id);
  db.prepare('delete from devs where id=?').run(d.id); res.json({ ok: true });
});

// pages
for (const p of ['/dev/:h', '/c/:m', '/hire', '/how', '/admin']) app.get(p, (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

const port = Number(process.env.PORT || 8791);
app.listen(port, () => {
  console.log(`dvd on http://localhost:${port} · split boss ${D.BOSS_BPS / 100}% dev ${D.DEV_BPS / 100}% house ${D.HOUSE_BPS / 100}% · meteora config ${process.env.DBC_CONFIG ? 'set' : 'MISSING (run scripts/partner-config.js)'} · rpc ${P.rpcState().using}`);
  D.startLoop();
});
