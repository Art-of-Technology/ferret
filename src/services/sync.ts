// Sync orchestration. Owns the "for each connection / for each account" loop,
// per-account `db.transaction(...)` wrap (PRD §11.2), per-connection failure
// isolation (PRD §4.2), and translating TrueLayer responses into rows shaped
// for `db/queries/sync.ts`.
//
// The TrueLayer client itself owns transport-level concerns: token refresh
// (60s skew), 401 retry, 429 / 5xx backoff, AuthError on terminal auth
// failure. We treat those as opaque — surface the typed error, log it,
// continue to the next connection.

import type consola from 'consola';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { db as defaultDb } from '../db/client';
import {
  bulkInsertTransactions,
  getConnection,
  getLatestTransactionTimestamp,
  listActiveConnections,
  markConnectionLastSynced,
  markConnectionStatus,
  recordSyncLog,
  updateAccountBalance,
  updateTransaction,
  upsertAccount,
} from '../db/queries/sync';
import type * as schema from '../db/schema';
import { appendAuditEvent } from '../lib/audit';
import { loadConfig } from '../lib/config';
import { AuthError, FerretError } from '../lib/errors';
import type { Account, Connection, NewTransaction } from '../types/domain';
import type {
  TrueLayerAccount,
  TrueLayerCard,
  TrueLayerCardBalance,
  TrueLayerTransaction,
} from '../types/truelayer';
import { EndpointNotSupportedError, type TokenBundle, type TrueLayerClient } from './truelayer';

type Db = BunSQLiteDatabase<typeof schema>;

/** Hard PRD ceiling on first-sync history (24 months ≈ 730 days). */
export const MAX_HISTORY_DAYS = 730;

/** Connections expiring within this window get a yellow warning printed. */
export const EXPIRY_WARNING_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SyncOptions {
  /** Limit sync to a single connection by id. */
  connectionId?: string;
  /** Override the per-account cursor. Useful for re-syncing a window. */
  since?: Date;
  /** Fetch + report only — never write to the DB. */
  dryRun?: boolean;
  /**
   * Days of history to pull when an account has never been synced before.
   * Capped to {@link MAX_HISTORY_DAYS} per PRD §4.2. Defaults to
   * `config.sync.default_history_days`.
   */
  defaultHistoryDays?: number;
}

export interface SyncContext {
  /** Returns a TrueLayerClient bound to a specific connection's tokens. */
  clientFactory: (connection: Connection) => Promise<TrueLayerClient> | TrueLayerClient;
  db?: Db;
  /** Injectable clock — defaults to `() => new Date()`. */
  now?: () => Date;
  /** Logger sink. Defaults to consola. Tests may swap. */
  logger?: SyncLogger;
}

/**
 * Structural subset of `consola` that the orchestrator actually uses. Typing
 * it via `Pick` keeps the real `consola` instance assignable without an
 * adapter wrapper at the call site, while still letting tests pass a tiny
 * mock with just these four methods.
 */
export type SyncLogger = Pick<typeof consola, 'info' | 'warn' | 'error' | 'success'>;

export interface ConnectionSyncResult {
  connectionId: string;
  providerName: string;
  status: 'success' | 'failed' | 'partial';
  accounts: number;
  transactionsAdded: number;
  transactionsUpdated: number;
  durationMs: number;
  errorMessage?: string;
  /** Per-account breakdown (useful for the human-readable summary). */
  perAccount: AccountSyncResult[];
}

export interface AccountSyncResult {
  accountId: string;
  displayName: string;
  added: number;
  updated: number;
  errorMessage?: string;
}

export interface SyncSummary {
  banks: number;
  accounts: number;
  transactionsAdded: number;
  transactionsUpdated: number;
  durationMs: number;
  results: ConnectionSyncResult[];
  /** Connections whose expiry falls within the warning window. */
  expiringSoon: Array<{ connectionId: string; providerName: string; daysLeft: number }>;
  dryRun: boolean;
}

/** Concrete TokenStore implementation backed by keychain + DB. */
export interface KeychainTokenStoreDeps {
  loadAccessToken: (connectionId: string) => Promise<string | null>;
  loadRefreshToken: (connectionId: string) => Promise<string | null>;
  loadExpiry: (connectionId: string) => Promise<string | null>;
  saveBundle: (connectionId: string, bundle: TokenBundle) => Promise<void>;
  markNeedsReauth: (connectionId: string) => Promise<void>;
}

/**
 * Top-level entry point. Iterates active connections (or just the one named
 * via {@link SyncOptions.connectionId}), runs each through {@link syncConnection}
 * with full failure isolation, and returns a summary.
 */
export async function syncAllConnections(
  opts: SyncOptions,
  ctx: SyncContext,
): Promise<SyncSummary> {
  const db = ctx.db ?? defaultDb;
  const now = ctx.now ?? (() => new Date());
  const startedAt = now();

  const connections = resolveConnections(opts, db);
  const expiringSoon = computeExpiringSoon(connections, startedAt);

  const results: ConnectionSyncResult[] = [];
  for (const conn of connections) {
    // Per-connection failure isolation — never let one bank abort the rest.
    try {
      const client = await ctx.clientFactory(conn);
      const result = await syncConnection(conn, client, opts, { ...ctx, db, now });
      results.push(result);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      ctx.logger?.error(`[${conn.providerName}] ${errorMessage}`);
      // Connection-level failure (i.e. a throw that escaped syncConnection,
      // typically an AuthError on /accounts). The authoritative `sync.failed`
      // audit event is emitted inside `syncConnection`'s own catch so there's
      // exactly one emit per failed connection, regardless of whether the
      // failure mode was "all accounts failed" or "threw before terminal".
      const completedAt = now();
      const durationMs = completedAt.getTime() - startedAt.getTime();
      const status: ConnectionSyncResult['status'] = 'failed';
      if (!opts.dryRun) {
        recordSyncLog(
          {
            connectionId: conn.id,
            startedAt,
            completedAt,
            status,
            transactionsAdded: 0,
            transactionsUpdated: 0,
            errorMessage,
          },
          db,
        );
        if (err instanceof AuthError) {
          markConnectionStatus(conn.id, 'needs_reauth', errorMessage, db);
        }
      }
      results.push({
        connectionId: conn.id,
        providerName: conn.providerName,
        status,
        accounts: 0,
        transactionsAdded: 0,
        transactionsUpdated: 0,
        durationMs,
        errorMessage,
        perAccount: [],
      });
    }
  }

  const completedAt = now();
  const totalAdded = results.reduce((s, r) => s + r.transactionsAdded, 0);
  const totalUpdated = results.reduce((s, r) => s + r.transactionsUpdated, 0);
  const totalAccounts = results.reduce((s, r) => s + r.accounts, 0);
  return {
    banks: results.length,
    accounts: totalAccounts,
    transactionsAdded: totalAdded,
    transactionsUpdated: totalUpdated,
    durationMs: completedAt.getTime() - startedAt.getTime(),
    results,
    expiringSoon,
    dryRun: Boolean(opts.dryRun),
  };
}

/**
 * Sync a single connection: discover accounts (transaction + card), then for
 * each one fetch transactions in the appropriate date window and write them
 * inside a per-account transaction. Errors at the account level downgrade the
 * connection result to `partial` instead of failing the whole bank.
 */
export async function syncConnection(
  conn: Connection,
  client: TrueLayerClient,
  opts: SyncOptions,
  ctx: Required<Pick<SyncContext, 'db' | 'now'>> & SyncContext,
): Promise<ConnectionSyncResult> {
  // Audit boundary: one `sync.started` per connection attempted, and exactly
  // one terminal event (`sync.completed` or `sync.failed`) regardless of
  // whether the failure mode is "all accounts failed but we returned" or
  // "something threw before we reached the terminal block". `dry_run` is
  // part of the shape so we can later tell real syncs apart from `--dry-run`
  // rehearsals during audits.
  appendAuditEvent('sync.started', {
    connection_id: conn.id,
    dry_run: Boolean(opts.dryRun),
  });

  try {
    return await runSyncConnection(conn, client, opts, ctx);
  } catch (err) {
    // Single authoritative failure emit for the throw-escapes path. The
    // orchestrator catches and records the sync log row — audit wise we
    // just need the event to land before the error bubbles.
    appendAuditEvent('sync.failed', {
      connection_id: conn.id,
      error_class: err instanceof Error ? err.constructor.name : 'unknown',
    });
    throw err;
  }
}

/**
 * Inner body of {@link syncConnection} — kept as a private helper so the
 * outer function can wrap it in a single try/catch that emits exactly one
 * `sync.failed` event for any throw path. All existing semantics (per-account
 * isolation, terminal state audit emit, sync log row writes) remain inside
 * here unchanged.
 */
async function runSyncConnection(
  conn: Connection,
  client: TrueLayerClient,
  opts: SyncOptions,
  ctx: Required<Pick<SyncContext, 'db' | 'now'>> & SyncContext,
): Promise<ConnectionSyncResult> {
  const startedAt = ctx.now();
  const db = ctx.db ?? defaultDb;
  const now = ctx.now;
  const logger = ctx.logger;

  const config = safeLoadConfig();
  const defaultHistoryDays = clampHistoryDays(
    opts.defaultHistoryDays ?? config.sync.default_history_days,
  );

  let totalAdded = 0;
  let totalUpdated = 0;
  let accountCount = 0;
  let hadFailure = false;
  let hadSuccess = false;
  const perAccount: AccountSyncResult[] = [];

  // -------- Accounts (transaction / savings) --------
  // Card-only providers (e.g. Amex) return 501 on /accounts — that's a
  // capability gap, not a broken connection. Swallow it and fall through to
  // /cards. Any other error is real and should bubble up to the caller so the
  // connection is marked failed / needs_reauth as appropriate.
  let accountResults: TrueLayerAccount[] = [];
  try {
    const resp = await client.getAccounts();
    accountResults = resp.results;
  } catch (err) {
    if (err instanceof EndpointNotSupportedError) {
      logger?.info(
        `[${conn.providerName}] provider has no /accounts endpoint; checking /cards instead.`,
      );
    } else {
      throw err;
    }
  }
  for (const remote of accountResults) {
    accountCount += 1;
    const result = await syncOneAccount({
      connection: conn,
      remote: { kind: 'account', account: remote },
      client,
      opts,
      defaultHistoryDays,
      db,
      now: now(),
      logger,
    });
    perAccount.push(result);
    if (result.errorMessage) hadFailure = true;
    else hadSuccess = true;
    totalAdded += result.added;
    totalUpdated += result.updated;
  }

  // -------- Cards (credit cards) --------
  // Cards may not be available for every provider; missing endpoint is fine.
  let cardResults: TrueLayerCard[] = [];
  try {
    const resp = await client.getCards();
    cardResults = resp.results;
  } catch (err) {
    // Cards is optional — 403 means consent didn't grant cards scope, 501
    // means the provider has no cards endpoint. Either way, carry on with
    // whatever /accounts produced.
    logger?.warn(`[${conn.providerName}] cards endpoint unavailable: ${(err as Error).message}`);
  }
  for (const card of cardResults) {
    accountCount += 1;
    const result = await syncOneAccount({
      connection: conn,
      remote: { kind: 'card', card },
      client,
      opts,
      defaultHistoryDays,
      db,
      now: now(),
      logger,
    });
    perAccount.push(result);
    if (result.errorMessage) hadFailure = true;
    else hadSuccess = true;
    totalAdded += result.added;
    totalUpdated += result.updated;
  }

  const completedAt = now();
  const status: ConnectionSyncResult['status'] = hadFailure
    ? hadSuccess
      ? 'partial'
      : 'failed'
    : 'success';

  if (!opts.dryRun) {
    // Stamp the connection on success/partial so the next sync narrows its
    // window. We deliberately *don't* stamp on full failure — we want the
    // next attempt to retry the same window.
    if (status !== 'failed') {
      markConnectionLastSynced(conn.id, completedAt, db);
    }
    recordSyncLog(
      {
        connectionId: conn.id,
        startedAt,
        completedAt,
        status,
        transactionsAdded: totalAdded,
        transactionsUpdated: totalUpdated,
        errorMessage: hadFailure
          ? perAccount
              .filter((a) => a.errorMessage)
              .map((a) => `${a.displayName}: ${a.errorMessage}`)
              .join('; ')
          : null,
      },
      db,
    );
  }

  // Audit: terminal state for this connection. Counts are already
  // PRD-sanctioned user-local data (no merchant names, no amounts).
  // `sync.failed` here is the "all accounts failed" shape; a throw that
  // escapes this function produces `sync.failed` in the orchestrator
  // catch-block instead.
  if (status === 'failed') {
    appendAuditEvent('sync.failed', {
      connection_id: conn.id,
      accounts: accountCount,
    });
  } else {
    appendAuditEvent('sync.completed', {
      connection_id: conn.id,
      status,
      accounts: accountCount,
      transactions_added: totalAdded,
      transactions_updated: totalUpdated,
      duration_ms: completedAt.getTime() - startedAt.getTime(),
    });
  }

  return {
    connectionId: conn.id,
    providerName: conn.providerName,
    status,
    accounts: accountCount,
    transactionsAdded: totalAdded,
    transactionsUpdated: totalUpdated,
    durationMs: completedAt.getTime() - startedAt.getTime(),
    perAccount,
  };
}

interface SyncAccountInput {
  connection: Connection;
  remote: { kind: 'account'; account: TrueLayerAccount } | { kind: 'card'; card: TrueLayerCard };
  client: TrueLayerClient;
  opts: SyncOptions;
  defaultHistoryDays: number;
  db: Db;
  now: Date;
  logger?: SyncLogger;
}

/**
 * Wrapper around the TrueLayer fetches + DB writes for a single account/card.
 *
 * The DB writes (account upsert, txn bulk-insert, balance update,
 * pending-update) all run inside a single `db.transaction(...)` so a crash
 * mid-account is rolled back. Network fetches happen *before* the transaction
 * opens — we never want to hold a write lock across HTTP latency.
 */
async function syncOneAccount(input: SyncAccountInput): Promise<AccountSyncResult> {
  const { connection, remote, client, opts, defaultHistoryDays, db, now, logger } = input;

  const accountMeta = remote.kind === 'account' ? mapAccount(remote.account) : mapCard(remote.card);

  try {
    // ---- Determine date window ----
    const lastSynced =
      opts.since ?? getLatestTransactionTimestamp(accountMeta.id, db) ?? connection.lastSyncedAt;
    const fromDate = lastSynced ?? new Date(now.getTime() - defaultHistoryDays * DAY_MS);
    // Don't request more than MAX_HISTORY_DAYS in one go — even when the user
    // overrides --since to a long-ago date, TrueLayer will reject.
    const earliestAllowed = new Date(now.getTime() - MAX_HISTORY_DAYS * DAY_MS);
    const effectiveFrom = fromDate < earliestAllowed ? earliestAllowed : fromDate;
    const range = { from: toIsoZ(effectiveFrom), to: toIsoZ(now) };

    // ---- Fetch transactions + balance + pending (best effort) ----
    let transactions: TrueLayerTransaction[] = [];
    let balanceAvailable: number | null = null;
    let balanceCurrent: number | null = null;
    let balanceUpdatedAt: Date = now;
    let pending: TrueLayerTransaction[] = [];

    if (remote.kind === 'account') {
      const txResp = await client.getAccountTransactions(remote.account.account_id, range);
      transactions = txResp.results;
      const balResp = await client.getAccountBalance(remote.account.account_id);
      const bal = balResp.results[0];
      if (bal) {
        balanceAvailable = bal.available ?? null;
        balanceCurrent = bal.current;
        balanceUpdatedAt = bal.update_timestamp ? new Date(bal.update_timestamp) : now;
      }
      // Pending is optional — failure must not poison the account.
      try {
        const pendResp = await client.getPendingTransactions(remote.account.account_id);
        pending = pendResp.results;
      } catch (err) {
        if (err instanceof AuthError) throw err;
        logger?.warn(
          `[${connection.providerName}/${accountMeta.displayName}] pending unavailable: ${(err as Error).message}`,
        );
      }
    } else {
      const txResp = await client.getCardTransactions(remote.card.account_id, range);
      transactions = txResp.results;
      const balResp = await client.getCardBalance(remote.card.account_id);
      const bal: TrueLayerCardBalance | undefined = balResp.results[0];
      if (bal) {
        balanceAvailable = bal.available;
        balanceCurrent = bal.current;
        balanceUpdatedAt = bal.update_timestamp ? new Date(bal.update_timestamp) : now;
      }
    }

    // ---- Map to NewTransaction[] ----
    const settledRows = transactions.map((t) => mapTransactionRow(t, accountMeta.id, false, now));
    const pendingRows = pending.map((t) => mapTransactionRow(t, accountMeta.id, true, now));
    // Deduplicate within the response — TrueLayer occasionally returns the
    // same id twice when paginating.
    const allRows = dedupeById([...settledRows, ...pendingRows]);

    if (opts.dryRun) {
      return {
        accountId: accountMeta.id,
        displayName: accountMeta.displayName,
        added: allRows.length,
        updated: 0,
      };
    }

    // ---- Atomic writes per PRD §11.2 ----
    let added = 0;
    let updated = 0;
    db.transaction((tx) => {
      const txDb = tx as unknown as Db;
      upsertAccount(
        {
          id: accountMeta.id,
          connectionId: connection.id,
          accountType: accountMeta.accountType,
          displayName: accountMeta.displayName,
          iban: accountMeta.iban,
          sortCode: accountMeta.sortCode,
          accountNumber: accountMeta.accountNumber,
          currency: accountMeta.currency,
          balanceAvailable,
          balanceCurrent,
          balanceUpdatedAt,
        },
        txDb,
      );

      // Settled inserts: INSERT OR IGNORE keyed on PK = provider transaction id.
      const settledOnly = allRows.filter((r) => !r.isPending);
      const pendingOnly = allRows.filter((r) => r.isPending);
      const settledIns = bulkInsertTransactions(settledOnly, txDb);
      added += settledIns.inserted;

      // Pending: try insert; if already known, update the row so we capture
      // amount / description revisions before settlement. We treat any pending
      // row that *was* present and is no longer pending as "updated" rather
      // than re-inserting.
      const pendingIns = bulkInsertTransactions(pendingOnly, txDb);
      added += pendingIns.inserted;
      // For pending rows that existed already, refresh mutable fields.
      const knownPendingIds = new Set<string>();
      for (const row of pendingOnly) knownPendingIds.add(row.id);
      const newlyInserted = pendingIns.inserted;
      const pendingExisting = pendingOnly.length - newlyInserted;
      if (pendingExisting > 0) {
        for (const row of pendingOnly) {
          // Cheap path: try update; ignore if it's actually the just-inserted row.
          const ok = updateTransaction(
            {
              id: row.id,
              amount: row.amount,
              description: row.description,
              merchantName: row.merchantName ?? null,
              transactionType: row.transactionType ?? null,
              isPending: true,
              metadata: row.metadata,
            },
            txDb,
          );
          if (ok) updated += 1;
        }
        // updated may double-count freshly-inserted rows above; subtract.
        updated -= newlyInserted;
        if (updated < 0) updated = 0;
      }

      updateAccountBalance(
        accountMeta.id,
        { available: balanceAvailable, current: balanceCurrent, updatedAt: balanceUpdatedAt },
        txDb,
      );
    });

    return {
      accountId: accountMeta.id,
      displayName: accountMeta.displayName,
      added,
      updated,
    };
  } catch (err) {
    if (err instanceof AuthError) throw err; // bubble up to connection-level handler
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger?.warn(`[${connection.providerName}/${accountMeta.displayName}] ${errorMessage}`);
    return {
      accountId: accountMeta.id,
      displayName: accountMeta.displayName,
      added: 0,
      updated: 0,
      errorMessage,
    };
  }
}

// ---------- Mapping helpers ----------

interface AccountMeta {
  id: string;
  accountType: string;
  displayName: string;
  iban: string | null;
  sortCode: string | null;
  accountNumber: string | null;
  currency: string;
}

function mapAccount(a: TrueLayerAccount): AccountMeta {
  return {
    id: a.account_id,
    accountType: a.account_type,
    displayName: a.display_name,
    iban: a.account_number?.iban ?? null,
    sortCode: a.account_number?.sort_code ?? null,
    accountNumber: normalizeAccountNumber(a.account_number?.number),
    currency: a.currency,
  };
}

function mapCard(c: TrueLayerCard): AccountMeta {
  return {
    id: c.account_id,
    accountType: 'CREDIT_CARD',
    displayName: c.display_name,
    iban: null,
    sortCode: null,
    accountNumber: normalizeAccountNumber(c.partial_card_number),
    currency: c.currency,
  };
}

function mapTransactionRow(
  t: TrueLayerTransaction,
  accountId: string,
  isPending: boolean,
  now: Date,
): NewTransaction {
  const id =
    t.transaction_id ??
    t.provider_transaction_id ??
    t.normalised_provider_transaction_id ??
    // Last-ditch hash so the row still inserts. Should rarely fire — TrueLayer
    // always sets transaction_id on settled transactions.
    fallbackTransactionId(accountId, t);
  return {
    id,
    accountId,
    timestamp: new Date(t.timestamp),
    amount: t.amount,
    currency: t.currency,
    description: t.description ?? '',
    merchantName: t.merchant_name ?? null,
    transactionType: t.transaction_type ?? null,
    providerCategory: t.transaction_category ?? null,
    runningBalance: t.running_balance?.amount ?? null,
    isPending,
    metadata: { source: 'truelayer', raw: t },
    createdAt: now,
    updatedAt: now,
  } as NewTransaction;
}

function fallbackTransactionId(accountId: string, t: TrueLayerTransaction): string {
  // Stable hash on (accountId, timestamp, amount, description). Mirrors the
  // CSV importer pattern. Keeps the row insertable + dedupe-safe.
  const canon = `${accountId}|${t.timestamp}|${t.amount.toFixed(2)}|${(t.description ?? '').trim().toLowerCase()}`;
  // Avoid pulling in node:crypto here (already imported via importers, but
  // we want this module side-effect-free at import time). djb2 is sufficient
  // for a fallback since the canonical id is itself a uniqueness key.
  let hash = 5381;
  for (let i = 0; i < canon.length; i++) {
    hash = ((hash << 5) + hash + canon.charCodeAt(i)) | 0;
  }
  return `tl_fallback_${(hash >>> 0).toString(16)}_${Math.round(new Date(t.timestamp).getTime())}`;
}

function dedupeById(rows: NewTransaction[]): NewTransaction[] {
  const seen = new Set<string>();
  const out: NewTransaction[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

function normalizeAccountNumber(num: string | undefined): string | null {
  if (!num) return null;
  const digits = num.replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}

function toIsoZ(d: Date): string {
  return d.toISOString();
}

function clampHistoryDays(days: number): number {
  if (!Number.isFinite(days) || days <= 0) return MAX_HISTORY_DAYS;
  return Math.min(MAX_HISTORY_DAYS, Math.floor(days));
}

function safeLoadConfig() {
  try {
    return loadConfig();
  } catch {
    return {
      sync: { default_history_days: MAX_HISTORY_DAYS, parallel_connections: 2 },
    } as ReturnType<typeof loadConfig>;
  }
}

function resolveConnections(opts: SyncOptions, db: Db): Connection[] {
  if (opts.connectionId) {
    const single = getConnection(opts.connectionId, db);
    if (!single) {
      throw new FerretError(`No connection with id "${opts.connectionId}".`);
    }
    if (single.status !== 'active') {
      throw new FerretError(
        `Connection "${opts.connectionId}" is ${single.status}; re-link before syncing.`,
      );
    }
    return [single];
  }
  return listActiveConnections(db);
}

function computeExpiringSoon(
  conns: Connection[],
  now: Date,
): Array<{ connectionId: string; providerName: string; daysLeft: number }> {
  const cutoffMs = EXPIRY_WARNING_DAYS * DAY_MS;
  const out: Array<{ connectionId: string; providerName: string; daysLeft: number }> = [];
  for (const c of conns) {
    // Field name anchor: schema declares `expiresAt: integer('expires_at',
    // { mode: 'timestamp' }).notNull()` (see src/db/schema.ts), so the
    // drizzle-inferred Connection type exposes camelCase `expiresAt: Date`.
    // If the column is ever renamed this property access will fail at compile
    // time — keep them in lockstep.
    const delta = c.expiresAt.getTime() - now.getTime();
    if (delta < cutoffMs) {
      out.push({
        connectionId: c.id,
        providerName: c.providerName,
        daysLeft: Math.max(0, Math.round(delta / DAY_MS)),
      });
    }
  }
  return out;
}

// Re-export some helpers tests may want.
export const __testing = {
  mapAccount,
  mapCard,
  mapTransactionRow,
  dedupeById,
  clampHistoryDays,
  computeExpiringSoon,
};

// Account is imported so types resolve, but isn't otherwise referenced — keep
// the dependency explicit for future schema introspection helpers.
export type { Account };
