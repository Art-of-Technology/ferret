// Query builder for `ferret ls`. All filtering happens in SQL using the
// indexes declared on `transactions` (see schema.ts: txn_account_timestamp_idx,
// txn_category_idx, txn_merchant_idx) so we hit the perf target of < 200ms on
// 100k rows (PRD §11.1). We never SELECT * and filter in JS.

import { type SQL, and, asc, desc, eq, gte, like, lte, or } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { ValidationError } from '../../lib/errors';
import { db as defaultDb } from '../client';
import { accounts, transactions } from '../schema';
import type * as schema from '../schema';

export type ListSortField = 'timestamp' | 'amount' | 'merchant' | 'category';
export type ListSortDir = 'asc' | 'desc';

export interface ListFilters {
  since?: Date;
  until?: Date;
  category?: string;
  merchant?: string;
  /** Account UUID (TrueLayer id) or display name. Matched against either. */
  accountId?: string;
  /** Lower bound on |amount| (absolute value). */
  min?: number;
  /** Upper bound on |amount| (absolute value). */
  max?: number;
  direction?: 'incoming' | 'outgoing';
  limit?: number;
  sort?: { field: ListSortField; dir: ListSortDir };
}

export interface TransactionRow {
  id: string;
  accountId: string;
  accountName: string | null;
  timestamp: Date;
  amount: number;
  currency: string;
  description: string;
  merchantName: string | null;
  category: string | null;
  transactionType: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 10_000;

/**
 * Run a filtered, sorted, paged query against `transactions`. The result set is
 * a stable view (`TransactionRow[]`) joined with the parent account so callers
 * can render an account display name without a second round-trip.
 *
 * Pass a `db` instance for testing; defaults to the shared singleton.
 */
export function listTransactions(
  filters: ListFilters = {},
  db: BunSQLiteDatabase<typeof schema> = defaultDb,
): TransactionRow[] {
  const conditions: SQL[] = [];

  if (filters.since instanceof Date) {
    conditions.push(gte(transactions.timestamp, filters.since));
  }
  if (filters.until instanceof Date) {
    conditions.push(lte(transactions.timestamp, filters.until));
  }
  if (filters.category && filters.category.length > 0) {
    conditions.push(eq(transactions.category, filters.category));
  }
  if (filters.merchant && filters.merchant.length > 0) {
    // Case-insensitive substring match. SQLite's LIKE is case-insensitive for
    // ASCII by default; that's good enough for merchant names.
    const pattern = `%${escapeLike(filters.merchant)}%`;
    conditions.push(like(transactions.merchantName, pattern));
  }
  if (filters.accountId && filters.accountId.length > 0) {
    // Match against either accounts.id (UUID) or accounts.displayName.
    const accountFilter = or(
      eq(accounts.id, filters.accountId),
      eq(accounts.displayName, filters.accountId),
    );
    if (accountFilter) conditions.push(accountFilter);
  }
  if (typeof filters.min === 'number') {
    if (!Number.isFinite(filters.min) || filters.min < 0) {
      throw new ValidationError(`--min must be a non-negative number, got ${filters.min}`);
    }
    // |amount| >= min  =>  amount >= min OR amount <= -min
    const minFilter = or(
      gte(transactions.amount, filters.min),
      lte(transactions.amount, -filters.min),
    );
    if (minFilter) conditions.push(minFilter);
  }
  if (typeof filters.max === 'number') {
    if (!Number.isFinite(filters.max) || filters.max < 0) {
      throw new ValidationError(`--max must be a non-negative number, got ${filters.max}`);
    }
    // |amount| <= max  =>  amount <= max AND amount >= -max
    const maxFilter = and(
      lte(transactions.amount, filters.max),
      gte(transactions.amount, -filters.max),
    );
    if (maxFilter) conditions.push(maxFilter);
  }
  if (filters.direction === 'incoming') {
    conditions.push(gte(transactions.amount, 0));
  } else if (filters.direction === 'outgoing') {
    conditions.push(lte(transactions.amount, 0));
  }

  const sort = filters.sort ?? { field: 'timestamp' as const, dir: 'desc' as const };
  const sortColumn = resolveSortColumn(sort.field);
  const orderBy = sort.dir === 'asc' ? asc(sortColumn) : desc(sortColumn);

  const limit = clampLimit(filters.limit);

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      accountName: accounts.displayName,
      timestamp: transactions.timestamp,
      amount: transactions.amount,
      currency: transactions.currency,
      description: transactions.description,
      merchantName: transactions.merchantName,
      category: transactions.category,
      transactionType: transactions.transactionType,
    })
    .from(transactions)
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(where)
    .orderBy(orderBy)
    .limit(limit)
    .all();

  // Drizzle returns plain objects already; we only need to assert the shape.
  return rows as TransactionRow[];
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new ValidationError(`--limit must be a positive integer, got ${limit}`);
  }
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

function resolveSortColumn(field: ListSortField) {
  switch (field) {
    case 'timestamp':
      return transactions.timestamp;
    case 'amount':
      return transactions.amount;
    case 'merchant':
      return transactions.merchantName;
    case 'category':
      return transactions.category;
    default: {
      const _exhaustive: never = field;
      throw new ValidationError(`Unknown sort field: ${String(_exhaustive)}`);
    }
  }
}

function escapeLike(input: string): string {
  // We don't currently use an ESCAPE clause; strip the LIKE metacharacters
  // (% and _) so they're treated as literals in user input.
  return input.replace(/[\\%_]/g, '');
}
