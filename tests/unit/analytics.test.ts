// Tests for the analytics query helpers backing the four `ferret ask`
// tools. We seed a real on-disk SQLite via the project's migrations to
// keep behaviour close to production. Each describe block isolates the
// unit it covers; the seed data spans 3 calendar months so the
// recurring-payment heuristic has data to chew on.

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import {
  detectRecurringPayments,
  getAccountList,
  getCategorySummary,
  runReadOnlyQuery,
} from '../../src/db/queries/analytics';
import * as schema from '../../src/db/schema';
import { ValidationError } from '../../src/lib/errors';

const tmp = mkdtempSync(join(tmpdir(), 'ferret-analytics-'));
const dbPath = join(tmp, 'test.db');
const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, '..', '..', 'src', 'db', 'migrations');

let raw: Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

const REF = new Date(Date.UTC(2026, 3, 15, 12, 0, 0));
const sec = (d: Date): number => Math.floor(d.getTime() / 1000);

beforeAll(() => {
  raw = new Database(dbPath, { create: true });
  db = drizzle(raw, { schema });
  if (existsSync(migrationsFolder)) migrate(db, { migrationsFolder });

  // Seed FK chain.
  raw
    .prepare(
      `INSERT INTO connections (id, provider_id, provider_name, created_at, expires_at, status)
       VALUES ('c1', 'manual', 'TestBank', ?, ?, 'active')`,
    )
    .run(sec(REF), sec(REF) + 86_400 * 90);
  raw
    .prepare(
      `INSERT INTO accounts (id, connection_id, account_type, display_name, currency,
        balance_available, balance_current, balance_updated_at, is_manual)
       VALUES ('a1', 'c1', 'TRANSACTION', 'Current', 'GBP', 100, 100, ?, 1),
              ('a2', 'c1', 'SAVINGS', 'Savings', 'GBP', 5000, 5000, ?, 1)`,
    )
    .run(sec(REF), sec(REF));

  for (const c of [
    'Groceries',
    'Eating Out',
    'Subscriptions',
    'Transport',
    'Income',
    'Uncategorized',
  ]) {
    raw.prepare('INSERT INTO categories (name, parent) VALUES (?, NULL)').run(c);
  }

  const insertTxn = raw.prepare(
    `INSERT INTO transactions
     (id, account_id, timestamp, amount, currency, description, merchant_name,
      transaction_type, category, category_source, created_at, updated_at)
     VALUES (?, 'a1', ?, ?, 'GBP', ?, ?, ?, ?, 'manual', ?, ?)`,
  );

  // Helper for legibility.
  const seed = (
    id: string,
    daysAgo: number,
    amount: number,
    merchant: string,
    category: string,
    type = amount < 0 ? 'DEBIT' : 'CREDIT',
  ): void => {
    const ts = sec(REF) - daysAgo * 86_400;
    insertTxn.run(id, ts, amount, merchant, merchant, type, category, ts, ts);
  };

  // Three calendar months of data: Feb, Mar, Apr 2026 (REF = 2026-04-15).
  // Recurring monthly subscription (Netflix £9.99 every month).
  seed('netflix-feb', 60, -9.99, 'Netflix', 'Subscriptions');
  seed('netflix-mar', 30, -9.99, 'Netflix', 'Subscriptions');
  seed('netflix-apr', 5, -9.99, 'Netflix', 'Subscriptions');

  // Recurring monthly subscription (Spotify £11.99 every month, slight ±5%).
  seed('spotify-feb', 58, -11.99, 'Spotify', 'Subscriptions');
  seed('spotify-mar', 28, -11.5, 'Spotify', 'Subscriptions');
  seed('spotify-apr', 3, -12.49, 'Spotify', 'Subscriptions');

  // One-off (Amazon £40, only once -> NOT recurring).
  seed('amazon-once', 7, -40, 'Amazon', 'Uncategorized');

  // Variable-amount merchant (Tesco) — should NOT be detected as recurring
  // because amounts vary wildly (no median ±10 % cluster reaches 3 months).
  seed('tesco-feb', 50, -25, 'Tesco', 'Groceries');
  seed('tesco-mar', 22, -120, 'Tesco', 'Groceries');
  seed('tesco-apr', 4, -8, 'Tesco', 'Groceries');

  // Salary credit (positive amount) — recurring detector ignores positives.
  seed('salary-feb', 55, 2500, 'Acme Payroll', 'Income', 'CREDIT');
  seed('salary-mar', 25, 2500, 'Acme Payroll', 'Income', 'CREDIT');
  seed('salary-apr', 1, 2500, 'Acme Payroll', 'Income', 'CREDIT');

  // Eating out — sparse, only twice (different months). Stable amounts so
  // the ±10 % filter passes; below default threshold (3) but above 2.
  seed('eat-mar', 28, -25, 'Dishoom', 'Eating Out');
  seed('eat-apr', 6, -26, 'Dishoom', 'Eating Out');
});

afterAll(() => {
  raw.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('getCategorySummary', () => {
  test('sums per category in the requested window', () => {
    const from = new Date(Date.UTC(2026, 3, 1, 0, 0, 0)); // Apr 1
    const to = new Date(Date.UTC(2026, 3, 30, 23, 59, 59)); // Apr 30
    const rows = getCategorySummary({ from, to }, db);
    const byCat = new Map(rows.map((r) => [r.category, r.total]));
    // Apr only: Netflix -9.99 + Spotify -12.49 = -22.48
    expect(byCat.get('Subscriptions')).toBeCloseTo(-22.48, 2);
    // Apr only: Tesco -8
    expect(byCat.get('Groceries')).toBeCloseTo(-8, 2);
    // Apr only: Salary +2500
    expect(byCat.get('Income')).toBeCloseTo(2500, 2);
    // Eating Out Apr only: -26
    expect(byCat.get('Eating Out')).toBeCloseTo(-26, 2);
  });

  test('respects from/to bounds (excludes February rows from Mar+Apr window)', () => {
    const from = new Date(Date.UTC(2026, 2, 1, 0, 0, 0)); // Mar 1
    const to = new Date(Date.UTC(2026, 3, 30, 23, 59, 59));
    const rows = getCategorySummary({ from, to }, db);
    const subs = rows.find((r) => r.category === 'Subscriptions');
    // Mar+Apr Netflix+Spotify: -9.99 -9.99 -11.5 -12.49 = -43.97
    expect(subs?.total).toBeCloseTo(-43.97, 2);
  });

  test('rejects an inverted range', () => {
    expect(() =>
      getCategorySummary(
        { from: new Date(Date.UTC(2026, 4, 1)), to: new Date(Date.UTC(2026, 3, 1)) },
        db,
      ),
    ).toThrow(ValidationError);
  });
});

describe('detectRecurringPayments', () => {
  test('detects Netflix and Spotify (3 months each, stable amount)', () => {
    const rows = detectRecurringPayments({ minOccurrences: 3 }, db);
    const merchants = new Set(rows.map((r) => r.merchant));
    expect(merchants.has('Netflix')).toBe(true);
    expect(merchants.has('Spotify')).toBe(true);

    const netflix = rows.find((r) => r.merchant === 'Netflix');
    expect(netflix?.occurrences).toBe(3);
    expect(netflix?.monthlyAmount).toBeCloseTo(9.99, 2);
  });

  test('does NOT detect a one-off purchase', () => {
    const rows = detectRecurringPayments({ minOccurrences: 3 }, db);
    expect(rows.find((r) => r.merchant === 'Amazon')).toBeUndefined();
  });

  test('does NOT detect Tesco (amounts vary wildly, fails ±10 % filter)', () => {
    const rows = detectRecurringPayments({ minOccurrences: 3 }, db);
    expect(rows.find((r) => r.merchant === 'Tesco')).toBeUndefined();
  });

  test('does NOT detect a positive (salary) recurring credit', () => {
    const rows = detectRecurringPayments({ minOccurrences: 3 }, db);
    expect(rows.find((r) => r.merchant === 'Acme Payroll')).toBeUndefined();
  });

  test('lower threshold pulls in two-month merchants', () => {
    const rows = detectRecurringPayments({ minOccurrences: 2 }, db);
    expect(rows.find((r) => r.merchant === 'Dishoom')).toBeDefined();
  });
});

describe('getAccountList', () => {
  test('returns every account', () => {
    const rows = getAccountList(db);
    expect(rows.length).toBe(2);
    const names = rows.map((r) => r.displayName).sort();
    expect(names).toEqual(['Current', 'Savings']);
  });

  test('exposes balance fields for Claude to render', () => {
    const rows = getAccountList(db);
    const current = rows.find((r) => r.displayName === 'Current');
    expect(current?.balanceCurrent).toBe(100);
    expect(current?.currency).toBe('GBP');
  });
});

describe('runReadOnlyQuery', () => {
  test('runs a SELECT and returns rows', () => {
    const rows = runReadOnlyQuery(
      'SELECT merchant_name, amount FROM transactions WHERE merchant_name = ? ORDER BY timestamp',
      ['Netflix'],
      { raw, maxRows: 10 },
    );
    expect(rows.length).toBe(3);
    expect((rows[0] as { merchant_name: string }).merchant_name).toBe('Netflix');
  });

  test('rejects an INSERT (validator catches it before execution)', () => {
    expect(() =>
      runReadOnlyQuery("INSERT INTO transactions VALUES ('x')", [], { raw, maxRows: 10 }),
    ).toThrow(ValidationError);
  });

  test('rejects a comment-injected DROP', () => {
    expect(() =>
      runReadOnlyQuery('SELECT 1 -- ; DROP TABLE transactions', [], { raw, maxRows: 10 }),
    ).toThrow(ValidationError);
  });

  test('caps results at the supplied maxRows', () => {
    const rows = runReadOnlyQuery('SELECT id FROM transactions', [], { raw, maxRows: 3 });
    expect(rows.length).toBe(3);
  });
});
