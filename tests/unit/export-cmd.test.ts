import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = mkdtempSync(join(tmpdir(), 'ferret-export-'));
const FERRET_HOME = join(tmp, '.ferret');
const DB_PATH = join(FERRET_HOME, 'ferret.db');
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

beforeAll(() => {
  // Run `ferret init` in a clean subprocess so that the resulting DB lives at
  // the temp HOME, then seed transactions directly into that on-disk DB.
  const env = subprocessEnv();
  const initRes = Bun.spawnSync({
    cmd: ['bun', 'run', join(projectRoot, 'src', 'cli.ts'), 'init'],
    cwd: projectRoot,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (initRes.exitCode !== 0) {
    throw new Error(`init failed: ${initRes.stderr.toString()}`);
  }

  // Seed test transactions via raw sqlite at DB_PATH (timestamps stored as
  // unix-seconds because drizzle uses {mode: 'timestamp'} -> integer seconds).
  const raw = new Database(DB_PATH);
  raw.exec('PRAGMA foreign_keys = ON;');
  const now = Math.floor(Date.now() / 1000);

  raw
    .prepare(
      'INSERT INTO connections (id, provider_id, provider_name, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run('conn1', 'manual-test', 'Test', now, now + 86400, 'active');

  raw
    .prepare(
      'INSERT INTO accounts (id, connection_id, account_type, display_name, currency, is_manual) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run('acct1', 'conn1', 'TRANSACTION', 'Test Account', 'GBP', 1);

  const seedTxn = raw.prepare(
    'INSERT INTO transactions (id, account_id, timestamp, amount, currency, description, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  seedTxn.run(
    'tx1',
    'acct1',
    Math.floor(Date.UTC(2026, 3, 15) / 1000),
    -12.5,
    'GBP',
    'TESCO, STORES',
    'Groceries',
    now,
    now,
  );
  seedTxn.run(
    'tx2',
    'acct1',
    Math.floor(Date.UTC(2026, 3, 16) / 1000),
    25,
    'GBP',
    'REFUND "FROM" SHOP',
    'Income',
    now,
    now,
  );
  seedTxn.run(
    'tx3',
    'acct1',
    Math.floor(Date.UTC(2026, 4, 1) / 1000),
    -5,
    'GBP',
    'OUT OF RANGE',
    'Other',
    now,
    now,
  );
  raw.close();
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function subprocessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.HOME = tmp;
  env.NO_COLOR = '1';
  env.NODE_ENV = 'production';
  return env;
}

function runExport(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const res = Bun.spawnSync({
    cmd: ['bun', 'run', join(projectRoot, 'src', 'cli.ts'), 'export', ...args],
    cwd: projectRoot,
    env: subprocessEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    stdout: res.stdout.toString(),
    stderr: res.stderr.toString(),
    exitCode: res.exitCode ?? 0,
  };
}

test('export CSV: round-trips seeded transactions, escaping quotes/commas correctly', async () => {
  const { stdout, stderr, exitCode } = runExport(['--format', 'csv']);
  if (exitCode !== 0) throw new Error(`export failed: ${stderr}`);
  if (stdout.trim().length === 0) throw new Error(`empty stdout. stderr=${stderr}`);

  const { parseCsv } = await import('../../src/services/importers');
  const rows = parseCsv(stdout);
  expect(rows.length).toBeGreaterThanOrEqual(4); // header + 3 rows

  const header = rows[0] ?? [];
  expect(header).toContain('id');
  expect(header).toContain('amount');
  expect(header).toContain('description');
  expect(header).toContain('category');
  expect(header).toContain('source');

  const dataRows = rows.slice(1);
  const idIdx = header.indexOf('id');
  const descIdx = header.indexOf('description');
  const amtIdx = header.indexOf('amount');
  const catIdx = header.indexOf('category');
  const srcIdx = header.indexOf('source');

  const tx1 = dataRows.find((r) => r[idIdx] === 'tx1');
  const tx2 = dataRows.find((r) => r[idIdx] === 'tx2');
  expect(tx1?.[descIdx]).toBe('TESCO, STORES');
  expect(tx1?.[amtIdx]).toBe('-12.5');
  expect(tx1?.[catIdx]).toBe('Groceries');
  expect(tx1?.[srcIdx]).toBe('csv');

  expect(tx2?.[descIdx]).toBe('REFUND "FROM" SHOP');
  expect(tx2?.[amtIdx]).toBe('25');
});

test('export CSV --since/--until filters by date range', async () => {
  const { stdout, stderr, exitCode } = runExport([
    '--format',
    'csv',
    '--since',
    '2026-04-01',
    '--until',
    '2026-04-30',
  ]);
  if (exitCode !== 0) throw new Error(`export failed: ${stderr}`);
  const { parseCsv } = await import('../../src/services/importers');
  const rows = parseCsv(stdout);
  // header + 2 in-range (tx1, tx2). tx3 is May 1 -> excluded.
  expect(rows.length).toBe(3);
});

test('export JSON outputs a parseable array', async () => {
  const { stdout, stderr, exitCode } = runExport(['--format', 'json']);
  if (exitCode !== 0) throw new Error(`export failed: ${stderr}`);
  const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed.length).toBeGreaterThanOrEqual(3);
  expect(parsed[0]).toHaveProperty('id');
  expect(parsed[0]).toHaveProperty('source');
});
