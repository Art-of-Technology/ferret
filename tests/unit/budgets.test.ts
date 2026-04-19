import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'ferret-budgets-'));
process.env.HOME = tmp;

// Use a fixed "now" so window math is deterministic. Choose mid-month so
// projection is non-trivial. April 2026, day 19/30, 63% elapsed.
const NOW = new Date(Date.UTC(2026, 3, 19, 12, 0, 0));

// Helper: insert a transaction directly via raw sqlite. Amount negative = outflow.
async function seedTxn(
  id: string,
  category: string,
  amount: number,
  daysAgoFromNow: number,
): Promise<void> {
  const { getDb } = await import('../../src/db/client');
  const { raw } = getDb();
  const ts = Math.floor((NOW.getTime() - daysAgoFromNow * 86_400_000) / 1000);
  raw
    .prepare(
      `INSERT OR IGNORE INTO transactions
       (id, account_id, timestamp, amount, currency, description, merchant_name,
        transaction_type, category, category_source, provider_category, running_balance,
        is_pending, metadata, created_at, updated_at)
       VALUES (?, 'test-acct', ?, ?, 'GBP', ?, ?, ?, ?, 'manual', NULL, NULL, 0, NULL, ?, ?)`,
    )
    .run(id, ts, amount, `seed ${id}`, category, amount < 0 ? 'DEBIT' : 'CREDIT', category, ts, ts);
}

beforeAll(async () => {
  // Boot DB + seed categories via init.
  const initMod = await import('../../src/commands/init');
  const cmd = initMod.default as { run: (ctx?: unknown) => unknown };
  await cmd.run();

  // Need a connection + account for the FK on transactions.
  const { getDb } = await import('../../src/db/client');
  const { raw } = getDb();
  raw
    .prepare(
      `INSERT OR IGNORE INTO connections
       (id, provider_id, provider_name, created_at, expires_at, status, last_synced_at)
       VALUES ('test-conn', 'manual', 'Test', ?, ?, 'active', ?)`,
    )
    .run(
      Math.floor(NOW.getTime() / 1000),
      Math.floor((NOW.getTime() + 90 * 86_400_000) / 1000),
      Math.floor(NOW.getTime() / 1000),
    );
  raw
    .prepare(
      `INSERT OR IGNORE INTO accounts
       (id, connection_id, account_type, display_name, currency, balance_available,
        balance_current, balance_updated_at, is_manual)
       VALUES ('test-acct', 'test-conn', 'TRANSACTION', 'Test', 'GBP', 0, 0, ?, 1)`,
    )
    .run(Math.floor(NOW.getTime() / 1000));

  // Current month (April 2026): Groceries 100 + 50 = 150 outflow, plus a +20
  // refund (positive amount) that should be ignored.
  await seedTxn('cur-grc-1', 'Groceries', -100, 1);
  await seedTxn('cur-grc-2', 'Groceries', -50, 5);
  await seedTxn('cur-grc-refund', 'Groceries', 20, 2);
  // Eating Out — 80 spent, no budget set initially (we'll only budget Groceries
  // and Transport so we can verify "no row when no budget").
  await seedTxn('cur-eat-1', 'Eating Out', -80, 3);
  // Transport — 60 spent (under £180 budget set in test).
  await seedTxn('cur-trn-1', 'Transport', -60, 4);

  // Previous month (March 2026): Groceries 200 spent, Transport 30 spent.
  // Day 50 ago from Apr 19 = Feb 28; day 35 = Mar 15; day 25 = Mar 25.
  await seedTxn('prv-grc-1', 'Groceries', -200, 35);
  await seedTxn('prv-trn-1', 'Transport', -30, 25);
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test('setBudget validates amount > 0', async () => {
  const { setBudget } = await import('../../src/db/queries/budgets');
  expect(() => setBudget('Groceries', 0, 'GBP')).toThrow();
  expect(() => setBudget('Groceries', -10, 'GBP')).toThrow();
});

test('setBudget rejects unknown category', async () => {
  const { setBudget } = await import('../../src/db/queries/budgets');
  expect(() => setBudget('NotARealCategory', 100, 'GBP')).toThrow();
});

test('setBudget inserts then updates idempotently', async () => {
  const { setBudget, exportBudgets } = await import('../../src/db/queries/budgets');
  setBudget('Groceries', 200, 'GBP');
  setBudget('Transport', 180, 'GBP');
  const a = exportBudgets().find((b) => b.category === 'Groceries');
  expect(a?.monthlyAmount).toBe(200);
  // Update the same category — must not duplicate.
  setBudget('Groceries', 250, 'GBP');
  const all = exportBudgets();
  const grc = all.filter((b) => b.category === 'Groceries');
  expect(grc.length).toBe(1);
  expect(grc[0]?.monthlyAmount).toBe(250);
});

test('getCurrentMonthBudgets returns spent/percent/projected for active budgets', async () => {
  const { getCurrentMonthBudgets } = await import('../../src/db/queries/budgets');
  const view = getCurrentMonthBudgets(NOW);
  // Only categories with a budget should appear: Groceries + Transport.
  const cats = view.map((v) => v.category).sort();
  expect(cats).toEqual(['Groceries', 'Transport']);

  const grc = view.find((v) => v.category === 'Groceries');
  expect(grc).toBeDefined();
  if (!grc) return;
  // Spent = 100 + 50 = 150 (refund of +20 ignored).
  expect(grc.spent).toBeCloseTo(150, 5);
  // Percent = 150 / 250 * 100 = 60.
  expect(grc.percent).toBeCloseTo(60, 5);
  // Projected = (150 / 19) * 30 ≈ 236.84.
  expect(grc.projected).toBeCloseTo((150 / 19) * 30, 5);
  expect(grc.daysElapsed).toBe(19);
  expect(grc.totalDaysInMonth).toBe(30);

  const trn = view.find((v) => v.category === 'Transport');
  expect(trn).toBeDefined();
  if (!trn) return;
  expect(trn.spent).toBeCloseTo(60, 5);
  expect(trn.percent).toBeCloseTo((60 / 180) * 100, 5);
});

test('getHistoricalBudgets(2) returns oldest-to-newest with correct rows', async () => {
  const { getHistoricalBudgets } = await import('../../src/db/queries/budgets');
  const months = getHistoricalBudgets(2, NOW);
  expect(months.length).toBe(2);

  const [mar, apr] = months;
  expect(mar?.year).toBe(2026);
  expect(mar?.month).toBe(3);
  expect(apr?.year).toBe(2026);
  expect(apr?.month).toBe(4);

  const marGrc = mar?.rows.find((r) => r.category === 'Groceries');
  expect(marGrc?.spent).toBeCloseTo(200, 5);
  const marTrn = mar?.rows.find((r) => r.category === 'Transport');
  expect(marTrn?.spent).toBeCloseTo(30, 5);

  const aprGrc = apr?.rows.find((r) => r.category === 'Groceries');
  expect(aprGrc?.spent).toBeCloseTo(150, 5);
});

test('removeBudget returns false for unknown, true for existing', async () => {
  const { removeBudget, exportBudgets } = await import('../../src/db/queries/budgets');
  expect(removeBudget('NoSuchCategory')).toBe(false);
  expect(removeBudget('Transport')).toBe(true);
  const after = exportBudgets().map((b) => b.category);
  expect(after).not.toContain('Transport');
});
