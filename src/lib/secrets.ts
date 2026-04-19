// Resolves secrets from the OS keychain first, falling back to environment variables.
// Used for values that may live in either place per PRD §9.1:
//   - TrueLayer client_secret
//   - Anthropic API key
//
// Throws ConfigError when neither source has a value.

import { getToken } from '../services/keychain';
import { ConfigError } from './errors';

export interface SecretLookup {
  /** Keychain account name under service `ferret`. */
  keychainAccount: string;
  /** Environment variable to fall back to. */
  envVar: string;
  /** Human label used in error messages. */
  label: string;
}

export const TRUELAYER_CLIENT_ID: SecretLookup = {
  keychainAccount: 'truelayer:client_id',
  envVar: 'TRUELAYER_CLIENT_ID',
  label: 'TrueLayer client id',
};

export const TRUELAYER_CLIENT_SECRET: SecretLookup = {
  keychainAccount: 'truelayer:client_secret',
  envVar: 'TRUELAYER_CLIENT_SECRET',
  label: 'TrueLayer client secret',
};

export const ANTHROPIC_API_KEY: SecretLookup = {
  keychainAccount: 'anthropic:api_key',
  envVar: 'ANTHROPIC_API_KEY',
  label: 'Anthropic API key',
};

/**
 * Reads from the keychain, distinguishing a "miss" (returns null) from an
 * actual backend error (perm denied, daemon unavailable, native binding
 * missing). Misses fall through to the env-var path; real errors are
 * re-thrown as ConfigError so the user sees the underlying cause.
 */
async function readFromKeychain(spec: SecretLookup): Promise<string | null> {
  try {
    return await getToken(spec.keychainAccount);
  } catch (err) {
    // ConfigError already carries enough context; rethrow as-is.
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(
      `Failed to read ${spec.label} from keychain account "${spec.keychainAccount}": ${(err as Error).message}`,
    );
  }
}

/**
 * Resolves a secret. Tries the keychain first; on miss, falls back to the env var.
 * Throws ConfigError if neither source has the value, or if the keychain read
 * itself failed (rather than silently masking the failure as a miss).
 */
export async function resolveSecret(spec: SecretLookup): Promise<string> {
  const fromKeychain = await readFromKeychain(spec);
  if (fromKeychain && fromKeychain.length > 0) return fromKeychain;

  const fromEnv = process.env[spec.envVar];
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  throw new ConfigError(
    `Missing ${spec.label}. Set the ${spec.envVar} env var or store under keychain account "${spec.keychainAccount}".`,
  );
}

/** Optional variant: returns null if neither source has the value (no throw). */
export async function tryResolveSecret(spec: SecretLookup): Promise<string | null> {
  const fromKeychain = await readFromKeychain(spec);
  if (fromKeychain && fromKeychain.length > 0) return fromKeychain;
  const fromEnv = process.env[spec.envVar];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return null;
}
