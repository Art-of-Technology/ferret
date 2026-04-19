// TrueLayer Data API client per PRD §8.1.
//
// Behaviour:
//   - 401 -> refresh once and retry; if still 401, surface AuthError and
//     mark the connection as needing re-auth.
//   - 403 -> AuthError flagged as needing re-consent (no retry).
//   - 429 -> respect Retry-After (seconds), exponential backoff with jitter
//     (250ms base) up to 3 retries.
//   - 5xx -> exponential backoff with jitter (250ms base) up to 3 retries.
//   - 4xx (other) -> NetworkError with status + body context.
//
// Tokens are owned by the caller (commands/services). A `TokenStore` callback
// is passed in; the client invokes it after a successful refresh so callers
// can persist the new tokens (keychain + DB).

import { AuthError, NetworkError, RateLimitError } from '../lib/errors';
import type {
  TrueLayerAccountsResponse,
  TrueLayerBalanceResponse,
  TrueLayerCardBalanceResponse,
  TrueLayerCardsResponse,
  TrueLayerDateRange,
  TrueLayerErrorBody,
  TrueLayerMeResponse,
  TrueLayerTokenResponse,
  TrueLayerTransactionsResponse,
} from '../types/truelayer';

/**
 * Raised when TrueLayer returns 501 `endpoint_not_supported`, which means the
 * selected provider doesn't implement this endpoint at all (e.g. Amex has no
 * `/accounts`, only `/cards`). Callers should fall through to the sibling
 * endpoint, not treat the connection as broken. Extends NetworkError so
 * existing `instanceof NetworkError` handlers still behave sensibly, while
 * allowing specific callers to distinguish capability gaps from real faults.
 */
export class EndpointNotSupportedError extends NetworkError {}

export const AUTH_BASE = 'https://auth.truelayer.com';
export const DATA_BASE = 'https://api.truelayer.com/data/v1';

// `cards` is a distinct TrueLayer scope from `accounts`; without it, every
// /cards request is rejected with 403 regardless of provider — including for
// banks that *do* issue credit cards (e.g. Lloyds). PRD §8.1 lists the /cards
// endpoints but forgot to grant the scope — treat this string as the fix.
export const DEFAULT_SCOPE = 'info accounts balance cards transactions offline_access';
export const DEFAULT_PROVIDERS = 'uk-oauth-all';

export interface TrueLayerCredentials {
  clientId: string;
  clientSecret: string;
}

export interface TokenBundle {
  accessToken: string;
  refreshToken: string;
  /** Wall-clock ms when the access token expires. */
  expiresAtMs: number;
}

export interface TokenStore {
  /** Returns the latest cached tokens (caller may have refreshed elsewhere). */
  load(): Promise<TokenBundle>;
  /** Persists newly refreshed tokens (keychain + DB updates). */
  save(bundle: TokenBundle): Promise<void>;
  /** Marks the connection as needing re-consent (called on 403 / second 401). */
  markNeedsReauth(): Promise<void>;
}

/** Minimal fetch type used for testability. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface TrueLayerClientOptions {
  credentials: TrueLayerCredentials;
  store: TokenStore;
  fetch?: FetchLike;
  /** Pre-load token bundle to avoid a round trip on first request. */
  initialTokens?: TokenBundle;
  /** ms-resolution clock; injectable for tests. */
  now?: () => number;
  /** ms-resolution sleep; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Override max retries for 429 / 5xx (default 3). */
  maxRetries?: number;
  /** Random function (injectable for jitter determinism in tests). */
  random?: () => number;
}

const DEFAULT_RETRIES = 3;
const BACKOFF_BASE_MS = 250;
const TOKEN_REFRESH_SKEW_MS = 60_000; // refresh 60s before expiry per PRD §8.1

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class TrueLayerClient {
  private readonly credentials: TrueLayerCredentials;
  private readonly store: TokenStore;
  private readonly fetchImpl: FetchLike;
  private readonly nowFn: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly randomFn: () => number;
  private readonly maxRetries: number;
  private tokens: TokenBundle | null;
  /** In-flight refresh promise, deduped across concurrent callers. */
  private refreshing: Promise<TokenBundle> | null = null;

  constructor(opts: TrueLayerClientOptions) {
    this.credentials = opts.credentials;
    this.store = opts.store;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.nowFn = opts.now ?? (() => Date.now());
    this.sleepFn = opts.sleep ?? defaultSleep;
    this.randomFn = opts.random ?? Math.random;
    this.maxRetries = opts.maxRetries ?? DEFAULT_RETRIES;
    this.tokens = opts.initialTokens ?? null;
  }

  // ---------- Token management ----------

  /**
   * One-shot exchange of an authorization code for tokens. Used by `ferret link`.
   * No token store / retry logic is needed here.
   */
  static async exchangeAuthCode(args: {
    credentials: TrueLayerCredentials;
    code: string;
    redirectUri: string;
    fetch?: FetchLike;
  }): Promise<TrueLayerTokenResponse> {
    const fetchImpl =
      args.fetch ?? ((input: string | URL, init?: RequestInit) => fetch(input, init));
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: args.credentials.clientId,
      client_secret: args.credentials.clientSecret,
      redirect_uri: args.redirectUri,
      code: args.code,
    });
    const res = await fetchImpl(`${AUTH_BASE}/connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await safeReadText(res);
      throw new AuthError(
        `TrueLayer token exchange failed (${res.status}): ${truncate(text, 500)}`,
      );
    }
    return (await res.json()) as TrueLayerTokenResponse;
  }

  /** Standalone refresh helper (used internally and by callers that hold a refresh token directly). */
  static async refreshAccessToken(args: {
    credentials: TrueLayerCredentials;
    refreshToken: string;
    fetch?: FetchLike;
  }): Promise<TrueLayerTokenResponse> {
    const fetchImpl =
      args.fetch ?? ((input: string | URL, init?: RequestInit) => fetch(input, init));
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: args.credentials.clientId,
      client_secret: args.credentials.clientSecret,
      refresh_token: args.refreshToken,
    });
    const res = await fetchImpl(`${AUTH_BASE}/connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await safeReadText(res);
      throw new AuthError(`TrueLayer token refresh failed (${res.status}): ${truncate(text, 500)}`);
    }
    return (await res.json()) as TrueLayerTokenResponse;
  }

  // Instance wrappers that match the PRD §8.1 surface for Phase 2 consumers.
  async exchangeAuthCode(code: string, redirectUri: string): Promise<TrueLayerTokenResponse> {
    return TrueLayerClient.exchangeAuthCode({ credentials: this.credentials, code, redirectUri });
  }

  async refreshAccessToken(refreshToken: string): Promise<TrueLayerTokenResponse> {
    return TrueLayerClient.refreshAccessToken({ credentials: this.credentials, refreshToken });
  }

  // ---------- Data endpoints ----------

  async getMe(accessToken?: string): Promise<TrueLayerMeResponse> {
    return this.requestJson<TrueLayerMeResponse>('GET', '/me', {
      accessTokenOverride: accessToken,
    });
  }

  async getAccounts(accessToken?: string): Promise<TrueLayerAccountsResponse> {
    return this.requestJson<TrueLayerAccountsResponse>('GET', '/accounts', {
      accessTokenOverride: accessToken,
    });
  }

  async getAccountBalance(
    accountId: string,
    accessToken?: string,
  ): Promise<TrueLayerBalanceResponse> {
    return this.requestJson<TrueLayerBalanceResponse>(
      'GET',
      `/accounts/${encodeURIComponent(accountId)}/balance`,
      { accessTokenOverride: accessToken },
    );
  }

  async getAccountTransactions(
    accountId: string,
    range: TrueLayerDateRange = {},
    accessToken?: string,
  ): Promise<TrueLayerTransactionsResponse> {
    const path = withDateRange(`/accounts/${encodeURIComponent(accountId)}/transactions`, range);
    return this.requestJson<TrueLayerTransactionsResponse>('GET', path, {
      accessTokenOverride: accessToken,
    });
  }

  async getPendingTransactions(
    accountId: string,
    accessToken?: string,
  ): Promise<TrueLayerTransactionsResponse> {
    return this.requestJson<TrueLayerTransactionsResponse>(
      'GET',
      `/accounts/${encodeURIComponent(accountId)}/transactions/pending`,
      { accessTokenOverride: accessToken },
    );
  }

  async getCards(accessToken?: string): Promise<TrueLayerCardsResponse> {
    return this.requestJson<TrueLayerCardsResponse>('GET', '/cards', {
      accessTokenOverride: accessToken,
    });
  }

  async getCardBalance(
    cardId: string,
    accessToken?: string,
  ): Promise<TrueLayerCardBalanceResponse> {
    return this.requestJson<TrueLayerCardBalanceResponse>(
      'GET',
      `/cards/${encodeURIComponent(cardId)}/balance`,
      { accessTokenOverride: accessToken },
    );
  }

  async getCardTransactions(
    cardId: string,
    range: TrueLayerDateRange = {},
    accessToken?: string,
  ): Promise<TrueLayerTransactionsResponse> {
    const path = withDateRange(`/cards/${encodeURIComponent(cardId)}/transactions`, range);
    return this.requestJson<TrueLayerTransactionsResponse>('GET', path, {
      accessTokenOverride: accessToken,
    });
  }

  // ---------- Internals ----------

  private async getValidAccessToken(): Promise<string> {
    if (!this.tokens) {
      this.tokens = await this.store.load();
    }
    if (this.tokens.expiresAtMs - this.nowFn() <= TOKEN_REFRESH_SKEW_MS) {
      const refreshed = await this.refreshTokens();
      return refreshed.accessToken;
    }
    return this.tokens.accessToken;
  }

  private async refreshTokens(): Promise<TokenBundle> {
    if (this.refreshing) return this.refreshing;
    const refreshToken = this.tokens?.refreshToken;
    if (!refreshToken) {
      throw new AuthError('No refresh token available; re-link the connection.');
    }
    this.refreshing = (async () => {
      try {
        const resp = await TrueLayerClient.refreshAccessToken({
          credentials: this.credentials,
          refreshToken,
          fetch: this.fetchImpl,
        });
        const bundle: TokenBundle = {
          accessToken: resp.access_token,
          refreshToken: resp.refresh_token ?? refreshToken,
          expiresAtMs: this.nowFn() + resp.expires_in * 1000,
        };
        this.tokens = bundle;
        await this.store.save(bundle);
        return bundle;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private async requestJson<T>(
    method: string,
    path: string,
    opts: { accessTokenOverride?: string } = {},
  ): Promise<T> {
    const url = `${DATA_BASE}${path}`;
    let attempt = 0;
    let refreshedOnce = false;
    let accessToken = opts.accessTokenOverride ?? (await this.getValidAccessToken());

    while (true) {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
        },
      });
      if (res.ok) {
        return (await res.json()) as T;
      }

      // 401 → refresh once and retry, otherwise mark needs-reauth and bail.
      if (res.status === 401) {
        if (refreshedOnce || opts.accessTokenOverride) {
          await this.store.markNeedsReauth().catch(() => undefined);
          throw new AuthError(
            `TrueLayer ${method} ${path} returned 401 after refresh; connection needs re-consent.`,
          );
        }
        refreshedOnce = true;
        const fresh = await this.refreshTokens();
        accessToken = fresh.accessToken;
        continue;
      }

      // 403 → forbidden, no retry. Don't auto-mark needs-reauth here: a 403
      // on an optional endpoint (e.g. /cards when cards scope wasn't granted)
      // does NOT mean the whole connection is dead. The caller has endpoint
      // context and will decide whether to bubble this up or swallow it.
      if (res.status === 403) {
        const text = await safeReadText(res);
        throw new AuthError(
          `TrueLayer ${method} ${path} forbidden (403): ${truncate(text, 300)}. Re-link required.`,
        );
      }

      // 429 → respect Retry-After then back off.
      if (res.status === 429) {
        if (attempt >= this.maxRetries) {
          throw new RateLimitError(
            `TrueLayer ${method} ${path} rate-limited (429) after ${this.maxRetries} retries.`,
          );
        }
        const retryAfterHeader = res.headers.get('retry-after');
        const retryAfterMs = parseRetryAfter(retryAfterHeader);
        const backoff = retryAfterMs ?? this.backoff(attempt);
        await this.sleepFn(backoff);
        attempt += 1;
        continue;
      }

      // 501 → provider doesn't implement this endpoint (e.g. Amex has no
      // /accounts, only /cards). Terminal and non-retryable. Throw a tagged
      // error so callers can recognize it and fall through to a sibling
      // endpoint instead of treating the whole connection as broken.
      if (res.status === 501) {
        const text = await safeReadText(res);
        const parsed = safeParseJson<TrueLayerErrorBody>(text);
        const detail = parsed?.error_description ?? parsed?.message ?? text;
        throw new EndpointNotSupportedError(
          `TrueLayer ${method} ${path} not supported by provider: ${truncate(detail, 300)}`,
        );
      }

      // 5xx → exponential backoff with jitter.
      if (res.status >= 500 && res.status < 600) {
        if (attempt >= this.maxRetries) {
          const text = await safeReadText(res);
          throw new NetworkError(
            `TrueLayer ${method} ${path} failed (${res.status}) after ${this.maxRetries} retries: ${truncate(text, 300)}`,
          );
        }
        await this.sleepFn(this.backoff(attempt));
        attempt += 1;
        continue;
      }

      // Other 4xx → terminal.
      const text = await safeReadText(res);
      const parsed = safeParseJson<TrueLayerErrorBody>(text);
      const detail = parsed?.error_description ?? parsed?.message ?? text;
      throw new NetworkError(
        `TrueLayer ${method} ${path} failed (${res.status}): ${truncate(detail, 300)}`,
      );
    }
  }

  private backoff(attempt: number): number {
    const expo = BACKOFF_BASE_MS * 2 ** attempt;
    const jitter = expo * this.randomFn();
    return Math.round(expo + jitter);
  }
}

// ---------- Helpers ----------

function withDateRange(path: string, range: TrueLayerDateRange): string {
  if (!range.from && !range.to) return path;
  const params = new URLSearchParams();
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}${params.toString()}`;
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  // Could be an HTTP-date.
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function safeParseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}...`;
}
