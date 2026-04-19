// Test preload: swaps the real OS keychain for an in-memory stub seeded from
// the `FERRET_TEST_KEYCHAIN_SEED` env var (JSON array of {account, password}).
//
// Loaded via `bun --preload <thisfile>` from the integration test so spawned
// `ferret` subprocesses never touch the real OS keychain. Production code
// paths are untouched.

import { type KeychainBackend, setKeychainBackend } from '../../src/services/keychain';

class InMemoryKeychain implements KeychainBackend {
  private store = new Map<string, string>();
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

const stub = new InMemoryKeychain();
const seed = process.env.FERRET_TEST_KEYCHAIN_SEED;
if (seed) {
  try {
    const rows = JSON.parse(seed) as Array<{ account: string; password: string }>;
    for (const row of rows) {
      // Intentionally synchronous Map write — Promise.resolve not awaited.
      void stub.setPassword('ferret', row.account, row.password);
    }
  } catch {
    // Bad JSON is a test-author error; surface via failed assertions rather
    // than crashing the subprocess.
  }
}
setKeychainBackend(stub);
