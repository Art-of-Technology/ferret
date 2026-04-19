// Thin wrapper around `keytar` per PRD §9.1.
//
// All secrets live under service "ferret". Account names follow the convention:
//   - truelayer:{connection_id}:access
//   - truelayer:{connection_id}:refresh
//   - truelayer:client_secret
//   - truelayer:client_id (optional)
//   - anthropic:api_key
//
// The underlying keytar module is loaded dynamically so tests can swap it out
// via `setKeychainBackend`. We never log token values.

import { ConfigError } from '../lib/errors';

export const SERVICE = 'ferret';

export interface KeychainBackend {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials(service: string): Promise<Array<{ account: string; password: string }>>;
}

let backend: KeychainBackend | null = null;
let loadAttempted = false;

async function getBackend(): Promise<KeychainBackend> {
  if (backend) return backend;
  if (loadAttempted) {
    throw new ConfigError('Keychain backend unavailable.');
  }
  try {
    // Dynamic import keeps this module test-friendly: if keytar fails to load
    // (no native binding for current platform), we surface a typed error.
    // Only flip `loadAttempted` AFTER a successful import so a transient
    // failure (e.g. ENOENT for native binding mid-install) can be retried by
    // a subsequent call instead of being permanently latched.
    const mod = (await import('keytar')) as unknown as KeychainBackend & {
      default?: KeychainBackend;
    };
    backend = mod.default ?? mod;
    loadAttempted = true;
    return backend;
  } catch (err) {
    throw new ConfigError(
      `Failed to load OS keychain (keytar): ${(err as Error).message}. On linux, ensure libsecret-1-dev is installed.`,
    );
  }
}

/** Test/CI only: inject a stub backend. */
export function setKeychainBackend(stub: KeychainBackend | null): void {
  backend = stub;
  loadAttempted = stub !== null;
}

export async function setToken(account: string, value: string): Promise<void> {
  const b = await getBackend();
  await b.setPassword(SERVICE, account, value);
}

export async function getToken(account: string): Promise<string | null> {
  const b = await getBackend();
  return b.getPassword(SERVICE, account);
}

export async function deleteToken(account: string): Promise<boolean> {
  const b = await getBackend();
  return b.deletePassword(SERVICE, account);
}

/** Removes every keychain entry for a given connection id. Returns the count deleted. */
export async function deleteAllForConnection(connectionId: string): Promise<number> {
  const b = await getBackend();
  const all = await b.findCredentials(SERVICE);
  const prefix = `truelayer:${connectionId}:`;
  let deleted = 0;
  for (const cred of all) {
    if (cred.account.startsWith(prefix)) {
      const ok = await b.deletePassword(SERVICE, cred.account);
      if (ok) deleted += 1;
    }
  }
  return deleted;
}

// Helpers to construct canonical account names.
export const accountNames = {
  access: (connectionId: string): string => `truelayer:${connectionId}:access`,
  refresh: (connectionId: string): string => `truelayer:${connectionId}:refresh`,
  expiry: (connectionId: string): string => `truelayer:${connectionId}:expires_at`,
  trueLayerClientSecret: 'truelayer:client_secret',
  anthropicApiKey: 'anthropic:api_key',
} as const;
