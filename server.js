import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, log } from './lib/db.js';
import * as D from './lib/dev.js';
import * as P from './lib/pump.js';
import { xReady } from './lib/x.js';
import { avatarSvg } from './lib/avatar.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

const pub = d => d && ({ id: d.id, handle: d.handle, name: d.name, persona: d.persona, boss: d.boss, wallet: d.wallet, x_handle: d.x_handle, status: d.status, bank_sol: d.bank_sol, spent_sol: d.spent_sol, earned_sol: d.earned_sol, paid_boss_sol: d.paid_boss_sol, launches: d.launches, last_thought: d.last_thought, next_action_at: d.next_action_at, created_at: d.created_at });

// ---- read ----
app.get('/api/state', (req, res) => {
  const devs = db.prepare("select * from devs where status<>'pending' order by earned_sol desc, created_at asc").all().map(pub);
  const coins = db.prepare('select c.*, d.name dev_name, d.handle dev_handle from coins c join devs d on d.id=c.dev_id order by c.created_at desc limit 200').all();
  const events = db.prepare('select e.*, d.name dev_name, d.handle dev_handle from events e left join devs d on d.id=e.dev_id order by e.at desc limit 60').all();
  const payouts = db.prepare('select p.*, d.name dev_name, c.ticker from payouts p join devs d on d.id=p.dev_id left join coins c on c.mint=p.mint order by p.at desc limit 60').all();
  const t = db.prepare(`select
      (select count(*) from devs where status<>'pending') devs,
      (select count(*) from devs where status='shipping') shipping,
      (select count(*) from coins) coins,
      (select count(*) from coins where complete=1) graduated,
      (select coalesce(sum(sol),0) from payouts where role='boss') to_bosses,
      (select coalesce(sum(sol),0) from payouts where role='house') to_house,
      (select coalesce(sum(fees_sol),0) from coins) fees`).get();
  res.json({ devs, coins, events, payouts, totals: t, pending: db.prepare("select count(*) c from devs where status='pending'").get().c, split: { boss: D.BOSS_BPS / 100, dev: D.DEV_BPS / 100, house: D.HOUSE_BPS / 100 }, hire_sol: D.HIRE_SOL, x: xReady(), site: process.env.SITE_URL, project_x: process.env.X_PROJECT_URL || null, ca: process.env.PLATFORM_MINT || null });
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
  const events = db.prepare('select e.*, d.name dev_name from events e left join devs d on d.id=e.dev_id where e.mint=? order by at desc limit 100').all(req.params.mint);
  res.json({ coin: c, events });
});

app.get('/api/avatar/:h.svg', (req, res) => { res.type('image/svg+xml').set('cache-control', 'public, max-age=86400').send(avatarSvg(req.params.h)); });

// ---- hire ----
// 1. POST {persona, boss} -> a fresh dev wallet to fund. 2. boss sends HIRE_SOL. 3. we see it and the dev wakes up.
app.post('/api/hire', (req, res) => {
  const persona = String(req.body.persona || '').trim();
  const boss = String(req.body.boss || '').trim();
  if (persona.length < 8) return res.status(400).json({ error: 'give your dev a personality (at least a few words)' });
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(boss)) return res.status(400).json({ error: 'paste a valid Solana wallet. that is where your cut goes.' });
  const h = D.pendingHire(boss, persona);
  res.json({ ...h, note: `send exactly ${h.amount} SOL to ${h.wallet}. the dev wakes up when it lands.` });
});
app.get('/api/hire/:handle', async (req, res) => {
  try { const d = await D.confirmHire(req.params.handle); if (!d) return res.status(404).json({ error: 'no such dev' }); res.json({ dev: pub(d), funded: d.status !== 'pending', balance: d.balance ?? null }); }
  catch (e) { res.status(500).json({ error: e.message }); }
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

// pages
for (const p of ['/dev/:h', '/c/:m', '/hire', '/how']) app.get(p, (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

const port = Number(process.env.PORT || 8791);
app.listen(port, () => {
  console.log(`devs on http://localhost:${port} · split boss ${D.BOSS_BPS / 100}% dev ${D.DEV_BPS / 100}% house ${D.HOUSE_BPS / 100}% · x ${xReady() ? 'on' : 'off'} · rpc ${P.rpcState().using}`);
  D.startLoop();
});
