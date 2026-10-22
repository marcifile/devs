// SQLite, one file. Same approach as memento.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(dir, { recursive: true });
export const db = new Database(path.join(dir, 'devs.db'));
db.pragma('journal_mode = WAL');

db.exec(`
create table if not exists devs (
  id integer primary key autoincrement,
  handle text unique not null,          -- dev_0001
  name text not null,                   -- what the dev calls itself
  persona text not null,                -- the boss's one line
  boss text not null,                   -- boss wallet (receives 70%)
  wallet text unique not null,          -- the dev's own wallet
  secret text not null,                 -- its keypair (bs58). never leaves the server.
  x_handle text,                        -- its X account, if any
  status text not null default 'shipping', -- shipping | quit
  bank_sol real not null default 0,     -- what it has to work with (tracked; chain is truth)
  spent_sol real not null default 0,    -- compute + network fees it has paid
  earned_sol real not null default 0,   -- fees it has earned, all time
  paid_boss_sol real not null default 0,
  launches integer not null default 0,
  last_thought text,
  next_action_at integer,               -- unix ms
  created_at integer not null
);
create table if not exists coins (
  mint text primary key,
  dev_id integer not null references devs(id),
  ticker text not null,
  name text not null,
  description text,
  image text,
  metadata_uri text,
  launch_sig text,
  split_sig text,
  pool text,                            -- meteora dbc pool address
  progress real,                        -- 0..1 along the curve
  complete integer not null default 0,
  fees_sol real not null default 0,     -- distributed so far
  raised_sol real not null default 0,
  price_sol real,
  created_at integer not null
);
create table if not exists events (
  id integer primary key autoincrement,
  dev_id integer references devs(id),
  mint text,
  kind text not null,                   -- hired | thought | launched | bought | sold | payday | paid_boss | posted | quit | error
  text text not null,
  sol real,
  sig text,
  at integer not null
);
create table if not exists payouts (
  id integer primary key autoincrement,
  dev_id integer not null references devs(id),
  mint text,
  to_wallet text not null,
  role text not null,                   -- boss | dev | house
  sol real not null,
  sig text,
  at integer not null
);
create table if not exists holdings (
  dev_id integer not null references devs(id),
  mint text not null,
  amount real not null default 0,          -- tokens (human units)
  at integer not null,
  primary key (dev_id, mint)
);
create table if not exists notices (
  id integer primary key autoincrement,
  text text not null,
  until integer not null
);
create table if not exists nudges (
  id integer primary key autoincrement,
  dev_id integer not null references devs(id),
  text text not null,
  at integer not null,
  used integer not null default 0
);
create index if not exists ev_at on events(at desc);
create index if not exists ev_dev on events(dev_id, at desc);
`);

// additive columns (safe to re-run)
for (const [t, col] of [
  ['devs', 'hire_sol real'], ['devs', 'devs_tokens real not null default 0'], ['devs', 'devs_sol real not null default 0'],
  ['coins', 'entry_price real'], ['coins', 'quote_reserve real'], ['coins', 'last_trade_at integer'], ['coins', 'holding_pct real'], ['coins', 'hist text'],
]) { try { db.exec(`alter table ${t} add column ${col}`); } catch {} }

export const now = () => Date.now();
export function log(dev_id, kind, text, { mint = null, sol = null, sig = null } = {}) {
  db.prepare('insert into events (dev_id, mint, kind, text, sol, sig, at) values (?,?,?,?,?,?,?)').run(dev_id, mint, kind, text, sol, sig, now());
}
