import { describe, expect, test } from 'bun:test';
import {
  type FetchLike,
  type TokenBundle,
  type TokenStore,
  TrueLayerClient,
} from '../../src/services/truelayer';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

interface ScriptedResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function mockFetch(responses: ScriptedResponse[]): { fetch: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: input.toString(), init });
    const next = queue.shift();
    if (!next) {
      throw new Error(`No scripted response for ${input.toString()}`);
    }
    const status = next.status ?? 200;
    const body = typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {});
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
    });
  };
  return { fetch: fetchImpl, calls };
}

class StubStore implements TokenStore {
  reauthCalls = 0;
  saved: TokenBundle[] = [];
  constructor(public bundle: TokenBundle) {}
  async load() {
    return this.bundle;
  }
  async save(b: TokenBundle) {
    this.saved.push(b);
    this.bundle = b;
  }
  async markNeedsReauth() {
    this.reauthCalls += 1;
  }
}

const credentials = { clientId: 'cid', clientSecret: 'csec' };

function freshBundle(overrides: Partial<TokenBundle> = {}): TokenBundle {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAtMs: Date.now() + 60 * 60 * 1000,
    ...overrides,
  };
}

describe('TrueLayerClient', () => {
  test('parses /accounts response', async () => {
    const store = new StubStore(freshBundle());
    const accounts = [
      {
        account_id: 'a1',
        account_type: 'TRANSACTION',
        display_name: 'Lloyds Current',
        currency: 'GBP',
        provider: { provider_id: 'uk-ob-lloyds', display_name: 'Lloyds' },
        account_number: { sort_code: '12-34-56', number: '12345678' },
      },
    ];
    const { fetch, calls } = mockFetch([{ body: { results: accounts } }]);
    const client = new TrueLayerClient({ credentials, store, fetch });
    const resp = await client.getAccounts();
    expect(resp.results).toHaveLength(1);
    expect(resp.results[0]?.account_id).toBe('a1');
    expect(calls[0]?.url).toContain('/data/v1/accounts');
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe(
      'Bearer access-1',
    );
  });

  test('parses /accounts/:id/balance response', async () => {
    const store = new StubStore(freshBundle());
    const { fetch } = mockFetch([
      { body: { results: [{ currency: 'GBP', current: 1234.56, available: 1200 }] } },
    ]);
    const client = new TrueLayerClient({ credentials, store, fetch });
    const resp = await client.getAccountBalance('a1');
    expect(resp.results[0]?.current).toBe(1234.56);
  });

  test('passes from/to as query params on transactions endpoint', async () => {
    const store = new StubStore(freshBundle());
    const { fetch, calls } = mockFetch([{ body: { results: [] } }]);
    const client = new TrueLayerClient({ credentials, store, fetch });
    await client.getAccountTransactions('a1', { from: '2026-01-01', to: '2026-02-01' });
    expect(calls[0]?.url).toContain('from=2026-01-01');
    expect(calls[0]?.url).toContain('to=2026-02-01');
  });

  test('refreshes on 401 then retries the original request', async () => {
    const store = new StubStore(freshBundle({ accessToken: 'stale' }));
    const { fetch, calls } = mockFetch([
      { status: 401, body: { error: 'unauthorized' } },
      // refresh response (POST /connect/token)
      {
        body: {
          access_token: 'fresh',
          refresh_token: 'r2',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      },
      // retried original request
      { body: { results: [] } },
    ]);
    const client = new TrueLayerClient({ credentials, store, fetch, sleep: async () => {} });
    await client.getAccounts();
    expect(calls).toHaveLength(3);
    expect(calls[1]?.url).toContain('/connect/token');
    expect(store.saved[0]?.accessToken).toBe('fresh');
    expect((calls[2]?.init?.headers as Record<string, string>).authorization).toBe('Bearer fresh');
  });

  test('on second 401 surfaces AuthError and marks needs_reauth', async () => {
    const store = new StubStore(freshBundle({ accessToken: 'stale' }));
    const { fetch } = mockFetch([
      { status: 401, body: { error: 'unauthorized' } },
      {
        body: {
          access_token: 'fresh',
          refresh_token: 'r2',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      },
      { status: 401, body: { error: 'unauthorized again' } },
    ]);
    const client = new TrueLayerClient({ credentials, store, fetch, sleep: async () => {} });
    await expect(client.getAccounts()).rejects.toThrow(/needs re-consent/);
    expect(store.reauthCalls).toBe(1);
  });

  test('marks connection needing re-consent on 403 (no retry)', async () => {
    const store = new StubStore(freshBundle());
    const { fetch, calls } = mockFetch([{ status: 403, body: { error: 'forbidden' } }]);
    const client = new TrueLayerClient({ credentials, store, fetch });
    await expect(client.getAccounts()).rejects.toThrow(/forbidden/);
    expect(store.reauthCalls).toBe(1);
    expect(calls).toHaveLength(1);
  });

  test('retries on 429 respecting Retry-After (seconds), then succeeds', async () => {
    const store = new StubStore(freshBundle());
    const sleeps: number[] = [];
    const { fetch, calls } = mockFetch([
      { status: 429, headers: { 'retry-after': '2' }, body: { error: 'slow down' } },
      { body: { results: [] } },
    ]);
    const client = new TrueLayerClient({
      credentials,
      store,
      fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0,
    });
    await client.getAccounts();
    expect(calls).toHaveLength(2);
    expect(sleeps[0]).toBe(2000);
  });

  test('retries on 5xx with exponential backoff (250ms base)', async () => {
    const store = new StubStore(freshBundle());
    const sleeps: number[] = [];
    const { fetch, calls } = mockFetch([
      { status: 503, body: { error: 'down' } },
      { status: 503, body: { error: 'down' } },
      { body: { results: [] } },
    ]);
    const client = new TrueLayerClient({
      credentials,
      store,
      fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0, // jitter contribution = 0
    });
    await client.getAccounts();
    expect(calls).toHaveLength(3);
    // attempt 0: base * 2^0 = 250ms; attempt 1: base * 2^1 = 500ms (no jitter w/ random=0)
    expect(sleeps).toEqual([250, 500]);
  });

  test('gives up after maxRetries on persistent 5xx', async () => {
    const store = new StubStore(freshBundle());
    const { fetch } = mockFetch([
      { status: 500, body: { error: 'boom' } },
      { status: 500, body: { error: 'boom' } },
      { status: 500, body: { error: 'boom' } },
      { status: 500, body: { error: 'boom' } },
    ]);
    const client = new TrueLayerClient({
      credentials,
      store,
      fetch,
      sleep: async () => {},
      random: () => 0,
    });
    await expect(client.getAccounts()).rejects.toThrow(/after 3 retries/);
  });

  test('proactively refreshes when token is within skew window', async () => {
    const store = new StubStore(freshBundle({ expiresAtMs: Date.now() + 30_000 /* < 60s skew */ }));
    const { fetch, calls } = mockFetch([
      // refresh
      {
        body: {
          access_token: 'fresh',
          refresh_token: 'r2',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      },
      // original
      { body: { results: [] } },
    ]);
    const client = new TrueLayerClient({ credentials, store, fetch });
    await client.getAccounts();
    expect(calls[0]?.url).toContain('/connect/token');
    expect(store.saved[0]?.accessToken).toBe('fresh');
  });

  test('exchangeAuthCode posts the right form fields', async () => {
    const { fetch, calls } = mockFetch([
      {
        body: {
          access_token: 'a',
          refresh_token: 'r',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      },
    ]);
    const resp = await TrueLayerClient.exchangeAuthCode({
      credentials,
      code: 'AUTHCODE',
      redirectUri: 'http://localhost:8765/callback',
      fetch,
    });
    expect(resp.access_token).toBe('a');
    const body = (calls[0]?.init?.body as string) ?? '';
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code=AUTHCODE');
    expect(body).toContain('client_id=cid');
    expect(body).toContain('client_secret=csec');
  });

  test('parses transactions response with merchant + amount fields', async () => {
    const store = new StubStore(freshBundle());
    const { fetch } = mockFetch([
      {
        body: {
          results: [
            {
              transaction_id: 't1',
              timestamp: '2026-04-01T10:00:00Z',
              description: 'PRET A MANGER',
              amount: -4.5,
              currency: 'GBP',
              transaction_type: 'DEBIT',
              merchant_name: 'Pret A Manger',
            },
          ],
        },
      },
    ]);
    const client = new TrueLayerClient({ credentials, store, fetch });
    const resp = await client.getAccountTransactions('a1');
    expect(resp.results[0]?.merchant_name).toBe('Pret A Manger');
    expect(resp.results[0]?.amount).toBe(-4.5);
  });
});
