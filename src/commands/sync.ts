// `ferret sync` — fetch transactions + balances from every active connection.
//
// Per PRD §4.2:
//   - Iterates active connections (or `--connection <id>`).
//   - Per account: pulls transactions since `last_synced_at`, plus balance.
//   - First sync: up to 24 months of history (capped via config).
//   - Dedupes by `provider_transaction_id` (PK = INSERT OR IGNORE).
//   - Per-account work wrapped in db.transaction (PRD §11.2 atomicity).
//   - Per-connection failure isolation — one bank failing leaves the rest
//     untouched (orchestrator handles).
//   - Emits a sync_log row per connection for the audit trail.
//   - `--dry-run` skips writes entirely.
//   - Token refresh, 401/429/5xx retries, AuthError surfacing all happen
//     inside services/truelayer.ts via the TokenStore we hand to it.
//
// Output: `N new, M updated, K accounts across L banks in Xs` per PRD spec,
// preceded by per-bank progress lines and a yellow expiry warning when any
// connection has < 7 days left.

import { defineCommand } from 'citty';
import consola from 'consola';
import { eq } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import pc from 'picocolors';
import { db as defaultDb } from '../db/client';
import { markConnectionStatus } from '../db/queries/sync';
import type * as schema from '../db/schema';
import { connections } from '../db/schema';
import { parseDuration } from '../lib/dates';
import { AuthError } from '../lib/errors';
import { resolveSecret, TRUELAYER_CLIENT_ID, TRUELAYER_CLIENT_SECRET } from '../lib/secrets';
import { accountNames, getToken, setToken } from '../services/keychain';
import { type ConnectionSyncResult, type SyncSummary, syncAllConnections } from '../services/sync';
import { type TokenBundle, type TokenStore, TrueLayerClient } from '../services/truelayer';
import type { Connection } from '../types/domain';

export default defineCommand({
  meta: { name: 'sync', description: 'Sync transactions from connected banks' },
  args: {
    connection: { type: 'string', description: 'Sync only one connection by id' },
    since: { type: 'string', description: 'Override last_synced_at, e.g. 30d' },
    'dry-run': { type: 'boolean', description: 'Fetch without writing' },
  },
  async run({ args }) {
    const connectionId = args.connection as string | undefined;
    const sinceArg = args.since as string | undefined;
    const dryRun = Boolean(args['dry-run']);

    let since: Date | undefined;
    if (sinceArg) {
      // parseDuration throws ValidationError on bad input — let it bubble.
      since = parseDuration(sinceArg);
    }

    // Short-circuit when there are no active connections; fresh-init users
    // shouldn't have to debug a missing TrueLayer client_id.
    const activeCount = countActive(connectionId);
    if (activeCount === 0) {
      process.stdout.write('0 connections active\n');
      return;
    }

    const clientId = await resolveSecret(TRUELAYER_CLIENT_ID);
    const clientSecret = await resolveSecret(TRUELAYER_CLIENT_SECRET);

    // `SyncLogger` is now `Pick<typeof consola, ...>` so consola itself is
    // structurally assignable — no wrapper needed.
    const summary: SyncSummary = await syncAllConnections(
      {
        ...(connectionId ? { connectionId } : {}),
        ...(since ? { since } : {}),
        dryRun,
      },
      {
        clientFactory: async (conn) => createClientForConnection(conn, { clientId, clientSecret }),
        logger: consola,
      },
    );

    // Per-bank lines mirror PRD §A appendix output.
    for (const r of summary.results) {
      printConnectionResult(r);
    }

    // Connection-expiry warnings.
    for (const exp of summary.expiringSoon) {
      const text = `${exp.providerName} expires in ${exp.daysLeft}d — run \`ferret link --renew ${exp.connectionId}\``;
      process.stdout.write(`${pc.yellow(text)}\n`);
    }

    // Final summary line per PRD: "N new, M updated, K accounts across L banks in Xs"
    const seconds = (summary.durationMs / 1000).toFixed(1);
    const tail = dryRun ? ' (dry-run)' : '';
    process.stdout.write(
      `${summary.transactionsAdded} new, ${summary.transactionsUpdated} updated, ${summary.accounts} accounts across ${summary.banks} banks in ${seconds}s${tail}\n`,
    );
  },
});

function printConnectionResult(r: ConnectionSyncResult): void {
  const seconds = (r.durationMs / 1000).toFixed(1);
  if (r.status === 'failed') {
    process.stdout.write(
      `${pc.red('x')} ${r.providerName}: ${r.errorMessage ?? 'failed'} (${seconds}s)\n`,
    );
    return;
  }
  const checkmark = r.status === 'partial' ? pc.yellow('!') : pc.green('o');
  process.stdout.write(
    `${checkmark} ${r.providerName}: ${r.transactionsAdded} new, ${r.transactionsUpdated} updated across ${r.accounts} account(s) in ${seconds}s\n`,
  );
  if (r.status === 'partial') {
    for (const a of r.perAccount) {
      if (a.errorMessage) {
        process.stdout.write(`  ${pc.yellow('-')} ${a.displayName}: ${a.errorMessage}\n`);
      }
    }
  }
}

type Db = BunSQLiteDatabase<typeof schema>;

export function countActive(connectionId: string | undefined, db: Db = defaultDb): number {
  // Cheap pre-flight to avoid resolving secrets when there's nothing to do.
  // `db` is injectable for parity with the helpers in db/queries/sync.ts so
  // tests can pass an in-memory database.
  if (connectionId) {
    const rows = db.select().from(connections).where(eq(connections.id, connectionId)).all();
    const c = rows[0];
    if (!c || c.status !== 'active') return 0;
    return 1;
  }
  const rows = db.select().from(connections).where(eq(connections.status, 'active')).all();
  return rows.length;
}

// ---------- TokenStore wired to keychain + DB ----------

/**
 * Build a TrueLayerClient bound to one connection. The TokenStore writes back
 * to the keychain on refresh so subsequent syncs (and `ask`, etc.) pick up the
 * fresh tokens. On 401-after-refresh the TrueLayer client calls
 * `markNeedsReauth`; we mirror that into `connections.status = 'needs_reauth'`
 * so `ferret connections` highlights it.
 */
export function createClientForConnection(
  conn: Connection,
  creds: { clientId: string; clientSecret: string },
): TrueLayerClient {
  const store: TokenStore = {
    async load(): Promise<TokenBundle> {
      const access = await getToken(accountNames.access(conn.id));
      const refresh = await getToken(accountNames.refresh(conn.id));
      const expiry = await getToken(accountNames.expiry(conn.id));
      if (!access || !refresh) {
        // Keychain entries should be created by `ferret link`; missing here
        // means the connection is half-installed. AuthError exit code (3) is
        // appropriate — user needs to re-link.
        throw new AuthError(
          `Missing tokens for connection ${conn.id}. Re-link with \`ferret link\`.`,
        );
      }
      const expiresAtMs = expiry ? Number.parseInt(expiry, 10) : Date.now() + 60 * 1000;
      return {
        accessToken: access,
        refreshToken: refresh,
        expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 60 * 1000,
      };
    },
    async save(bundle: TokenBundle): Promise<void> {
      await setToken(accountNames.access(conn.id), bundle.accessToken);
      await setToken(accountNames.refresh(conn.id), bundle.refreshToken);
      await setToken(accountNames.expiry(conn.id), String(bundle.expiresAtMs));
    },
    async markNeedsReauth(): Promise<void> {
      try {
        markConnectionStatus(conn.id, 'needs_reauth', 'TrueLayer auth failed');
      } catch (err) {
        // Best effort: the connection-level handler will still record a
        // sync_log row, but we surface the underlying DB error so it shows up
        // in `--verbose` runs and isn't silently masked. We deliberately do
        // not rethrow — the TokenStore contract is fire-and-forget.
        const message = err instanceof Error ? err.message : String(err);
        consola.warn(`Failed to mark connection ${conn.id} as needs_reauth: ${message}`);
      }
    },
  };

  return new TrueLayerClient({
    credentials: { clientId: creds.clientId, clientSecret: creds.clientSecret },
    store,
  });
}
