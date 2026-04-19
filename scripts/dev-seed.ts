#!/usr/bin/env bun
// Seed ~/.ferret/ferret.db with deterministic fake data: 1 connection,
// 2 accounts, ~50 transactions, default categories. Safe to re-run; uses
// stable ids so duplicates are skipped via primary-key conflict.

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { FERRET_HOME, getDb } from '../src/db/client';

const SEED = 1337;
function rand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}
const rng = rand(SEED);
const pick = <T>(arr: readonly T[]): T => {
  const v = arr[Math.floor(rng() * arr.length)];
  if (v === undefined) throw new Error('pick called on empty array');
  return v;
};

const MERCHANTS = [
  ['Tesco', 'Groceries'],
  ['Sainsburys', 'Groceries'],
  ['TfL', 'Public Transport'],
  ['Uber', 'Ride Share'],
  ['Pret a Manger', 'Eating Out'],
  ['Dishoom', 'Eating Out'],
  ['Deliveroo', 'Takeaway'],
  ['Netflix', 'Subscriptions'],
  ['Spotify', 'Subscriptions'],
  ['Boots', 'Pharmacy'],
  ['Amazon', 'General'],
  ['Shell', 'Fuel'],
] as const;

function migrationsDir(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  return join(here, '..', 'src', 'db', 'migrations');
}

function main(): void {
  if (!existsSync(FERRET_HOME)) mkdirSync(FERRET_HOME, { recursive: true, mode: 0o700 });
  const { db, raw } = getDb();
  const dir = migrationsDir();
  if (existsSync(dir)) migrate(db, { migrationsFolder: dir });

  const now = Date.now();
  const connectionId = 'seed-conn-001';
  const accountIds: [string, string] = ['seed-acct-current', 'seed-acct-savings'];

  raw
    .prepare(
      `INSERT OR IGNORE INTO connections
       (id, provider_id, provider_name, created_at, expires_at, status, last_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      connectionId,
      'manual',
      'Seed Bank',
      Math.floor(now / 1000),
      Math.floor((now + 90 * 86_400_000) / 1000),
      'active',
      Math.floor(now / 1000),
    );

  const insertAcct = raw.prepare(
    `INSERT OR IGNORE INTO accounts
     (id, connection_id, account_type, display_name, currency, balance_available,
      balance_current, balance_updated_at, is_manual)
     VALUES (?, ?, ?, ?, 'GBP', ?, ?, ?, 1)`,
  );
  insertAcct.run(
    accountIds[0],
    connectionId,
    'TRANSACTION',
    'Seed Current',
    1234.56,
    1234.56,
    Math.floor(now / 1000),
  );
  insertAcct.run(
    accountIds[1],
    connectionId,
    'SAVINGS',
    'Seed Savings',
    10_000,
    10_000,
    Math.floor(now / 1000),
  );

  const insertTxn = raw.prepare(
    `INSERT OR IGNORE INTO transactions
     (id, account_id, timestamp, amount, currency, description, merchant_name,
      transaction_type, category, category_source, provider_category, running_balance,
      is_pending, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'GBP', ?, ?, ?, ?, 'cache', NULL, NULL, 0, NULL, ?, ?)`,
  );

  const tx = raw.transaction(() => {
    for (let i = 0; i < 50; i++) {
      const [merchant, category] = pick(MERCHANTS);
      const amount = -Math.round(rng() * 10000) / 100;
      const accountId = accountIds[i % accountIds.length];
      if (accountId === undefined) throw new Error('no accounts to seed against');
      const ts = Math.floor((now - i * 86_400_000) / 1000);
      insertTxn.run(
        `seed-txn-${i.toString().padStart(4, '0')}`,
        accountId,
        ts,
        amount,
        merchant,
        merchant,
        amount < 0 ? 'DEBIT' : 'CREDIT',
        category,
        ts,
        ts,
      );
    }
  });
  tx();

  process.stdout.write('seeded dev data: 1 connection, 2 accounts, 50 transactions\n');
}

main();
