// Query helpers for `ferret sync`.
//
// All writes that span multiple rows of related state (account row + balance,
// transaction inserts) should be invoked from within a `db.transaction(...)`
// block at the orchestration layer (services/sync.ts) so a crash mid-account
// leaves the DB consistent per PRD §11.2.
//
// Per PRD §4.2 deduplication is by `provider_transaction_id` — we use SQLite's
// `INSERT OR IGNORE` (via Drizzle's `onConflictDoNothing`) keyed on the
// transactions PK, which we set to the provider transaction id.

import { randomUUID } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import type { Account, Connection, NewSyncLogEntry, NewTransaction } from '../../types/domain';
import { db as defaultDb } from '../client';
import type * as schema from '../schema';
import { accounts, connections, syncLog, transactions } from '../schema';

/** Multi-row INSERT chunk size — matches importers/index.ts. */
const INSERT_CHUNK_SIZE = 500;

type Db = BunSQLiteDatabase<typeof schema>;

/** All connections currently in `active` status. */
export function listActiveConnections(db: Db = defaultDb): Connection[] {
  return db.select().from(connections).where(eq(connections.status, 'active')).all();
}

/** Look up a single connection by id (regardless of status). */
export function getConnection(connectionId: string, db: Db = defaultDb): Connection | null {
  const rows = db.select().from(connections).where(eq(connections.id, connectionId)).all();
  return rows[0] ?? null;
}

/** Every account row that belongs to the given connection. */
export function listAccountsForConnection(connectionId: string, db: Db = defaultDb): Account[] {
  return db.select().from(accounts).where(eq(accounts.connectionId, connectionId)).all();
}

export interface UpsertAccountInput {
  id: string;
  connectionId: string;
  accountType: string;
  displayName: string;
  iban?: string | null;
  sortCode?: string | null;
  accountNumber?: string | null;
  currency: string;
  balanceAvailable?: number | null;
  balanceCurrent?: number | null;
  balanceUpdatedAt?: Date | null;
}

/**
 * Insert an account if missing, otherwise update mutable fields (display name,
 * balance, account-number metadata). Used by the sync orchestrator both for
 * newly discovered accounts and for refreshing balances on a known account.
 *
 * Never overwrites `is_manual` — manual accounts are owned by the import
 * pipeline and the bank-side TrueLayer surface should never touch them. We
 * achieve this by simply not listing `is_manual` in the conflict-update set;
 * the existing value is preserved.
 *
 * Atomic via `INSERT ... ON CONFLICT(id) DO UPDATE`. Avoids the TOCTOU window
 * a SELECT-then-INSERT-or-UPDATE pair would have if two writers raced on the
 * same account id.
 */
export function upsertAccount(input: UpsertAccountInput, db: Db = defaultDb): void {
  // Build the UPDATE-clause incrementally so callers can omit optional fields
  // (undefined ≠ explicit null) and have the existing value preserved on
  // conflict instead of being clobbered with NULL.
  const updates: Partial<Account> = {
    displayName: input.displayName,
    accountType: input.accountType,
    currency: input.currency,
  };
  if (input.iban !== undefined) updates.iban = input.iban;
  if (input.sortCode !== undefined) updates.sortCode = input.sortCode;
  if (input.accountNumber !== undefined) updates.accountNumber = input.accountNumber;
  if (input.balanceAvailable !== undefined) updates.balanceAvailable = input.balanceAvailable;
  if (input.balanceCurrent !== undefined) updates.balanceCurrent = input.balanceCurrent;
  if (input.balanceUpdatedAt !== undefined) updates.balanceUpdatedAt = input.balanceUpdatedAt;

  db.insert(accounts)
    .values({
      id: input.id,
      connectionId: input.connectionId,
      accountType: input.accountType,
      displayName: input.displayName,
      iban: input.iban ?? null,
      sortCode: input.sortCode ?? null,
      accountNumber: input.accountNumber ?? null,
      currency: input.currency,
      balanceAvailable: input.balanceAvailable ?? null,
      balanceCurrent: input.balanceCurrent ?? null,
      balanceUpdatedAt: input.balanceUpdatedAt ?? null,
      isManual: false,
    })
    .onConflictDoUpdate({ target: accounts.id, set: updates })
    .run();
}

/**
 * Update only the balance fields on an account. Cheaper than `upsertAccount`
 * when we already know the row exists (typical case during sync).
 */
export function updateAccountBalance(
  accountId: string,
  balance: { available: number | null; current: number | null; updatedAt: Date },
  db: Db = defaultDb,
): void {
  db.update(accounts)
    .set({
      balanceAvailable: balance.available,
      balanceCurrent: balance.current,
      balanceUpdatedAt: balance.updatedAt,
    })
    .where(eq(accounts.id, accountId))
    .run();
}

export interface BulkInsertResult {
  /** Rows attempted to insert (after caller-side deduplication). */
  attempted: number;
  /** Rows actually written (i.e. not ignored by ON CONFLICT). */
  inserted: number;
}

/**
 * Bulk-insert transactions with `INSERT OR IGNORE` semantics keyed on the PK.
 *
 * The caller is expected to set `id = provider_transaction_id` (or the hash
 * fallback used by CSV imports) so the conflict path catches re-runs of the
 * same data without raising. Returns counts so the orchestrator can report
 * "N new" accurately.
 *
 * We compute `inserted` by reading the rowcount delta around the chunk: SQLite
 * doesn't surface per-statement insert counts when ON CONFLICT IGNORE skips
 * rows, so we compare COUNT(*) of the affected ids before and after the
 * statement. Cheap because the slice is bounded by `INSERT_CHUNK_SIZE`.
 */
export function bulkInsertTransactions(
  rows: NewTransaction[],
  db: Db = defaultDb,
): BulkInsertResult {
  if (rows.length === 0) return { attempted: 0, inserted: 0 };

  let inserted = 0;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + INSERT_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const ids = chunk.map((r) => r.id);
    // Use Drizzle's onConflictDoNothing on the PK — equivalent to INSERT OR IGNORE.
    const existing = db
      .select({ count: sql<number>`COUNT(*)` })
      .from(transactions)
      .where(sql`${transactions.id} IN ${ids}`)
      .all();
    const before = (existing[0]?.count ?? 0) as number;
    db.insert(transactions).values(chunk).onConflictDoNothing({ target: transactions.id }).run();
    const after = db
      .select({ count: sql<number>`COUNT(*)` })
      .from(transactions)
      .where(sql`${transactions.id} IN ${ids}`)
      .all();
    const afterCount = (after[0]?.count ?? 0) as number;
    inserted += Math.max(0, afterCount - before);
  }
  return { attempted: rows.length, inserted };
}

/**
 * Update a transaction row's mutable fields when we observe a re-issued copy
 * during sync. The provider may flip a transaction from pending → settled or
 * adjust an amount; mirror those changes without churning create timestamps.
 */
export interface UpdateTransactionInput {
  id: string;
  amount?: number;
  description?: string;
  merchantName?: string | null;
  transactionType?: string | null;
  isPending?: boolean;
  runningBalance?: number | null;
  metadata?: unknown;
}

export function updateTransaction(input: UpdateTransactionInput, db: Db = defaultDb): boolean {
  const existing = db.select().from(transactions).where(eq(transactions.id, input.id)).all();
  if (existing.length === 0) return false;
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.amount !== undefined) set.amount = input.amount;
  if (input.description !== undefined) set.description = input.description;
  if (input.merchantName !== undefined) set.merchantName = input.merchantName;
  if (input.transactionType !== undefined) set.transactionType = input.transactionType;
  if (input.isPending !== undefined) set.isPending = input.isPending;
  if (input.runningBalance !== undefined) set.runningBalance = input.runningBalance;
  if (input.metadata !== undefined) set.metadata = input.metadata;
  db.update(transactions).set(set).where(eq(transactions.id, input.id)).run();
  return true;
}

/** Stamp the connection's `last_synced_at`. Called once per connection on success / partial. */
export function markConnectionLastSynced(
  connectionId: string,
  when: Date,
  db: Db = defaultDb,
): void {
  db.update(connections).set({ lastSyncedAt: when }).where(eq(connections.id, connectionId)).run();
}

/**
 * Update the connection's status. Used to flag `expired` / `revoked` /
 * `needs_reauth` after the TrueLayer client surfaces a terminal auth failure.
 *
 * `reason` is informational — the schema doesn't carry a column for it, so we
 * thread it through the next sync_log entry instead. Kept on the signature so
 * the orchestration layer doesn't have to reach for separate helpers.
 */
export function markConnectionStatus(
  connectionId: string,
  status: 'active' | 'expired' | 'revoked' | 'needs_reauth',
  _reason?: string,
  db: Db = defaultDb,
): void {
  db.update(connections).set({ status }).where(eq(connections.id, connectionId)).run();
}

export interface SyncLogInput {
  connectionId: string;
  startedAt: Date;
  completedAt: Date;
  status: 'success' | 'failed' | 'partial';
  transactionsAdded?: number;
  transactionsUpdated?: number;
  errorMessage?: string | null;
}

/** Append a sync_log row. One row per connection per sync invocation. */
export function recordSyncLog(entry: SyncLogInput, db: Db = defaultDb): void {
  const row: NewSyncLogEntry = {
    id: randomUUID(),
    connectionId: entry.connectionId,
    startedAt: entry.startedAt,
    completedAt: entry.completedAt,
    status: entry.status,
    transactionsAdded: entry.transactionsAdded ?? 0,
    transactionsUpdated: entry.transactionsUpdated ?? 0,
    errorMessage: entry.errorMessage ?? null,
  };
  db.insert(syncLog).values(row).run();
}

/** Look up an account by id (used when reconciling pre-existing rows). */
export function getAccount(accountId: string, db: Db = defaultDb): Account | null {
  const rows = db.select().from(accounts).where(eq(accounts.id, accountId)).all();
  return rows[0] ?? null;
}

/**
 * Compute the per-account "since" cursor for sync. If the account already
 * carries transactions, we start from the latest stored timestamp; otherwise
 * we fall back to the connection's `last_synced_at` if any.
 *
 * Returns null when neither signal is available — caller then falls back to
 * the configured default history window.
 *
 * Implementation note: we deliberately select the column directly (via
 * orderBy + limit 1) rather than `MAX(timestamp)` wrapped in raw SQL. Drizzle
 * only applies the `mode: 'timestamp'` Date<->seconds codec when it sees the
 * column reference; raw `sql<number>` aggregates bypass it and return the
 * integer-second value, which is a footgun (off by 1000x if mishandled).
 * Using the column reference keeps unit handling consistent with every other
 * read in this file.
 */
export function getLatestTransactionTimestamp(accountId: string, db: Db = defaultDb): Date | null {
  const rows = db
    .select({ timestamp: transactions.timestamp })
    .from(transactions)
    .where(eq(transactions.accountId, accountId))
    .orderBy(desc(transactions.timestamp))
    .limit(1)
    .all();
  return rows[0]?.timestamp ?? null;
}
