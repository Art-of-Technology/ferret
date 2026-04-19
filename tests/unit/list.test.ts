import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { listTransactions } from '../../src/db/queries/list';
import * as schema from '../../src/db/schema';

const tmp = mkdtempSync(join(tmpdir(), 'ferret-list-'));
const dbPath = join(tmp, 'test.db');

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, '..', '..', 'src', 'db', 'migrations');

let raw: Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(() => {
  raw = new Database(dbPath, { create: true });
  db = drizzle(raw, { schema });
  if (existsSync(migrationsFolder)) {
    migrate(db, { migrationsFolder });
  }
  seedFixtures(raw);
});

afterAll(() => {
  raw.close();
  rmSync(tmp, { recursive: true, force: true });
});

const REF = new Date(Date.UTC(2026, 3, 19, 12, 0, 0)); // 2026-04-19T12:00:00Z

function seedFixtures(raw: Database): void {
  const conn = raw.prepare(
    `INSERT INTO connections (id, provider_id, provider_name, created_at, expires_at, status)
     VALUES (?, ?, ?, ?, ?, 'active')`,
  );
  conn.run('conn-1', 'manual', 'TestBank', sec(REF), sec(REF) + 86_400);

  const acct = raw.prepare(
    `INSERT INTO accounts (id, connection_id, account_type, display_name, currency)
     VALUES (?, 'conn-1', 'TRANSACTION', ?, 'GBP')`,
  );
  acct.run('acct-current', 'Current Account');
  acct.run('acct-savings', 'Savings');

  const txn = raw.prepare(
    `INSERT INTO transactions (id, account_id, timestamp, amount, currency, description,
      merchant_name, transaction_type, category, category_source, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'GBP', ?, ?, ?, ?, 'cache', ?, ?)`,
  );

  // Helper: ts in seconds, days ago from REF.
  const ago = (days: number): number => sec(REF) - days * 86_400;

  // 10 fixture rows spanning various filters.
  const rows: Array<[string, string, number, number, string, string, string, string]> = [
    ['t1', 'acct-current', ago(1), -12.5, 'Tesco purchase', 'Tesco', 'DEBIT', 'Groceries'],
    ['t2', 'acct-current', ago(3), -25.0, 'Pret a Manger', 'Pret a Manger', 'DEBIT', 'Eating Out'],
    ['t3', 'acct-current', ago(5), -100.0, 'Uber', 'Uber', 'DEBIT', 'Ride Share'],
    ['t4', 'acct-current', ago(7), 1500.0, 'Salary credit', 'EmployerCo', 'CREDIT', 'Salary'],
    ['t5', 'acct-savings', ago(10), -75.5, 'Spotify', 'Spotify', 'DEBIT', 'Subscriptions'],
    ['t6', 'acct-savings', ago(20), -8.0, 'Netflix', 'Netflix', 'DEBIT', 'Subscriptions'],
    ['t7', 'acct-current', ago(40), -200.0, 'Shell fuel', 'Shell', 'DEBIT', 'Fuel'],
    ['t8', 'acct-current', ago(50), -55.0, 'Tesco big shop', 'Tesco', 'DEBIT', 'Groceries'],
    ['t9', 'acct-current', ago(2), 50.0, 'Refund Amazon', 'Amazon', 'CREDIT', 'General'],
    ['t10', 'acct-current', ago(15), -33.33, 'Boots pharmacy', 'Boots', 'DEBIT', 'Pharmacy'],
  ];

  for (const r of rows) {
    txn.run(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[2], r[2]);
  }
}

function sec(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

describe('listTransactions', () => {
  test('returns all rows by default sorted by timestamp desc', () => {
    const rows = listTransactions({}, db);
    expect(rows.length).toBe(10);
    for (let i = 1; i < rows.length; i++) {
      expect((rows[i - 1] as { timestamp: Date }).timestamp.getTime()).toBeGreaterThanOrEqual(
        (rows[i] as { timestamp: Date }).timestamp.getTime(),
      );
    }
  });

  test('respects --limit', () => {
    const rows = listTransactions({ limit: 3 }, db);
    expect(rows.length).toBe(3);
  });

  test('default limit is 50', () => {
    const rows = listTransactions({}, db);
    expect(rows.length).toBeLessThanOrEqual(50);
  });

  test('filters by --since', () => {
    const since = new Date(REF.getTime() - 7 * 86_400_000);
    const rows = listTransactions({ since }, db);
    expect(rows.every((r) => r.timestamp.getTime() >= since.getTime())).toBe(true);
    expect(rows.map((r) => r.id).sort()).toEqual(['t1', 't2', 't3', 't4', 't9']);
  });

  test('filters by --until', () => {
    const until = new Date(REF.getTime() - 30 * 86_400_000);
    const rows = listTransactions({ until }, db);
    expect(rows.every((r) => r.timestamp.getTime() <= until.getTime())).toBe(true);
    expect(rows.map((r) => r.id).sort()).toEqual(['t7', 't8']);
  });

  test('filters by category', () => {
    const rows = listTransactions({ category: 'Groceries' }, db);
    expect(rows.map((r) => r.id).sort()).toEqual(['t1', 't8']);
  });

  test('filters by merchant substring (case-insensitive)', () => {
    const rows = listTransactions({ merchant: 'tesco' }, db);
    expect(rows.map((r) => r.id).sort()).toEqual(['t1', 't8']);
  });

  test('filters by accountId UUID', () => {
    const rows = listTransactions({ accountId: 'acct-savings' }, db);
    expect(rows.map((r) => r.id).sort()).toEqual(['t5', 't6']);
  });

  test('filters by account display name', () => {
    const rows = listTransactions({ accountId: 'Savings' }, db);
    expect(rows.map((r) => r.id).sort()).toEqual(['t5', 't6']);
  });

  test('filters by --min on absolute amount', () => {
    const rows = listTransactions({ min: 100 }, db);
    // |amount| >= 100 -> t3 (-100), t4 (1500), t7 (-200)
    expect(rows.map((r) => r.id).sort()).toEqual(['t3', 't4', 't7']);
  });

  test('filters by --max on absolute amount', () => {
    const rows = listTransactions({ max: 20 }, db);
    // |amount| <= 20 -> t1 (-12.5), t6 (-8)
    expect(rows.map((r) => r.id).sort()).toEqual(['t1', 't6']);
  });

  test('combines --min and --max', () => {
    const rows = listTransactions({ min: 30, max: 80 }, db);
    // |amount| in [30, 80]: t5 (-75.5), t8 (-55), t9 (+50), t10 (-33.33)
    expect(rows.map((r) => r.id).sort()).toEqual(['t10', 't5', 't8', 't9']);
  });

  test('filters direction=incoming', () => {
    const rows = listTransactions({ direction: 'incoming' }, db);
    expect(rows.map((r) => r.id).sort()).toEqual(['t4', 't9']);
    expect(rows.every((r) => r.amount >= 0)).toBe(true);
  });

  test('filters direction=outgoing', () => {
    const rows = listTransactions({ direction: 'outgoing' }, db);
    expect(rows.every((r) => r.amount <= 0)).toBe(true);
    expect(rows.length).toBe(8);
  });

  test('sorts by amount asc', () => {
    const rows = listTransactions({ sort: { field: 'amount', dir: 'asc' } }, db);
    for (let i = 1; i < rows.length; i++) {
      expect((rows[i - 1] as { amount: number }).amount).toBeLessThanOrEqual(
        (rows[i] as { amount: number }).amount,
      );
    }
  });

  test('sorts by amount desc', () => {
    const rows = listTransactions({ sort: { field: 'amount', dir: 'desc' } }, db);
    expect(rows[0]?.id).toBe('t4'); // largest amount = +1500
  });

  test('sorts by merchant asc', () => {
    const rows = listTransactions({ sort: { field: 'merchant', dir: 'asc' }, limit: 3 }, db);
    expect(rows[0]?.merchantName).toBe('Amazon');
  });

  test('joins account display name', () => {
    const rows = listTransactions({ category: 'Subscriptions' }, db);
    expect(rows.every((r) => r.accountName === 'Savings')).toBe(true);
  });

  test('combines multiple filters', () => {
    const since = new Date(REF.getTime() - 30 * 86_400_000);
    const rows = listTransactions(
      {
        since,
        direction: 'outgoing',
        merchant: 'Tesco',
      },
      db,
    );
    expect(rows.map((r) => r.id).sort()).toEqual(['t1']);
  });

  test('throws on negative --min', () => {
    expect(() => listTransactions({ min: -1 }, db)).toThrow();
  });

  test('throws on negative --max', () => {
    expect(() => listTransactions({ max: -1 }, db)).toThrow();
  });

  test('throws on non-positive --limit', () => {
    expect(() => listTransactions({ limit: 0 }, db)).toThrow();
    expect(() => listTransactions({ limit: -5 }, db)).toThrow();
  });
});
