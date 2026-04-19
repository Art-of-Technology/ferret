// Query helpers for the categorization pipeline (PRD §4.4).
//
// Notes:
//   - `category_source` values: 'manual' | 'rule' | 'cache' | 'claude'.
//   - `--retag` resets only the auto-set rows (cache + claude). Manual + rule
//     stay because the user (or their own rule) authored them; clearing those
//     would silently overwrite intent.
//   - All bulk writes wrap in `db.transaction` so a partial failure doesn't
//     leave a half-categorized DB.

import { asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { db as defaultDb } from '../client';
import { categories, merchantCache, rules, transactions } from '../schema';
import type * as schema from '../schema';

export interface UncategorizedTxn {
  id: string;
  accountId: string;
  description: string;
  merchantName: string | null;
  amount: number;
  currency: string;
  timestamp: Date;
}

export type Db = BunSQLiteDatabase<typeof schema>;

/**
 * Rows that have no category yet OR were marked Uncategorized previously.
 * We re-process Uncategorized rows on plain `tag` so a newly-added rule or
 * cache hit can finally classify them.
 */
export function listUncategorizedTransactions(db: Db = defaultDb): UncategorizedTxn[] {
  const rows = db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      description: transactions.description,
      merchantName: transactions.merchantName,
      amount: transactions.amount,
      currency: transactions.currency,
      timestamp: transactions.timestamp,
    })
    .from(transactions)
    .where(or(isNull(transactions.category), eq(transactions.category, 'Uncategorized')))
    .orderBy(asc(transactions.timestamp))
    .all();
  return rows as UncategorizedTxn[];
}

/**
 * Used by `--retag`: every row that wasn't manually categorised. We re-run
 * the full pipeline on these so rule changes propagate everywhere.
 */
export function listAllNonManualTransactions(db: Db = defaultDb): UncategorizedTxn[] {
  const rows = db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      description: transactions.description,
      merchantName: transactions.merchantName,
      amount: transactions.amount,
      currency: transactions.currency,
      timestamp: transactions.timestamp,
    })
    .from(transactions)
    .where(or(isNull(transactions.categorySource), sql`${transactions.categorySource} != 'manual'`))
    .orderBy(asc(transactions.timestamp))
    .all();
  return rows as UncategorizedTxn[];
}

export interface RuleRow {
  id: string;
  pattern: string;
  field: 'merchant' | 'description' | string;
  category: string;
  priority: number;
}

/**
 * Returns rules in canonical apply order: priority DESC, id ASC on tie.
 * Callers (e.g. `categorizeBatch`) rely on this and do NOT re-sort, so
 * preserve this contract if you change the query.
 */
export function getRules(db: Db = defaultDb): RuleRow[] {
  const rows = db.select().from(rules).orderBy(desc(rules.priority), asc(rules.id)).all();
  return rows.map((r) => ({
    id: r.id,
    pattern: r.pattern,
    field: r.field,
    category: r.category,
    priority: r.priority,
  }));
}

export function getNextRulePriority(db: Db = defaultDb): number {
  const row = db
    .select({ max: sql<number>`COALESCE(MAX(${rules.priority}), 0)` })
    .from(rules)
    .all();
  const first = row[0];
  return (first?.max ?? 0) + 1;
}

/** Map<normalizedMerchant, category>. Lower-case keys. */
export function loadMerchantCache(db: Db = defaultDb): Map<string, string> {
  const rows = db
    .select({ key: merchantCache.merchantNormalized, cat: merchantCache.category })
    .from(merchantCache)
    .all();
  const out = new Map<string, string>();
  for (const r of rows) out.set(r.key, r.cat);
  return out;
}

export interface MerchantCacheUpsert {
  normalized: string;
  category: string;
  confidence: number | null;
  source: 'claude' | 'manual';
}

export function upsertMerchantCacheEntry(entry: MerchantCacheUpsert, db: Db = defaultDb): void {
  // INSERT … ON CONFLICT(merchant_normalized) DO UPDATE so repeated runs
  // overwrite a stale category with the latest classification.
  const now = new Date();
  db.insert(merchantCache)
    .values({
      merchantNormalized: entry.normalized,
      category: entry.category,
      confidence: entry.confidence,
      source: entry.source,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: merchantCache.merchantNormalized,
      set: {
        category: entry.category,
        confidence: entry.confidence,
        source: entry.source,
        createdAt: now,
      },
    })
    .run();
}

export interface TxnAssignment {
  transactionId: string;
  category: string;
  source: 'manual' | 'rule' | 'cache' | 'claude';
}

/**
 * Bulk update `transactions.category` + `category_source`. Wrapped in a
 * single SQLite transaction so the file stays consistent if the run dies
 * partway through.
 */
export function applyCategoryAssignments(assignments: TxnAssignment[], db: Db = defaultDb): void {
  if (assignments.length === 0) return;
  db.transaction((tx) => {
    const now = new Date();
    for (const a of assignments) {
      tx.update(transactions)
        .set({ category: a.category, categorySource: a.source, updatedAt: now })
        .where(eq(transactions.id, a.transactionId))
        .run();
    }
  });
}

/**
 * Used by `--retag`: clear category + categorySource on every row whose
 * source was 'cache' or 'claude'. Manual + rule overrides are preserved.
 *
 * Uses `.returning({ id })` so the count and the update see the same
 * snapshot (single statement) — avoids the prior select-then-update race.
 */
export function clearAutoCategorizations(db: Db = defaultDb): number {
  const cleared = db
    .update(transactions)
    .set({ category: null, categorySource: null, updatedAt: new Date() })
    .where(inArray(transactions.categorySource, ['cache', 'claude']))
    .returning({ id: transactions.id })
    .all();
  return cleared.length;
}

export function categoryExists(name: string, db: Db = defaultDb): boolean {
  const row = db
    .select({ name: categories.name })
    .from(categories)
    .where(eq(categories.name, name))
    .all();
  return row.length > 0;
}

export function listCategoryNames(db: Db = defaultDb): string[] {
  return db
    .select({ name: categories.name })
    .from(categories)
    .all()
    .map((r) => r.name);
}

/** Look up a single transaction by id (manual override flow). */
export function getTransactionById(id: string, db: Db = defaultDb): UncategorizedTxn | null {
  const rows = db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      description: transactions.description,
      merchantName: transactions.merchantName,
      amount: transactions.amount,
      currency: transactions.currency,
      timestamp: transactions.timestamp,
    })
    .from(transactions)
    .where(eq(transactions.id, id))
    .all();
  return (rows[0] as UncategorizedTxn | undefined) ?? null;
}
