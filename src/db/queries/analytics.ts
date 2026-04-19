// Analytics query helpers backing the four `ferret ask` tools (PRD §8.2).
//
// All four functions are pure database reads; they never write. The raw
// `runReadOnlyQuery` is the SQL-validated escape hatch Claude can invoke
// when the higher-level helpers can't express the question.
//
// Cost-control: `runReadOnlyQuery` caps the result row count at the
// configured `claude.max_context_transactions` (default 500) so a runaway
// `SELECT * FROM transactions` can't blow the per-call token budget.

import type { Database } from 'bun:sqlite';
import { and, asc, gte, isNotNull, lte, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { loadConfig } from '../../lib/config';
import { ValidationError } from '../../lib/errors';
import { validateReadOnlySql } from '../../lib/sql-validator';
import type { Account } from '../../types/domain';
import { db as defaultDb, getDb } from '../client';
import type * as schema from '../schema';
import { accounts, transactions } from '../schema';

type Db = BunSQLiteDatabase<typeof schema>;

/** ±10 % tolerance for the recurring-payment heuristic in `detectRecurringPayments`. */
const RECURRING_AMOUNT_TOLERANCE = 0.1;

/** Hard ceiling on rows returned by `runReadOnlyQuery`. Falls back when config is unreadable. */
export const DEFAULT_MAX_ROWS = 500;

export interface CategorySummaryRow {
  category: string;
  total: number;
  currency: string;
}

export interface DateRange {
  /** Inclusive lower bound (UTC). */
  from: Date;
  /** Inclusive upper bound (UTC). */
  to: Date;
}

/**
 * Sum of `transactions.amount` per category in a date range. Includes
 * inflows (positive) and outflows (negative) without sign collapsing —
 * Claude is responsible for deciding whether the user asked for spend
 * vs net. Skips rows with null category to keep buckets clean.
 *
 * Currency is preserved per row (multi-currency accounts e.g. Revolut
 * legitimately produce more than one bucket per category name).
 */
export function getCategorySummary(range: DateRange, db: Db = defaultDb): CategorySummaryRow[] {
  if (!(range.from instanceof Date) || Number.isNaN(range.from.getTime())) {
    throw new ValidationError('getCategorySummary: from must be a valid Date');
  }
  if (!(range.to instanceof Date) || Number.isNaN(range.to.getTime())) {
    throw new ValidationError('getCategorySummary: to must be a valid Date');
  }
  if (range.to.getTime() < range.from.getTime()) {
    throw new ValidationError('getCategorySummary: to must be >= from');
  }

  const rows = db
    .select({
      category: transactions.category,
      currency: transactions.currency,
      total: sql<number>`SUM(${transactions.amount})`,
    })
    .from(transactions)
    .where(
      and(
        gte(transactions.timestamp, range.from),
        lte(transactions.timestamp, range.to),
        isNotNull(transactions.category),
      ),
    )
    .groupBy(transactions.category, transactions.currency)
    .orderBy(asc(transactions.category))
    .all();

  return rows
    .filter((r): r is { category: string; currency: string; total: number } => r.category !== null)
    .map((r) => ({
      category: r.category,
      total: Number(r.total ?? 0),
      currency: r.currency,
    }));
}

export interface RecurringPaymentRow {
  /** Normalized merchant name (whatever the bank surfaced). */
  merchant: string;
  /** Median absolute monthly amount across the matched occurrences. */
  monthlyAmount: number;
  /** Number of distinct months the merchant appeared. */
  occurrences: number;
}

export interface RecurringOptions {
  /** Minimum number of distinct months before a series qualifies. Default 3. */
  minOccurrences?: number;
}

/**
 * Heuristic recurring-payment detector. A merchant qualifies when:
 *   - it appears in at least `minOccurrences` distinct calendar months
 *     (so weekly Tesco shops aren't double-counted within a month),
 *   - all qualifying occurrences sit within ±10 % of the series median
 *     (so an annual £100 charge doesn't get bucketed with monthly £10s).
 *
 * Returns one row per qualifying merchant, sorted by occurrence count
 * descending so the busiest subscriptions appear first.
 *
 * Outflow-only: positive-amount rows (refunds, salary) are ignored — a
 * monthly salary credit is "recurring" but isn't useful for the
 * subscription-discovery use case Claude wires this up for.
 */
export function detectRecurringPayments(
  opts: RecurringOptions = {},
  db: Db = defaultDb,
): RecurringPaymentRow[] {
  const minOccurrences = Math.max(2, Math.floor(opts.minOccurrences ?? 3));

  // Pull every outflow with a non-null merchant. The dataset is bounded by
  // the user's own transaction history so a full scan is acceptable; a
  // multi-CTE SQL approach would be hostile to readability for limited
  // gain.
  const rows = db
    .select({
      merchant: transactions.merchantName,
      amount: transactions.amount,
      timestamp: transactions.timestamp,
    })
    .from(transactions)
    .where(and(isNotNull(transactions.merchantName), sql`${transactions.amount} < 0`))
    .all();

  type Sample = { absAmount: number; monthKey: string };
  const byMerchant = new Map<string, Sample[]>();
  for (const r of rows) {
    if (!r.merchant) continue;
    const ts =
      r.timestamp instanceof Date ? r.timestamp : new Date(r.timestamp as unknown as number);
    if (Number.isNaN(ts.getTime())) continue;
    const monthKey = `${ts.getUTCFullYear()}-${String(ts.getUTCMonth() + 1).padStart(2, '0')}`;
    const existing = byMerchant.get(r.merchant);
    const sample: Sample = { absAmount: Math.abs(r.amount), monthKey };
    if (existing) existing.push(sample);
    else byMerchant.set(r.merchant, [sample]);
  }

  const out: RecurringPaymentRow[] = [];
  for (const [merchant, samples] of byMerchant) {
    const distinctMonths = new Set(samples.map((s) => s.monthKey));
    if (distinctMonths.size < minOccurrences) continue;

    // Median is robust to outliers (a one-off promo charge from the same
    // merchant won't drag the centre off).
    const sorted = [...samples].map((s) => s.absAmount).sort((a, b) => a - b);
    const median = medianOf(sorted);
    if (median === 0) continue;

    // Filter the samples to those within ±10 % of the median, then re-check
    // the distinct-month count. This is what excludes the
    // "many small + one large" amazon-style merchant from being mis-detected.
    const within = samples.filter(
      (s) => Math.abs(s.absAmount - median) / median <= RECURRING_AMOUNT_TOLERANCE,
    );
    const monthsWithin = new Set(within.map((s) => s.monthKey));
    if (monthsWithin.size < minOccurrences) continue;

    out.push({
      merchant,
      monthlyAmount: roundTo(median, 2),
      occurrences: monthsWithin.size,
    });
  }

  out.sort((a, b) => {
    if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
    return b.monthlyAmount - a.monthlyAmount;
  });
  return out;
}

/**
 * Lightweight account list for the `get_account_list` tool. Returns only
 * the fields Claude can sensibly use in answers; balance metadata stays
 * on the row so the model can phrase "your current balance is …".
 */
export function getAccountList(db: Db = defaultDb): Account[] {
  return db.select().from(accounts).orderBy(asc(accounts.displayName)).all();
}

export interface RunReadOnlyQueryOptions {
  /** Override the per-query row cap (default = config `claude.max_context_transactions`). */
  maxRows?: number;
  /** Override the underlying bun:sqlite handle (tests). */
  raw?: Database;
}

export interface RunReadOnlyQueryResult {
  /** Capped row payload (length <= maxRows). */
  rows: Record<string, unknown>[];
  /** True when the database had at least one row beyond the cap. */
  truncated: boolean;
}

/**
 * Execute a Claude-supplied SQL string. The query is validated as
 * SELECT-only (PRD §4.5 safety) before it ever reaches `bun:sqlite`.
 *
 * Result row count is capped at `max_context_transactions` from config
 * (default 500) so a `SELECT * FROM transactions` against a 100k-row DB
 * doesn't blow Claude's per-call token budget. The cap is pushed down
 * into SQLite via a `LIMIT cap+1` wrapper so a pathological query
 * (e.g. `SELECT * FROM transactions` against 1M rows) doesn't
 * materialize the full result set in memory before truncation. We
 * always wrap rather than appending, because the user's SELECT may
 * already carry its own LIMIT/ORDER BY whose semantics we'd corrupt by
 * slapping another LIMIT on the end. `cap + 1` lets us detect when the
 * cap was hit so the caller can warn.
 *
 * Backward-compat: callers that ignore the result shape still get
 * `Record<string, unknown>[]` via `runReadOnlyQuery`. New callers that
 * need the truncation flag use `runReadOnlyQueryWithMeta`.
 *
 * Parameters are positional `?` bindings forwarded straight to bun:sqlite.
 */
export function runReadOnlyQueryWithMeta(
  sqlText: string,
  params: unknown[] = [],
  opts: RunReadOnlyQueryOptions = {},
): RunReadOnlyQueryResult {
  validateReadOnlySql(sqlText);
  const cap = resolveRowCap(opts.maxRows);
  const raw = opts.raw ?? getDb().raw;
  const wrapped = wrapWithRowCap(sqlText, cap);
  const stmt = raw.prepare(wrapped);
  // bun:sqlite's `.all(...params)` accepts a spread or a single array
  // positional. We always spread so the caller's array shape is preserved.
  // biome-ignore lint/suspicious/noExplicitAny: bun:sqlite accepts heterogenous bind params.
  const rows = stmt.all(...(params as any[])) as unknown as Record<string, unknown>[];
  if (rows.length > cap) {
    return { rows: rows.slice(0, cap), truncated: true };
  }
  return { rows, truncated: false };
}

/**
 * Backward-compatible wrapper around `runReadOnlyQueryWithMeta`. Returns
 * just the (capped) row array without the truncation flag.
 */
export function runReadOnlyQuery(
  sqlText: string,
  params: unknown[] = [],
  opts: RunReadOnlyQueryOptions = {},
): Record<string, unknown>[] {
  return runReadOnlyQueryWithMeta(sqlText, params, opts).rows;
}

/**
 * Wrap a user SELECT in a subquery with `LIMIT cap+1` so SQLite stops
 * fetching once we have enough rows to detect overflow. We strip a
 * single trailing `;` because nesting `(SELECT …;)` is a parse error in
 * SQLite. The validator has already guaranteed the input is a single
 * SELECT statement, so this stays safe.
 */
function wrapWithRowCap(sqlText: string, cap: number): string {
  const trimmed = sqlText.trim().replace(/;\s*$/, '');
  return `SELECT * FROM (${trimmed}) LIMIT ${cap + 1}`;
}

function resolveRowCap(override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  try {
    const cfg = loadConfig();
    const fromCfg = cfg.claude.max_context_transactions;
    if (Number.isFinite(fromCfg) && fromCfg > 0) return Math.floor(fromCfg);
  } catch {
    // Fall through to default — we'd rather cap and return data than
    // refuse the query because the config file is unreadable.
  }
  return DEFAULT_MAX_ROWS;
}

function medianOf(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const a = sorted[mid - 1];
    const b = sorted[mid];
    if (a === undefined || b === undefined) return 0;
    return (a + b) / 2;
  }
  return sorted[mid] ?? 0;
}

function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
