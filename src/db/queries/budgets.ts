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

function monthLabel(d: Date): string {
  const name = MONTH_NAMES[d.getUTCMonth()] ?? '';
  return `${name} ${d.getUTCFullYear()}`;
}

// SQL: SUM of absolute outflow for a category over [from, to).
function sumOutflow(category: string, from: Date, to: Date): number {
  const { db } = getDb();
  const rows = db
    .select({
      total: sql<number | null>`COALESCE(SUM(ABS(${transactions.amount})), 0)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.category, category),
        sql`${transactions.amount} < 0`,
        gte(transactions.timestamp, from),
        lt(transactions.timestamp, to),
      ),
    )
    .all();
  const first = rows[0];
  const total = first?.total;
  return typeof total === 'number' ? total : 0;
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

  const out: BudgetWithProgress[] = [];
  for (const b of all) {
    const spent = sumOutflow(b.category, monthStart, monthEnd);
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

  const result: MonthlyBudgetView[] = [];
  // Walk from oldest to newest so output reads chronologically.
  for (let offset = months - 1; offset >= 0; offset--) {
    const ref = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    const monthStart = startOfMonthUTC(ref);
    const monthEnd = startOfNextMonthUTC(ref);
    const rows: MonthlyBudgetRow[] = [];
    for (const b of all) {
      const spent = sumOutflow(b.category, monthStart, monthEnd);
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
