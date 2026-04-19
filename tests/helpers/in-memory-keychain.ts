// Shared in-memory `KeychainBackend` used by unit and integration tests.
// Keeping a single definition here avoids the drift risk of two copies going
// out of sync with the `KeychainBackend` interface in `src/services/keychain`.

import type { KeychainBackend } from '../../src/services/keychain';

export class InMemoryKeychain implements KeychainBackend {
  private store = new Map<string, string>();

  private key(service: string, account: string): string {
    return `${service}::${account}`;
  }

  async setPassword(service: string, account: string, password: string): Promise<void> {
    this.store.set(this.key(service, account), password);
  }

  async getPassword(service: string, account: string): Promise<string | null> {
    return this.store.get(this.key(service, account)) ?? null;
  }

  async deletePassword(service: string, account: string): Promise<boolean> {
    return this.store.delete(this.key(service, account));
  }

  async findCredentials(service: string): Promise<Array<{ account: string; password: string }>> {
    const prefix = `${service}::`;
    const out: Array<{ account: string; password: string }> = [];
    for (const [k, v] of this.store) {
      if (k.startsWith(prefix)) out.push({ account: k.slice(prefix.length), password: v });
    }
    return out;
  }

  size(): number {
    return this.store.size;
  }
}
