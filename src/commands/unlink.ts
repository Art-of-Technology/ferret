// `ferret unlink` — revoke a connection.
//
// Per the issue + PRD §4.1: by default this is a soft revoke — it removes
// tokens and marks the connection `revoked`, but leaves `accounts` and
// `transactions` rows intact so the user's transaction history remains
// queryable for `ferret ls` / `ferret ask`.
//
// Pass `--all` to hard-delete EVERY connection together with its accounts,
// transactions, sync logs, and keychain tokens — useful for wiping the DB
// when starting over. See `ferret remove` for the single-id hard-delete.
//
// Behaviour:
//   - `unlink <id>`     → soft revoke (tokens gone, history retained)
//   - `unlink --all`    → hard delete ALL bank-linked data

import { defineCommand } from 'citty';
import consola from 'consola';
import { eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { accounts, connections, syncLog, transactions } from '../db/schema';
import { ValidationError } from '../lib/errors';
import { deleteAllForConnection } from '../services/keychain';

export default defineCommand({
  meta: { name: 'unlink', description: 'Remove a connection and revoke tokens' },
  args: {
    connectionId: { type: 'positional', description: 'Connection id', required: false },
    all: { type: 'boolean', description: 'Hard-delete every connection + its data' },
  },
  async run({ args }) {
    const all = Boolean(args.all);
    const connectionId = args.connectionId ? String(args.connectionId) : '';

    if (all && connectionId) {
      throw new ValidationError('Pass either a connection id OR --all, not both.');
    }
    if (!all && !connectionId) {
      throw new ValidationError('Provide a connection id, or use --all.');
    }

    const { db } = getDb();

    if (all) {
      const allConns = db.select({ id: connections.id }).from(connections).all();
      if (allConns.length === 0) {
        consola.info('No connections to remove.');
        return;
      }

      let keychainRemoved = 0;
      for (const c of allConns) {
        keychainRemoved += await deleteAllForConnection(c.id).catch((err) => {
          consola.warn(`Could not clear keychain for ${c.id}: ${(err as Error).message}`);
          return 0;
        });
      }

      const summary = hardDeleteConnections(
        db,
        allConns.map((c) => c.id),
      );
      consola.success(
        `Removed ${summary.connections} connection(s), ${summary.accounts} account(s), ${summary.transactions} transaction(s); cleared ${keychainRemoved} keychain entr${keychainRemoved === 1 ? 'y' : 'ies'}.`,
      );
      return;
    }

    const existing = db.select().from(connections).where(eq(connections.id, connectionId)).all();
    const conn = existing[0];
    if (!conn) {
      throw new ValidationError(`No connection with id "${connectionId}".`);
    }

    const removed = await deleteAllForConnection(connectionId).catch((err) => {
      consola.warn(`Could not fully clear keychain entries: ${(err as Error).message}`);
      return 0;
    });

    db.update(connections).set({ status: 'revoked' }).where(eq(connections.id, connectionId)).run();

    consola.success(
      `Unlinked ${conn.providerName} (${connectionId}). Removed ${removed} keychain entr${removed === 1 ? 'y' : 'ies'}; transaction history retained.`,
    );
  },
});

export interface HardDeleteSummary {
  connections: number;
  accounts: number;
  transactions: number;
  syncLogs: number;
}

// Hard-deletes the given connections and their dependent rows (accounts,
// transactions, sync_log) in one SQLite transaction. Order matters because of
// the FK chain: transactions → accounts → connections.
export function hardDeleteConnections(
  db: ReturnType<typeof getDb>['db'],
  ids: string[],
): HardDeleteSummary {
  if (ids.length === 0) {
    return { connections: 0, accounts: 0, transactions: 0, syncLogs: 0 };
  }
  return db.transaction((tx) => {
    const accountRows = tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(inArray(accounts.connectionId, ids))
      .all();
    const accountIds = accountRows.map((a) => a.id);

    const txCountRow = accountIds.length
      ? tx
          .select({ n: sql<number>`count(*)` })
          .from(transactions)
          .where(inArray(transactions.accountId, accountIds))
          .all()[0]
      : undefined;
    const txCount = txCountRow ? Number(txCountRow.n) : 0;

    const logCountRow = tx
      .select({ n: sql<number>`count(*)` })
      .from(syncLog)
      .where(inArray(syncLog.connectionId, ids))
      .all()[0];
    const logCount = logCountRow ? Number(logCountRow.n) : 0;

    if (accountIds.length > 0) {
      tx.delete(transactions).where(inArray(transactions.accountId, accountIds)).run();
      tx.delete(accounts).where(inArray(accounts.id, accountIds)).run();
    }
    tx.delete(syncLog).where(inArray(syncLog.connectionId, ids)).run();
    tx.delete(connections).where(inArray(connections.id, ids)).run();

    return {
      connections: ids.length,
      accounts: accountIds.length,
      transactions: txCount,
      syncLogs: logCount,
    };
  });
}
