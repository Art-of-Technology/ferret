#!/usr/bin/env bun
// Performance benchmark for Ferret's hot SQLite paths (PRD §11.1).
//
// Targets (per PRD §11.1 and PRD §13):
//   - `ls --limit 50` over 100k transactions             < 200 ms
//   - getCategorySummary (per-category totals, 30d slice) < 200 ms
//   - dedupe lookup by provider id (single-row PK fetch)  <  10 ms
//
// The bench seeds 100,000 deterministic fake rows into a temp SQLite DB
// (WAL mode, mirroring runtime) then times each query path. Exit code is
// non-zero if any target is missed so CI can gate on regressions.
//
// Notes:
//   - We use bun:sqlite + raw SQL rather than drizzle so the bench measures
//     the storage layer, not the ORM layer (drizzle is on the same hot path
//     in production but adding it here would make the seed step the bottleneck
//     and obscure real query cost).
//   - Schema is replicated inline from src/db/schema.ts and migration 0000.
//     If the migration changes you MUST update this file too — the bench is
//     intentionally self-contained so it can run without `ferret init`.
//   - Seeding is done in one transaction with prepared statements; on a
//     reasonable laptop this is ~1.5s. If you see seed > 5s, the env is the
//     bottleneck (slow disk, encrypted FS, etc), not the query targets.

import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface BenchTarget {
  name: string;
  budgetMs: number;
}

interface BenchResult extends BenchTarget {
  observedMs: number;
  passed: boolean;
}

const TARGETS = {
  ls50: { name: 'ls --limit 50 (100k rows)', budgetMs: 200 },
  categorySummary: { name: 'getCategorySummary (30d window)', budgetMs: 200 },
  dedupeLookup: { name: 'dedupe lookup by provider id', budgetMs: 10 },
} satisfies Record<string, BenchTarget>;

const ROW_COUNT = 100_000;
const ACCOUNT_COUNT = 4;
const CATEGORIES = [
  'Groceries',
  'Eating Out',
  'Subscriptions',
  'Transport',
  'Fuel',
  'Pharmacy',
  'General',
  'Salary',
  'Uncategorized',
];
const MERCHANTS = [
  'Tesco',
  'Sainsburys',
  'Pret',
  'Dishoom',
  'Netflix',
  'Spotify',
  'TfL',
  'Uber',
  'Boots',
  'Amazon',
  'Shell',
  'Deliveroo',
];

function setupSchema(db: Database): void {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');

  db.exec(`
    CREATE TABLE connections (
      id TEXT PRIMARY KEY NOT NULL,
      provider_id TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      last_synced_at INTEGER
    );
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY NOT NULL,
      connection_id TEXT NOT NULL,
      account_type TEXT NOT NULL,
      display_name TEXT NOT NULL,
      iban TEXT,
      sort_code TEXT,
      account_number TEXT,
      currency TEXT NOT NULL,
      balance_available REAL,
      balance_current REAL,
      balance_updated_at INTEGER,
      is_manual INTEGER DEFAULT 0,
      FOREIGN KEY (connection_id) REFERENCES connections(id)
    );
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY NOT NULL,
      account_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      description TEXT NOT NULL,
      merchant_name TEXT,
      transaction_type TEXT,
      category TEXT,
      category_source TEXT,
      provider_category TEXT,
      running_balance REAL,
      is_pending INTEGER DEFAULT 0,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );
    CREATE INDEX txn_account_timestamp_idx ON transactions (account_id, timestamp);
    CREATE INDEX txn_category_idx ON transactions (category, timestamp);
    CREATE INDEX txn_merchant_idx ON transactions (merchant_name);
  `);
}

// Deterministic LCG so the bench is repeatable across runs without pulling
// in a seeded-rng dependency. Same constants as scripts/dev-seed.ts.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function seed(db: Database): void {
  const now = Math.floor(Date.now() / 1000);
  const connId = 'bench-conn';

  db.prepare(
    `INSERT INTO connections (id, provider_id, provider_name, created_at, expires_at, status)
     VALUES (?, 'bench', 'BenchBank', ?, ?, 'active')`,
  ).run(connId, now, now + 90 * 86_400);

  const insertAcct = db.prepare(
    `INSERT INTO accounts (id, connection_id, account_type, display_name, currency)
     VALUES (?, ?, 'TRANSACTION', ?, 'GBP')`,
  );
  const accountIds: string[] = [];
  for (let i = 0; i < ACCOUNT_COUNT; i++) {
    const id = `bench-acct-${i}`;
    accountIds.push(id);
    insertAcct.run(id, connId, `Bench Account ${i}`);
  }

  const insertTxn = db.prepare(
    `INSERT INTO transactions
     (id, account_id, timestamp, amount, currency, description, merchant_name,
      transaction_type, category, category_source, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'GBP', ?, ?, ?, ?, 'cache', ?, ?)`,
  );

  const rng = makeRng(0xdeadbeef);
  // Spread rows over ~24 months so date-range queries hit a realistic slice.
  const spanSeconds = 730 * 86_400;
  const insertMany = db.transaction((count: number) => {
    for (let i = 0; i < count; i++) {
      const merchantIdx = Math.floor(rng() * MERCHANTS.length);
      const categoryIdx = Math.floor(rng() * CATEGORIES.length);
      const accountIdx = Math.floor(rng() * accountIds.length);
      const merchant = MERCHANTS[merchantIdx] ?? 'Unknown';
      const category = CATEGORIES[categoryIdx] ?? 'Uncategorized';
      const accountId = accountIds[accountIdx] ?? accountIds[0] ?? 'bench-acct-0';
      const ts = now - Math.floor(rng() * spanSeconds);
      const amount = -Math.round(rng() * 10000) / 100;
      const description = `${merchant} txn ${i}`;
      const txnType = amount < 0 ? 'DEBIT' : 'CREDIT';
      insertTxn.run(
        `bench-txn-${i.toString().padStart(7, '0')}`,
        accountId,
        ts,
        amount,
        description,
        merchant,
        txnType,
        category,
        ts,
        ts,
      );
    }
  });
  insertMany(ROW_COUNT);
}

function timeMs(fn: () => void, iterations = 5): number {
  // Warm-up: SQLite caches query plans + page cache. We want steady-state
  // numbers, not first-run cold-cache pessimism.
  fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  // Median is more stable than mean against the occasional GC pause.
  samples.sort((a, b) => a - b);
  const mid = Math.floor(samples.length / 2);
  return samples[mid] ?? 0;
}

function benchLs50(db: Database): number {
  // Mirrors src/db/queries/list.ts default: ORDER BY timestamp DESC LIMIT 50.
  const stmt = db.prepare(
    `SELECT t.id, t.account_id, t.timestamp, t.amount, t.currency, t.description,
            t.merchant_name, t.category, t.transaction_type, a.display_name AS account_name
     FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     ORDER BY t.timestamp DESC
     LIMIT 50`,
  );
  return timeMs(() => {
    stmt.all();
  });
}

function benchCategorySummary(db: Database): number {
  // Pre-aggregated tool surface for `ferret ask` (PRD §8.2 get_category_summary).
  // 30-day window covers the most common "this month" question.
  const now = Math.floor(Date.now() / 1000);
  const since = now - 30 * 86_400;
  const stmt = db.prepare(
    `SELECT category, SUM(amount) AS total, COUNT(*) AS txn_count
     FROM transactions
     WHERE timestamp >= ?
     GROUP BY category
     ORDER BY total ASC`,
  );
  return timeMs(() => {
    stmt.all(since);
  });
}

function benchDedupeLookup(db: Database): number {
  // sync.ts checks each incoming provider transaction id against the PK to
  // decide insert-vs-update. This is the per-row hot path — one PK lookup.
  const stmt = db.prepare('SELECT id FROM transactions WHERE id = ? LIMIT 1');
  // Pick a row that definitely exists so we measure the real index path,
  // not the "not found" short-circuit.
  const target = `bench-txn-${(ROW_COUNT - 1).toString().padStart(7, '0')}`;
  return timeMs(() => {
    stmt.all(target);
  }, 50);
}

function renderTable(results: BenchResult[]): string {
  const headers = ['Target', 'Budget (ms)', 'Observed (ms)', 'Status'];
  const rows = results.map((r) => [
    r.name,
    r.budgetMs.toFixed(0),
    r.observedMs.toFixed(2),
    r.passed ? 'PASS' : 'FAIL',
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => (row[i] ?? '').length)),
  );
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? c.length)).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  return [fmt(headers), sep, ...rows.map(fmt)].join('\n');
}

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), 'ferret-bench-'));
  const dbPath = join(dir, 'bench.db');
  const db = new Database(dbPath, { create: true });

  try {
    process.stdout.write(`Seeding ${ROW_COUNT.toLocaleString()} transactions into ${dbPath}...\n`);
    const seedStart = performance.now();
    setupSchema(db);
    seed(db);
    db.exec('ANALYZE;');
    const seedMs = performance.now() - seedStart;
    process.stdout.write(`Seed complete in ${seedMs.toFixed(0)}ms\n\n`);

    const results: BenchResult[] = [
      makeResult(TARGETS.ls50, benchLs50(db)),
      makeResult(TARGETS.categorySummary, benchCategorySummary(db)),
      makeResult(TARGETS.dedupeLookup, benchDedupeLookup(db)),
    ];

    process.stdout.write(`${renderTable(results)}\n`);

    const failed = results.filter((r) => !r.passed);
    if (failed.length > 0) {
      process.stderr.write(
        `\n${failed.length} target(s) missed. Investigate query plan or schema indexes.\n`,
      );
      process.exit(1);
    }
    process.stdout.write('\nAll perf targets met.\n');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeResult(target: BenchTarget, observedMs: number): BenchResult {
  return {
    ...target,
    observedMs,
    passed: observedMs <= target.budgetMs,
  };
}

main();
