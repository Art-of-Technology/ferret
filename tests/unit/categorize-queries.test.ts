import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import {
  applyCategoryAssignments,
  categoryExists,
  clearAutoCategorizations,
  getNextRulePriority,
  getRules,
  getTransactionById,
  listAllNonManualTransactions,
  listCategoryNames,
  listUncategorizedTransactions,
  loadMerchantCache,
  upsertMerchantCacheEntry,
} from '../../src/db/queries/categorize';
import * as schema from '../../src/db/schema';

const tmp = mkdtempSync(join(tmpdir(), 'ferret-cat-q-'));
const dbPath = join(tmp, 'test.db');

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, '..', '..', 'src', 'db', 'migrations');

let raw: Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

const REF = new Date(Date.UTC(2026, 3, 19, 12, 0, 0));
const sec = (d: Date): number => Math.floor(d.getTime() / 1000);

beforeAll(() => {
  raw = new Database(dbPath, { create: true });
  db = drizzle(raw, { schema });
  if (existsSync(migrationsFolder)) migrate(db, { migrationsFolder });

  // Seed FK chain: connection -> account.
  raw
    .prepare(
      `INSERT INTO connections (id, provider_id, provider_name, created_at, expires_at, status)
       VALUES ('c1', 'manual', 'Test', ?, ?, 'active')`,
    )
    .run(sec(REF), sec(REF) + 86_400);
  raw
    .prepare(
      `INSERT INTO accounts (id, connection_id, account_type, display_name, currency)
       VALUES ('a1', 'c1', 'TRANSACTION', 'Test', 'GBP')`,
    )
    .run();

  // 4 categories needed by these tests.
  const insertCat = raw.prepare('INSERT INTO categories (name, parent) VALUES (?, NULL)');
  for (const c of ['Groceries', 'Eating Out', 'Subscriptions', 'Uncategorized']) insertCat.run(c);

  // 5 transactions: mix of category sources for filtering.
  const insertTxn = raw.prepare(
    `INSERT INTO transactions
     (id, account_id, timestamp, amount, currency, description, merchant_name,
      transaction_type, category, category_source, created_at, updated_at)
     VALUES (?, 'a1', ?, ?, 'GBP', ?, ?, 'DEBIT', ?, ?, ?, ?)`,
  );
  // null category -> uncategorized
  insertTxn.run(
    't-null',
    sec(REF) - 86_400,
    -10,
    'NEW MERCHANT',
    'New',
    null,
    null,
    sec(REF),
    sec(REF),
  );
  // explicitly Uncategorized -> still considered uncategorized
  insertTxn.run(
    't-explicit-unc',
    sec(REF) - 2 * 86_400,
    -5,
    'OTHER',
    'Other',
    'Uncategorized',
    'claude',
    sec(REF),
    sec(REF),
  );
  // manual override (preserved by --retag)
  insertTxn.run(
    't-manual',
    sec(REF) - 3 * 86_400,
    -20,
    'MANUAL CHOICE',
    'Manual',
    'Subscriptions',
    'manual',
    sec(REF),
    sec(REF),
  );
  // cache hit (wiped by --retag)
  insertTxn.run(
    't-cache',
    sec(REF) - 4 * 86_400,
    -7,
    'CACHED',
    'Cached',
    'Subscriptions',
    'cache',
    sec(REF),
    sec(REF),
  );
  // claude hit (wiped by --retag)
  insertTxn.run(
    't-claude',
    sec(REF) - 5 * 86_400,
    -8,
    'AI ASSIGN',
    'AI',
    'Eating Out',
    'claude',
    sec(REF),
    sec(REF),
  );
});

afterAll(() => {
  raw.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('categorize query helpers', () => {
  test('listUncategorizedTransactions returns null + Uncategorized rows', () => {
    const rows = listUncategorizedTransactions(db);
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(['t-explicit-unc', 't-null']);
  });

  test('listAllNonManualTransactions excludes manual but includes cache+claude+null', () => {
    const rows = listAllNonManualTransactions(db);
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(['t-cache', 't-claude', 't-explicit-unc', 't-null']);
  });

  test('categoryExists / listCategoryNames smoke', () => {
    expect(categoryExists('Groceries', db)).toBe(true);
    expect(categoryExists('NotARealCat', db)).toBe(false);
    expect(listCategoryNames(db).sort()).toEqual([
      'Eating Out',
      'Groceries',
      'Subscriptions',
      'Uncategorized',
    ]);
  });

  test('upsertMerchantCacheEntry + loadMerchantCache round trip', () => {
    upsertMerchantCacheEntry(
      { normalized: 'tesco', category: 'Groceries', confidence: 0.95, source: 'claude' },
      db,
    );
    upsertMerchantCacheEntry(
      { normalized: 'tesco', category: 'Groceries', confidence: 0.99, source: 'claude' },
      db,
    );
    upsertMerchantCacheEntry(
      { normalized: 'pret', category: 'Eating Out', confidence: 0.8, source: 'manual' },
      db,
    );
    const cache = loadMerchantCache(db);
    expect(cache.get('tesco')).toBe('Groceries');
    expect(cache.get('pret')).toBe('Eating Out');
  });

  test('getRules / getNextRulePriority', () => {
    expect(getRules(db)).toEqual([]);
    expect(getNextRulePriority(db)).toBe(1);
    raw
      .prepare(
        `INSERT INTO rules (id, pattern, field, category, priority, created_at)
         VALUES ('r1', '^Tesco', 'merchant', 'Groceries', 5, ?)`,
      )
      .run(sec(REF));
    raw
      .prepare(
        `INSERT INTO rules (id, pattern, field, category, priority, created_at)
         VALUES ('r2', '^Pret', 'merchant', 'Eating Out', 10, ?)`,
      )
      .run(sec(REF));
    const rs = getRules(db);
    expect(rs[0]?.id).toBe('r2'); // priority 10 first
    expect(rs[1]?.id).toBe('r1');
    expect(getNextRulePriority(db)).toBe(11);
  });

  test('applyCategoryAssignments updates rows + categorySource', () => {
    applyCategoryAssignments(
      [{ transactionId: 't-null', category: 'Groceries', source: 'rule' }],
      db,
    );
    const row = getTransactionById('t-null', db);
    expect(row).not.toBeNull();
    // Re-load to verify category column too.
    const verify = raw
      .prepare('SELECT category, category_source FROM transactions WHERE id = ?')
      .get('t-null') as { category: string; category_source: string } | undefined;
    expect(verify?.category).toBe('Groceries');
    expect(verify?.category_source).toBe('rule');
  });

  test('clearAutoCategorizations wipes cache+claude only, keeps manual', () => {
    const cleared = clearAutoCategorizations(db);
    expect(cleared).toBeGreaterThanOrEqual(2); // t-cache + t-claude + t-explicit-unc

    const manual = raw
      .prepare('SELECT category, category_source FROM transactions WHERE id = ?')
      .get('t-manual') as { category: string | null; category_source: string | null };
    expect(manual.category).toBe('Subscriptions');
    expect(manual.category_source).toBe('manual');

    const cache = raw
      .prepare('SELECT category, category_source FROM transactions WHERE id = ?')
      .get('t-cache') as { category: string | null; category_source: string | null };
    expect(cache.category).toBeNull();
    expect(cache.category_source).toBeNull();
  });
});
