import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  accountNames,
  deleteAllForConnection,
  deleteToken,
  getToken,
  type KeychainBackend,
  SERVICE,
  setKeychainBackend,
  setToken,
} from '../../src/services/keychain';

class InMemoryKeychain implements KeychainBackend {
  private store = new Map<string, string>(); // key = `${service}::${account}`

  private k(service: string, account: string): string {
    return `${service}::${account}`;
  }

  async setPassword(service: string, account: string, password: string): Promise<void> {
    this.store.set(this.k(service, account), password);
  }

  async getPassword(service: string, account: string): Promise<string | null> {
    return this.store.get(this.k(service, account)) ?? null;
  }

  async deletePassword(service: string, account: string): Promise<boolean> {
    return this.store.delete(this.k(service, account));
  }

  async findCredentials(service: string): Promise<Array<{ account: string; password: string }>> {
    const prefix = `${service}::`;
    const out: Array<{ account: string; password: string }> = [];
    for (const [k, v] of this.store) {
      if (k.startsWith(prefix)) out.push({ account: k.slice(prefix.length), password: v });
    }
    return out;
  }
}

describe('keychain wrapper', () => {
  let backend: InMemoryKeychain;
  beforeEach(() => {
    backend = new InMemoryKeychain();
    setKeychainBackend(backend);
  });
  afterEach(() => {
    setKeychainBackend(null);
  });

  test('setToken / getToken round-trips', async () => {
    await setToken('truelayer:abc:access', 'shh');
    expect(await getToken('truelayer:abc:access')).toBe('shh');
  });

  test('getToken returns null when not set', async () => {
    expect(await getToken('missing')).toBeNull();
  });

  test('deleteToken removes the entry', async () => {
    await setToken('x', '1');
    expect(await deleteToken('x')).toBe(true);
    expect(await getToken('x')).toBeNull();
    expect(await deleteToken('x')).toBe(false);
  });

  test('account name helpers follow PRD §9.1 convention', () => {
    expect(accountNames.access('CONN-1')).toBe('truelayer:CONN-1:access');
    expect(accountNames.refresh('CONN-1')).toBe('truelayer:CONN-1:refresh');
    expect(accountNames.trueLayerClientSecret).toBe('truelayer:client_secret');
    expect(accountNames.anthropicApiKey).toBe('anthropic:api_key');
  });

  test('deleteAllForConnection removes only that connection’s entries', async () => {
    await setToken(accountNames.access('a'), 'a-access');
    await setToken(accountNames.refresh('a'), 'a-refresh');
    await setToken(accountNames.expiry('a'), '1');
    await setToken(accountNames.access('b'), 'b-access');
    await setToken(accountNames.trueLayerClientSecret, 'cs');

    const removed = await deleteAllForConnection('a');
    expect(removed).toBe(3);

    expect(await getToken(accountNames.access('a'))).toBeNull();
    expect(await getToken(accountNames.refresh('a'))).toBeNull();
    expect(await getToken(accountNames.access('b'))).toBe('b-access');
    expect(await getToken(accountNames.trueLayerClientSecret)).toBe('cs');
  });

  test('SERVICE constant is the canonical "ferret"', () => {
    expect(SERVICE).toBe('ferret');
  });
});
