// Direct tests for src/db/queries/sync.ts.
// Spins up a temp SQLite DB per test file, runs migrations, exercises every
// helper. Uses an explicit `db` parameter to avoid colliding with the global
// proxy used by other suites.

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import {
  bulkInsertTransactions,
  getAccount,
  getConnection,
  getLatestTransactionTimestamp,
  listAccountsForConnection,
  listActiveConnections,
  markConnectionLastSynced,
  markConnectionStatus,
  recordSyncLog,
  updateAccountBalance,
  updateTransaction,
  upsertAccount,
} from '../../src/db/queries/sync';
import * as schema from '../../src/db/schema';

const tmp = mkdtempSync(join(tmpdir(), 'ferret-sync-q-'));
const dbPath = join(tmp, 'sq.db');

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, '..', '..', 'src', 'db', 'migrations');

let raw: Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(() => {
  raw = new Database(dbPath, { create: true });
  db = drizzle(raw, { schema });
  if (existsSync(migrationsFolder)) migrate(db, { migrationsFolder });
  seed();
});

afterAll(() => {
  raw.close();
  rmSync(tmp, { recursive: true, force: true });
});

const REF = new Date(Date.UTC(2026, 3, 19, 12, 0, 0));

function seed(): void {
  const conn = raw.prepare(
    `INSERT INTO connections (id, provider_id, provider_name, created_at, expires_at, status, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const sec = (d: Date) => Math.floor(d.getTime() / 1000);
  // Active
  conn.run('c-active', 'uk-ob-lloyds', 'Lloyds', sec(REF), sec(REF) + 86_400 * 90, 'active', null);
  // Expired
  conn.run('c-expired', 'uk-ob-natwest', 'NatWest', sec(REF), sec(REF) - 86_400, 'expired', null);
  // Active 2 (also active)
  conn.run('c-active-2', 'uk-ob-hsbc', 'HSBC', sec(REF), sec(REF) + 86_400 * 30, 'active', null);

  const acct = raw.prepare(
    `INSERT INTO accounts (id, connection_id, account_type, display_name, currency)
     VALUES (?, ?, ?, ?, 'GBP')`,
  );
  acct.run('a-lloyds-1', 'c-active', 'TRANSACTION', 'Lloyds Current');
  acct.run('a-lloyds-2', 'c-active', 'SAVINGS', 'Lloyds ISA');
  acct.run('a-hsbc-1', 'c-active-2', 'TRANSACTION', 'HSBC Current');
}

describe('listActiveConnections', () => {
  test('returns only rows with status=active', () => {
    const rows = listActiveConnections(db);
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(['c-active', 'c-active-2']);
  });
});

describe('getConnection', () => {
  test('returns the row when present', () => {
    const c = getConnection('c-active', db);
    expect(c?.providerName).toBe('Lloyds');
  });

  test('returns null when absent', () => {
    expect(getConnection('does-not-exist', db)).toBeNull();
  });
});

describe('listAccountsForConnection', () => {
  test('returns every account for the connection id', () => {
    const rows = listAccountsForConnection('c-active', db);
    expect(rows.map((r) => r.id).sort()).toEqual(['a-lloyds-1', 'a-lloyds-2']);
  });
  test('returns [] when none', () => {
    expect(listAccountsForConnection('c-expired', db)).toEqual([]);
  });
});

describe('upsertAccount', () => {
  test('inserts a brand-new account', () => {
    upsertAccount(
      {
        id: 'a-new-1',
        connectionId: 'c-active',
        accountType: 'TRANSACTION',
        displayName: 'New Account',
        currency: 'GBP',
        balanceCurrent: 100.5,
        balanceAvailable: 90.0,
        balanceUpdatedAt: REF,
      },
      db,
    );
    const row = getAccount('a-new-1', db);
    expect(row?.displayName).toBe('New Account');
    expect(row?.balanceCurrent).toBe(100.5);
    expect(row?.balanceAvailable).toBe(90.0);
  });

  test('updates mutable fields when row exists', () => {
    upsertAccount(
      {
        id: 'a-lloyds-1',
        connectionId: 'c-active',
        accountType: 'TRANSACTION',
        displayName: 'Lloyds Current (renamed)',
        currency: 'GBP',
        balanceCurrent: 1234.56,
        balanceAvailable: 1200.0,
        balanceUpdatedAt: REF,
      },
      db,
    );
    const row = getAccount('a-lloyds-1', db);
    expect(row?.displayName).toBe('Lloyds Current (renamed)');
    expect(row?.balanceCurrent).toBe(1234.56);
  });

  test('never overwrites is_manual when set elsewhere', () => {
    raw
      .prepare(
        `INSERT INTO accounts (id, connection_id, account_type, display_name, currency, is_manual)
         VALUES ('manual-x', 'c-active', 'TRANSACTION', 'M', 'GBP', 1)`,
      )
      .run();
    upsertAccount(
      {
        id: 'manual-x',
        connectionId: 'c-active',
        accountType: 'TRANSACTION',
        displayName: 'M2',
        currency: 'GBP',
      },
      db,
    );
    const row = raw.prepare('SELECT is_manual FROM accounts WHERE id = ?').get('manual-x') as {
      is_manual: number;
    };
    expect(row.is_manual).toBe(1);
  });
});

describe('updateAccountBalance', () => {
  test('writes balance fields without affecting display name', () => {
    updateAccountBalance('a-hsbc-1', { available: 500, current: 600, updatedAt: REF }, db);
    const row = getAccount('a-hsbc-1', db);
    expect(row?.balanceCurrent).toBe(600);
    expect(row?.balanceAvailable).toBe(500);
    expect(row?.displayName).toBe('HSBC Current');
  });
});

describe('bulkInsertTransactions', () => {
  test('inserts new rows and reports inserted count', () => {
    const rows = [mkTxn('t-q-1', 'a-lloyds-1', REF, -10), mkTxn('t-q-2', 'a-lloyds-1', REF, -20)];
    const res = bulkInsertTransactions(rows, db);
    expect(res.attempted).toBe(2);
    expect(res.inserted).toBe(2);
  });

  test('ON CONFLICT IGNORE on the PK (provider_transaction_id)', () => {
    const rows = [mkTxn('t-q-1', 'a-lloyds-1', REF, -10), mkTxn('t-q-3', 'a-lloyds-1', REF, -30)];
    const res = bulkInsertTransactions(rows, db);
    expect(res.attempted).toBe(2);
    // Only t-q-3 is new.
    expect(res.inserted).toBe(1);
  });

  test('handles 0-row input', () => {
    expect(bulkInsertTransactions([], db)).toEqual({ attempted: 0, inserted: 0 });
  });

  test('chunks > 500 rows still insert correctly', () => {
    const big: ReturnType<typeof mkTxn>[] = [];
    for (let i = 0; i < 750; i++) {
      big.push(mkTxn(`t-bulk-${i}`, 'a-lloyds-2', REF, -i));
    }
    const res = bulkInsertTransactions(big, db);
    expect(res.attempted).toBe(750);
    expect(res.inserted).toBe(750);
  });
});

describe('updateTransaction', () => {
  test('updates mutable fields and returns true', () => {
    const ok = updateTransaction(
      { id: 't-q-1', amount: -99, isPending: true, merchantName: 'Foo' },
      db,
    );
    expect(ok).toBe(true);
    const row = raw
      .prepare('SELECT amount, is_pending, merchant_name FROM transactions WHERE id = ?')
      .get('t-q-1') as { amount: number; is_pending: number; merchant_name: string };
    expect(row.amount).toBe(-99);
    expect(row.is_pending).toBe(1);
    expect(row.merchant_name).toBe('Foo');
  });

  test('returns false when row missing', () => {
    expect(updateTransaction({ id: 'never-existed', amount: 1 }, db)).toBe(false);
  });
});

describe('markConnectionLastSynced', () => {
  test('writes the timestamp', () => {
    const stamp = new Date(REF.getTime() + 5_000);
    markConnectionLastSynced('c-active', stamp, db);
    const row = getConnection('c-active', db);
    expect(row?.lastSyncedAt?.getTime()).toBe(stamp.getTime());
  });
});

describe('markConnectionStatus', () => {
  test('updates status', () => {
    markConnectionStatus('c-active-2', 'needs_reauth', 'auth failed', db);
    const row = getConnection('c-active-2', db);
    expect(row?.status).toBe('needs_reauth');
    // Reset so other tests aren't affected.
    markConnectionStatus('c-active-2', 'active', undefined, db);
  });
});

describe('recordSyncLog', () => {
  test('appends a row with rolled-up counts', () => {
    recordSyncLog(
      {
        connectionId: 'c-active',
        startedAt: REF,
        completedAt: new Date(REF.getTime() + 1000),
        status: 'success',
        transactionsAdded: 3,
        transactionsUpdated: 1,
      },
      db,
    );
    const rows = raw
      .prepare('SELECT status, transactions_added, transactions_updated FROM sync_log')
      .all() as Array<{ status: string; transactions_added: number; transactions_updated: number }>;
    const last = rows[rows.length - 1];
    expect(last?.status).toBe('success');
    expect(last?.transactions_added).toBe(3);
    expect(last?.transactions_updated).toBe(1);
  });

  test('records a failed entry with errorMessage', () => {
    recordSyncLog(
      {
        connectionId: 'c-active',
        startedAt: REF,
        completedAt: new Date(REF.getTime() + 1000),
        status: 'failed',
        errorMessage: 'boom',
      },
      db,
    );
    const rows = raw
      .prepare('SELECT error_message FROM sync_log WHERE status = ?')
      .all('failed') as Array<{
      error_message: string;
    }>;
    expect(rows.some((r) => r.error_message === 'boom')).toBe(true);
  });
});

describe('getLatestTransactionTimestamp', () => {
  test('returns the max timestamp for an account', () => {
    const t1 = new Date(REF.getTime() - 86_400_000);
    const t2 = new Date(REF.getTime() - 3 * 86_400_000);
    raw
      .prepare(
        `INSERT INTO transactions (id, account_id, timestamp, amount, currency, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'GBP', 'd', ?, ?)`,
      )
      .run(
        'ts-1',
        'a-hsbc-1',
        Math.floor(t1.getTime() / 1000),
        -1,
        Math.floor(REF.getTime() / 1000),
        Math.floor(REF.getTime() / 1000),
      );
    raw
      .prepare(
        `INSERT INTO transactions (id, account_id, timestamp, amount, currency, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'GBP', 'd', ?, ?)`,
      )
      .run(
        'ts-2',
        'a-hsbc-1',
        Math.floor(t2.getTime() / 1000),
        -2,
        Math.floor(REF.getTime() / 1000),
        Math.floor(REF.getTime() / 1000),
      );
    const got = getLatestTransactionTimestamp('a-hsbc-1', db);
    expect(got?.getTime()).toBe(t1.getTime());
  });

  test('returns null when no rows', () => {
    expect(getLatestTransactionTimestamp('a-no-rows', db)).toBeNull();
  });
});

function mkTxn(id: string, accountId: string, ts: Date, amount: number) {
  return {
    id,
    accountId,
    timestamp: ts,
    amount,
    currency: 'GBP',
    description: `desc-${id}`,
    isPending: false,
    createdAt: ts,
    updatedAt: ts,
  };
}
