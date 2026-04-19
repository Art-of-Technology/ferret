import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'ferret-schema-'));
process.env.HOME = tmp;

const EXPECTED_TABLES = [
  'connections',
  'accounts',
  'transactions',
  'categories',
  'budgets',
  'rules',
  'merchant_cache',
  'sync_log',
] as const;

const EXPECTED_COLUMNS: Record<string, readonly string[]> = {
  connections: [
    'id',
    'provider_id',
    'provider_name',
    'created_at',
    'expires_at',
    'status',
    'last_synced_at',
  ],
  accounts: [
    'id',
    'connection_id',
    'account_type',
    'display_name',
    'iban',
    'sort_code',
    'account_number',
    'currency',
    'balance_available',
    'balance_current',
    'balance_updated_at',
    'is_manual',
  ],
  transactions: [
    'id',
    'account_id',
    'timestamp',
    'amount',
    'currency',
    'description',
    'merchant_name',
    'transaction_type',
    'category',
    'category_source',
    'provider_category',
    'running_balance',
    'is_pending',
    'metadata',
    'created_at',
    'updated_at',
  ],
  categories: ['name', 'parent', 'color', 'icon'],
  budgets: ['id', 'category', 'monthly_amount', 'currency', 'start_date', 'end_date'],
  rules: ['id', 'pattern', 'field', 'category', 'priority', 'created_at'],
  merchant_cache: ['merchant_normalized', 'category', 'confidence', 'source', 'created_at'],
  sync_log: [
    'id',
    'connection_id',
    'started_at',
    'completed_at',
    'status',
    'transactions_added',
    'transactions_updated',
    'error_message',
  ],
};

beforeAll(async () => {
  // Run init against the temp HOME.
  const initMod = await import('../../src/commands/init');
  // citty CommandDef.run signature: run(ctx?). We don't need ctx for init.
  const cmd = initMod.default as { run: (ctx?: unknown) => unknown };
  await cmd.run();
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test('all 8 tables exist', async () => {
  const { getDb } = await import('../../src/db/client');
  const { raw } = getDb();
  const rows = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
    name: string;
  }>;
  const names = new Set(rows.map((r) => r.name));
  for (const t of EXPECTED_TABLES) {
    expect(names.has(t)).toBe(true);
  }
});

test('every table has expected columns', async () => {
  const { getDb } = await import('../../src/db/client');
  const { raw } = getDb();
  for (const [table, expectedCols] of Object.entries(EXPECTED_COLUMNS)) {
    const cols = raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    for (const col of expectedCols) {
      expect(colNames.has(col), `${table}.${col} missing`).toBe(true);
    }
  }
});

test('default categories were seeded', async () => {
  const { getDb } = await import('../../src/db/client');
  const { raw } = getDb();
  const row = raw.prepare('SELECT COUNT(*) as n FROM categories').get() as { n: number };
  expect(row.n).toBeGreaterThanOrEqual(30);
});
