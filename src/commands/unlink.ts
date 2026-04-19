// `ferret unlink` — revoke a connection.
//
// Per the issue + PRD §4.1: this should remove tokens and stop the connection
// from being used. We deliberately do NOT delete `accounts` or `transactions`
// rows: the user's transaction history is the most valuable artefact of using
// the tool, and we want it to remain queryable for `ferret ls` / `ferret ask`
// even after a bank is unlinked.
//
// Behaviour:
//   - Delete every keychain entry under `truelayer:{connection_id}:*`
//   - Mark the connection row `status='revoked'`
//   - Leave `accounts` and `transactions` rows intact (audit trail).
//
// If the user truly wants to remove the data, they can drop rows from SQLite
// directly (or wait for a future `ferret purge` command).

import { defineCommand } from 'citty';
import consola from 'consola';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { connections } from '../db/schema';
import { ValidationError } from '../lib/errors';
import { deleteAllForConnection } from '../services/keychain';

export default defineCommand({
  meta: { name: 'unlink', description: 'Remove a connection and revoke tokens' },
  args: {
    connectionId: { type: 'positional', description: 'Connection id', required: true },
  },
  async run({ args }) {
    const connectionId = String(args.connectionId);
    if (!connectionId) {
      throw new ValidationError('connection id is required');
    }

    const { db } = getDb();
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
