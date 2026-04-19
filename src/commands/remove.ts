// `ferret remove` — hard-delete a connection (or all of them).
//
// Unlike `ferret unlink` (which by default soft-revokes and keeps history),
// `remove` always wipes bank-linked rows: the connection, its accounts, its
// transactions, its sync_log entries, and its keychain tokens. Use this when
// you want `ferret connections` to come back empty.
//
// Non-bank data (rules, budgets, categories, merchant_cache) is left alone —
// those are user-owned config, not synced from a provider.

import { defineCommand } from 'citty';
import consola from 'consola';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { connections } from '../db/schema';
import { ValidationError } from '../lib/errors';
import { deleteAllForConnection } from '../services/keychain';
import { hardDeleteConnections } from './unlink';

export default defineCommand({
  meta: {
    name: 'remove',
    description: 'Hard-delete a connection and all its accounts + transactions',
  },
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

    let targetIds: string[];
    if (all) {
      targetIds = db
        .select({ id: connections.id })
        .from(connections)
        .all()
        .map((c) => c.id);
      if (targetIds.length === 0) {
        consola.info('No connections to remove.');
        return;
      }
    } else {
      const row = db
        .select({ id: connections.id })
        .from(connections)
        .where(eq(connections.id, connectionId))
        .all()[0];
      if (!row) {
        throw new ValidationError(`No connection with id "${connectionId}".`);
      }
      targetIds = [row.id];
    }

    let keychainRemoved = 0;
    for (const id of targetIds) {
      keychainRemoved += await deleteAllForConnection(id).catch((err) => {
        consola.warn(`Could not clear keychain for ${id}: ${(err as Error).message}`);
        return 0;
      });
    }

    const summary = hardDeleteConnections(db, targetIds);
    consola.success(
      `Removed ${summary.connections} connection(s), ${summary.accounts} account(s), ${summary.transactions} transaction(s); cleared ${keychainRemoved} keychain entr${keychainRemoved === 1 ? 'y' : 'ies'}.`,
    );
  },
});
