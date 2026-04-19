// `ferret link` — full TrueLayer OAuth flow per PRD §4.1 + §8.1.
//
// Steps:
//   1. Resolve TrueLayer client_id / client_secret from keychain or env.
//   2. Spawn an ephemeral local server (services/oauth) and open the browser.
//   3. Exchange the captured authorization code for tokens.
//   4. Call /data/v1/me to obtain provider metadata.
//   5. Persist tokens to keychain and a row in `connections` (+ accounts via /accounts).

import { randomUUID } from 'node:crypto';
import { defineCommand } from 'citty';
import consola from 'consola';
import { getDb } from '../db/client';
import { accounts, connections } from '../db/schema';
import { AuthError, DataIntegrityError, ValidationError } from '../lib/errors';
import { TRUELAYER_CLIENT_ID, TRUELAYER_CLIENT_SECRET, resolveSecret } from '../lib/secrets';
import { accountNames, setToken } from '../services/keychain';
import { runOAuthFlow } from '../services/oauth';
import {
  AUTH_BASE,
  DEFAULT_PROVIDERS,
  DEFAULT_SCOPE,
  TrueLayerClient,
} from '../services/truelayer';
import type { TrueLayerAccount, TrueLayerMeResult } from '../types/truelayer';

function buildAuthUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  providers: string;
  scope: string;
}): string {
  const u = new URL('/', AUTH_BASE);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', args.clientId);
  u.searchParams.set('redirect_uri', args.redirectUri);
  u.searchParams.set('scope', args.scope);
  u.searchParams.set('providers', args.providers);
  u.searchParams.set('state', args.state);
  return u.toString();
}

// Per PRD §9.3, account numbers are masked only at the display layer.
// We store the full digits-only value (file already chmod 0600 per §9.2)
// and let the rendering layer truncate to last-4 when shown to humans.
function normalizeAccountNumber(num: string | undefined): string | null {
  if (!num) return null;
  const digits = num.replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}

export default defineCommand({
  meta: { name: 'link', description: 'Connect a bank via OAuth (TrueLayer)' },
  args: {
    provider: {
      type: 'string',
      description: 'TrueLayer provider id (e.g. uk-ob-lloyds). Defaults to uk-oauth-all.',
    },
    scope: {
      type: 'string',
      description: 'Override OAuth scope (advanced).',
    },
    timeout: {
      type: 'string',
      description: 'OAuth flow timeout in seconds (default 300).',
    },
  },
  async run({ args }) {
    const clientId = await resolveSecret(TRUELAYER_CLIENT_ID);
    const clientSecret = await resolveSecret(TRUELAYER_CLIENT_SECRET);

    const providers = (args.provider as string | undefined) ?? DEFAULT_PROVIDERS;
    const scope = (args.scope as string | undefined) ?? DEFAULT_SCOPE;
    const timeoutSecondsRaw = args.timeout as string | undefined;
    let timeoutMs: number | undefined;
    if (timeoutSecondsRaw !== undefined) {
      const parsed = Number.parseInt(timeoutSecondsRaw, 10);
      if (Number.isNaN(parsed) || parsed <= 0) {
        throw new ValidationError('--timeout must be a positive integer (seconds)');
      }
      timeoutMs = Math.max(10, parsed) * 1000;
    }

    consola.info(`Starting OAuth flow (providers=${providers})`);

    const callback = await runOAuthFlow({
      buildAuthUrl: (redirectUri, state) =>
        buildAuthUrl({ clientId, redirectUri, state, providers, scope }),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      onListening: ({ port, authUrl }) => {
        consola.info(`Listening on http://localhost:${port}/callback`);
        consola.info('Opening browser to TrueLayer auth...');
        consola.log(`If your browser does not open automatically, visit:\n${authUrl}`);
      },
    });

    consola.success('Authorization code captured. Exchanging for tokens...');

    const tokens = await TrueLayerClient.exchangeAuthCode({
      credentials: { clientId, clientSecret },
      code: callback.code,
      redirectUri: callback.redirectUri,
    });

    // Fetch provider metadata via /me. Use a single-shot client with the fresh
    // tokens; persistence happens after we get the connection id.
    const tempStore = createInertStore();
    const initialBundle = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAtMs: Date.now() + tokens.expires_in * 1000,
    };
    const client = new TrueLayerClient({
      credentials: { clientId, clientSecret },
      store: tempStore,
      initialTokens: initialBundle,
    });
    const me = await client.getMe();
    const meResult: TrueLayerMeResult | undefined = me.results[0];
    if (!meResult) {
      throw new AuthError('TrueLayer /me returned no provider metadata.');
    }

    // Per PRD §8.1, the *connection* (PSD2 consent) lasts up to 90 days.
    // If the API surfaces a consent_expires_at, prefer that; otherwise use 90d from now.
    const connExpiresAt = meResult.consent_expires_at
      ? new Date(meResult.consent_expires_at)
      : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

    const connectionId = randomUUID();

    // Persist tokens BEFORE writing the DB row so a partial failure leaves the
    // keychain entries that the row would point at, not orphaned DB metadata.
    await setToken(accountNames.access(connectionId), tokens.access_token);
    await setToken(accountNames.refresh(connectionId), tokens.refresh_token);
    await setToken(accountNames.expiry(connectionId), String(initialBundle.expiresAtMs));

    const { db } = getDb();
    const now = new Date();
    // Bun's drizzle SQLite driver runs `.run()` synchronously and surfaces
    // failures via thrown exceptions; wrap so a constraint or IO error becomes
    // a typed DataIntegrityError instead of an unhandled rejection.
    try {
      db.insert(connections)
        .values({
          id: connectionId,
          providerId: meResult.provider.provider_id,
          providerName: meResult.provider.display_name,
          createdAt: now,
          expiresAt: connExpiresAt,
          status: 'active',
          lastSyncedAt: null,
        })
        .run();
    } catch (err) {
      throw new DataIntegrityError(
        `Failed to persist connection row for ${meResult.provider.display_name}: ${(err as Error).message}`,
      );
    }

    // Best-effort: fetch accounts list so the user can immediately see what
    // was linked. Failures here do not abort the link, since `ferret sync`
    // will re-fetch accounts as part of normal operation.
    let accountRows: TrueLayerAccount[] = [];
    try {
      const accountsResp = await client.getAccounts();
      accountRows = accountsResp.results;
    } catch (err) {
      consola.warn(`Linked successfully but failed to list accounts: ${(err as Error).message}`);
    }

    if (accountRows.length > 0) {
      for (const a of accountRows) {
        try {
          db.insert(accounts)
            .values({
              id: a.account_id,
              connectionId,
              accountType: a.account_type,
              displayName: a.display_name,
              iban: a.account_number?.iban ?? null,
              sortCode: a.account_number?.sort_code ?? null,
              accountNumber: normalizeAccountNumber(a.account_number?.number),
              currency: a.currency,
              balanceAvailable: null,
              balanceCurrent: null,
              balanceUpdatedAt: null,
              isManual: false,
            })
            .run();
        } catch (err) {
          consola.warn(`Skipped account ${a.account_id.slice(0, 8)}…: ${(err as Error).message}`);
        }
      }
    }

    consola.success(
      `Connected: ${meResult.provider.display_name} (expires ${connExpiresAt.toISOString().slice(0, 10)})`,
    );
    consola.info(`Connection id: ${connectionId}`);
    if (accountRows.length > 0) {
      consola.info(`Discovered ${accountRows.length} account(s).`);
    }
  },
});

// A no-op store used during the initial /me call; we manage persistence
// ourselves once the connection id is known. `initialTokens` is always passed
// to the client, so `load()` should never fire — if it does, that's a logic
// bug on the caller's side, not a config problem.
function createInertStore() {
  return {
    async load(): Promise<never> {
      throw new Error(
        'createInertStore: load() invoked, but the inert store has no persisted tokens. ' +
          'Pass initialTokens to TrueLayerClient before any request that may trigger a refresh.',
      );
    },
    async save() {
      // ignore
    },
    async markNeedsReauth() {
      // ignore
    },
  };
}
