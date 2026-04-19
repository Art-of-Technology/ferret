// Budget query helpers used by `ferret budget`.
//
// Spending math:
//   - `transactions.amount` is signed: negative = outflow (per schema).
//   - "Spent" for a budget over a window = SUM(ABS(amount)) WHERE amount < 0
//     AND category matches AND timestamp falls in the window.
//
// All month windows are computed in UTC to avoid local-DST drift. We don't
// rely on src/lib/dates.ts here (Phase 3 owns it and is in flight); the
// helpers below are intentionally minimal and local.

import { randomUUID } from 'node:crypto';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { loadConfig } from '../../lib/config';
import { ValidationError } from '../../lib/errors';
import type { Budget } from '../../types/domain';
import { getDb } from '../client';
import { budgets, categories, transactions } from '../schema';

export interface BudgetWithProgress {
  category: string;
  monthlyAmount: number;
  currency: string;
  spent: number;
  percent: number;
  projected: number;
  daysElapsed: number;
  totalDaysInMonth: number;
}

export interface MonthlyBudgetRow {
  category: string;
  monthlyAmount: number;
  currency: string;
  spent: number;
  percent: number;
}

export interface MonthlyBudgetView {
  year: number;
  month: number; // 1-12
  label: string; // e.g. "April 2026"
  rows: MonthlyBudgetRow[];
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function startOfMonthUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

function startOfNextMonthUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

function daysInMonthUTC(d: Date): number {
  // Day 0 of next month = last day of this month.
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

// Exported so the command layer can reuse the same month formatting
// without duplicating the MONTH_NAMES array.
export function monthLabel(d: Date): string {
  const name = MONTH_NAMES[d.getUTCMonth()] ?? '';
  return `${name} ${d.getUTCFullYear()}`;
}

// SQL: SUM of absolute outflow grouped by category over [from, to).
// Returns a Map keyed by category for O(1) lookup. The COALESCE on the
// aggregate guarantees a non-null number at runtime, so the column is typed
// `sql<number>` (not `number | null`) to match reality.
function sumOutflowByCategory(from: Date, to: Date): Map<string, number> {
  const { db } = getDb();
  const rows = db
    .select({
      category: transactions.category,
      total: sql<number>`COALESCE(SUM(ABS(${transactions.amount})), 0)`,
    })
    .from(transactions)
    .where(
      and(
        sql`${transactions.amount} < 0`,
        gte(transactions.timestamp, from),
        lt(transactions.timestamp, to),
      ),
    )
    .groupBy(transactions.category)
    .all();
  const map = new Map<string, number>();
  for (const r of rows) {
    if (r.category == null) continue;
    map.set(r.category, typeof r.total === 'number' ? r.total : 0);
  }
  return map;
}

// SQL: SUM of absolute outflow grouped by (category, year-month) across the
// supplied window [from, to). Returns a nested map: yearMonthKey -> category ->
// spent. yearMonthKey is "YYYY-MM" computed in UTC to mirror the JS month math.
function sumOutflowByCategoryAndMonth(from: Date, to: Date): Map<string, Map<string, number>> {
  const { db } = getDb();
  // SQLite stores timestamps as unix seconds (integer mode 'timestamp'); use
  // strftime over datetime(unixepoch) to bucket by UTC year-month.
  const rows = db
    .select({
      category: transactions.category,
      yearMonth: sql<string>`strftime('%Y-%m', datetime(${transactions.timestamp}, 'unixepoch'))`,
      total: sql<number>`COALESCE(SUM(ABS(${transactions.amount})), 0)`,
    })
    .from(transactions)
    .where(
      and(
        sql`${transactions.amount} < 0`,
        gte(transactions.timestamp, from),
        lt(transactions.timestamp, to),
      ),
    )
    .groupBy(
      sql`strftime('%Y-%m', datetime(${transactions.timestamp}, 'unixepoch'))`,
      transactions.category,
    )
    .all();
  const out = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (r.category == null || r.yearMonth == null) continue;
    let inner = out.get(r.yearMonth);
    if (!inner) {
      inner = new Map<string, number>();
      out.set(r.yearMonth, inner);
    }
    inner.set(r.category, typeof r.total === 'number' ? r.total : 0);
  }
  return out;
}

function yearMonthKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return `${y}-${m < 10 ? `0${m}` : m}`;
}

export function setBudget(category: string, monthlyAmount: number, currency: string): Budget {
  if (!Number.isFinite(monthlyAmount) || monthlyAmount <= 0) {
    throw new ValidationError(`Budget amount must be a positive number, got: ${monthlyAmount}`);
  }
  if (!category || !category.trim()) {
    throw new ValidationError('Category name is required');
  }

  const { db } = getDb();
  const cat = db
    .select({ name: categories.name })
    .from(categories)
    .where(eq(categories.name, category))
    .all();
  if (cat.length === 0) {
    throw new ValidationError(
      `Unknown category: "${category}". Run \`ferret tag\` to see available categories.`,
    );
  }

  const existing = db.select().from(budgets).where(eq(budgets.category, category)).all();
  const first = existing[0];
  if (first) {
    db.update(budgets).set({ monthlyAmount, currency }).where(eq(budgets.id, first.id)).run();
    return { ...first, monthlyAmount, currency };
  }

  const row: Budget = {
    id: randomUUID(),
    category,
    monthlyAmount,
    currency,
    startDate: startOfMonthUTC(new Date()),
    endDate: null,
  };
  db.insert(budgets).values(row).run();
  return row;
}

export function removeBudget(category: string): boolean {
  const { db } = getDb();
  const existing = db.select().from(budgets).where(eq(budgets.category, category)).all();
  if (existing.length === 0) return false;
  db.delete(budgets).where(eq(budgets.category, category)).run();
  return true;
}

export function getCurrentMonthBudgets(now: Date = new Date()): BudgetWithProgress[] {
  const { db } = getDb();
  const all = db.select().from(budgets).all();

  const monthStart = startOfMonthUTC(now);
  const monthEnd = startOfNextMonthUTC(now);
  const totalDays = daysInMonthUTC(now);
  // Day-of-month treated as elapsed days (current day counts as in-progress).
  // Clamp to [1, totalDays] so the projection math never divides by zero.
  const daysElapsed = Math.max(1, Math.min(totalDays, now.getUTCDate()));

  // Single grouped query covers every budget category at once (was N+1).
  const spentByCategory = sumOutflowByCategory(monthStart, monthEnd);

  const out: BudgetWithProgress[] = [];
  for (const b of all) {
    const spent = spentByCategory.get(b.category) ?? 0;
    const percent = b.monthlyAmount > 0 ? (spent / b.monthlyAmount) * 100 : 0;
    const projected = (spent / daysElapsed) * totalDays;
    out.push({
      category: b.category,
      monthlyAmount: b.monthlyAmount,
      currency: b.currency,
      spent,
      percent,
      projected,
      daysElapsed,
      totalDaysInMonth: totalDays,
    });
  }
  return out;
}

export function getHistoricalBudgets(months: number, now: Date = new Date()): MonthlyBudgetView[] {
  if (!Number.isFinite(months) || months <= 0) {
    throw new ValidationError(`months must be a positive integer, got: ${months}`);
  }
  const { db } = getDb();
  const all = db.select().from(budgets).all();

  // Bound the query window once for the whole history span, then pivot in JS.
  // Was: months * budgets COUNT separate SUM queries.
  const oldestRef = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  const windowStart = startOfMonthUTC(oldestRef);
  const windowEnd = startOfNextMonthUTC(now);
  const spentByMonth = sumOutflowByCategoryAndMonth(windowStart, windowEnd);

  const result: MonthlyBudgetView[] = [];
  // Walk from oldest to newest so output reads chronologically.
  for (let offset = months - 1; offset >= 0; offset--) {
    const ref = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    const monthMap = spentByMonth.get(yearMonthKey(ref));
    const rows: MonthlyBudgetRow[] = [];
    for (const b of all) {
      const spent = monthMap?.get(b.category) ?? 0;
      const percent = b.monthlyAmount > 0 ? (spent / b.monthlyAmount) * 100 : 0;
      rows.push({
        category: b.category,
        monthlyAmount: b.monthlyAmount,
        currency: b.currency,
        spent,
        percent,
      });
    }
    result.push({
      year: ref.getUTCFullYear(),
      month: ref.getUTCMonth() + 1,
      label: monthLabel(ref),
      rows,
    });
  }
  return result;
}

export function exportBudgets(): Budget[] {
  const { db } = getDb();
  return db.select().from(budgets).all();
}

// Convenience accessor for the configured currency. Kept here so the command
// layer doesn't have to thread it through.
export function defaultCurrency(): string {
  try {
    return loadConfig().currency;
  } catch {
    return 'GBP';
  }
}
