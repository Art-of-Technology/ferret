import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb, resetDbCache } from '../../src/db/client';

const tmp = mkdtempSync(join(tmpdir(), 'ferret-import-'));
const DB_PATH = join(tmp, 'ferret.db');

const LLOYDS_FIXTURE = [
  'Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance',
  '15/04/2026,DEB,30-99-50,12345678,TESCO STORES,12.50,,1234.56',
  '16/04/2026,FPI,30-99-50,12345678,SALARY,,2500.00,3734.56',
].join('\n');

function migrationsFolder(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  return join(here, '..', '..', 'src', 'db', 'migrations');
}

beforeAll(() => {
  // Tests share a Bun process with frozen DB_PATH constants in client.ts.
  // Bypass that by passing an explicit dbPath to getDb() and threading it
  // through parseImport via deps.db.
  resetDbCache();
  const { db } = getDb(DB_PATH);
  migrate(db, { migrationsFolder: migrationsFolder() });
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test('parseImport inserts CSV rows into a virtual manual account', async () => {
  const csvPath = join(tmp, 'lloyds.csv');
  writeFileSync(csvPath, LLOYDS_FIXTURE);

  const { parseImport } = await import('../../src/services/importers');
  const { db, raw } = getDb(DB_PATH);
  const result = parseImport(csvPath, { format: 'lloyds' }, { db });

  expect(result.format).toBe('lloyds');
  expect(result.parsed).toBe(2);
  expect(result.inserted).toBe(2);
  expect(result.duplicates).toBe(0);

  const rows = raw
    .prepare('SELECT amount, description FROM transactions WHERE account_id = ?')
    .all(result.accountId) as Array<{ amount: number; description: string }>;
  expect(rows.length).toBe(2);
  const tesco = rows.find((r) => r.description === 'TESCO STORES');
  const salary = rows.find((r) => r.description === 'SALARY');
  expect(tesco?.amount).toBe(-12.5);
  expect(salary?.amount).toBe(2500);
});

test('parseImport is idempotent: re-importing same file yields all duplicates', async () => {
  const csv = [
    'Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance',
    '01/01/2026,DEB,30-99-50,12345678,IDEMPOTENT A,1.00,,1.00',
    '02/01/2026,DEB,30-99-50,12345678,IDEMPOTENT B,2.00,,2.00',
  ].join('\n');
  const csvPath = join(tmp, 'lloyds-2.csv');
  writeFileSync(csvPath, csv);

  const { parseImport } = await import('../../src/services/importers');
  const { db } = getDb(DB_PATH);
  const first = parseImport(csvPath, { format: 'lloyds' }, { db });
  expect(first.inserted).toBe(2);

  const second = parseImport(csvPath, { format: 'lloyds' }, { db });
  expect(second.inserted).toBe(0);
  expect(second.duplicates).toBe(2);
});

test('parseImport --dry-run does not insert', async () => {
  const csvPath = join(tmp, 'lloyds-3.csv');
  writeFileSync(
    csvPath,
    [
      'Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance',
      '20/04/2026,DEB,30-99-50,12345678,DRYRUN ONLY,1.00,,100.00',
    ].join('\n'),
  );

  const { parseImport } = await import('../../src/services/importers');
  const { db, raw } = getDb(DB_PATH);
  const result = parseImport(csvPath, { format: 'lloyds', dryRun: true }, { db });

  expect(result.dryRun).toBe(true);
  expect(result.inserted).toBe(0);
  expect(result.parsed).toBe(1);

  const matches = raw
    .prepare('SELECT COUNT(*) as n FROM transactions WHERE description = ?')
    .get('DRYRUN ONLY') as { n: number };
  expect(matches.n).toBe(0);
});

test('parseImport throws ValidationError when format cannot be detected', async () => {
  const csvPath = join(tmp, 'unknown.csv');
  writeFileSync(csvPath, 'foo,bar\n1,2\n');

  const { parseImport } = await import('../../src/services/importers');
  const { db } = getDb(DB_PATH);
  expect(() => parseImport(csvPath, {}, { db })).toThrow(/Unable to detect/);
});

test('parseImport throws ValidationError when file does not exist', async () => {
  const { parseImport } = await import('../../src/services/importers');
  const { db } = getDb(DB_PATH);
  expect(() => parseImport(join(tmp, 'nonexistent.csv'), {}, { db })).toThrow(/File not found/);
});
