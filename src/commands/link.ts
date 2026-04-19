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
import { appendAuditEvent } from '../lib/audit';
import { AuthError, DataIntegrityError, ValidationError } from '../lib/errors';
import { resolveSecret, TRUELAYER_CLIENT_ID, TRUELAYER_CLIENT_SECRET } from '../lib/secrets';
import { accountNames, setToken } from '../services/keychain';
import { runOAuthFlow } from '../services/oauth';
import {
  AUTH_BASE,
  DEFAULT_PROVIDERS,
  DEFAULT_SCOPE,
  EndpointNotSupportedError,
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

    // Best-effort: fetch accounts + cards so the user can immediately see what
    // was linked. Failures here do not abort the link, since `ferret sync`
    // will re-fetch these as part of normal operation. Card-only providers
    // (Amex) return 501 on /accounts — that's a capability gap, not an error.
    let accountRows: TrueLayerAccount[] = [];
    try {
      const accountsResp = await client.getAccounts();
      accountRows = accountsResp.results;
    } catch (err) {
      if (!(err instanceof EndpointNotSupportedError)) {
        consola.warn(`Linked successfully but failed to list accounts: ${(err as Error).message}`);
      }
    }

    let cardRows: Array<{
      account_id: string;
      display_name: string;
      partial_card_number?: string;
      currency: string;
    }> = [];
    try {
      const cardsResp = await client.getCards();
      cardRows = cardsResp.results;
    } catch (err) {
      // 501 = provider has no /cards endpoint; 403 = consent didn't grant the
      // `cards` scope. Both are expected capability gaps, not failures — stay
      // silent. Anything else (network, auth, 5xx) is real and worth a warn
      // so users can see why a card they expected isn't in the discovered list.
      if (!(err instanceof EndpointNotSupportedError) && !(err instanceof AuthError)) {
        consola.warn(`Linked successfully but failed to list cards: ${(err as Error).message}`);
      }
    }

    let discovered = 0;
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
        discovered += 1;
      } catch (err) {
        consola.warn(`Skipped account ${a.account_id.slice(0, 8)}…: ${(err as Error).message}`);
      }
    }

    for (const c of cardRows) {
      try {
        db.insert(accounts)
          .values({
            id: c.account_id,
            connectionId,
            accountType: 'CREDIT_CARD',
            displayName: c.display_name,
            iban: null,
            sortCode: null,
            accountNumber: normalizeAccountNumber(c.partial_card_number),
            currency: c.currency,
            balanceAvailable: null,
            balanceCurrent: null,
            balanceUpdatedAt: null,
            isManual: false,
          })
          .run();
        discovered += 1;
      } catch (err) {
        consola.warn(`Skipped card ${c.account_id.slice(0, 8)}…: ${(err as Error).message}`);
      }
    }

    // Audit trail — provider id + connection id are not secrets, and the
    // discovered-count helps reconcile later sync runs. No tokens or
    // account numbers are logged.
    appendAuditEvent('connection.linked', {
      connection_id: connectionId,
      provider_id: meResult.provider.provider_id,
      accounts_discovered: accountRows.length,
      cards_discovered: cardRows.length,
    });

    consola.success(
      `Connected: ${meResult.provider.display_name} (expires ${connExpiresAt.toISOString().slice(0, 10)})`,
    );
    consola.info(`Connection id: ${connectionId}`);
    if (discovered > 0) {
      const parts: string[] = [];
      if (accountRows.length > 0) parts.push(`${accountRows.length} account(s)`);
      if (cardRows.length > 0) parts.push(`${cardRows.length} card(s)`);
      consola.info(`Discovered ${parts.join(' + ')}.`);
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
