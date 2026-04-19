// Test preload: swaps the real OS keychain for an in-memory stub seeded from
// the `FERRET_TEST_KEYCHAIN_SEED` env var (JSON array of {account, password}).
//
// Loaded via `bun --preload <thisfile>` from the integration test so spawned
// `ferret` subprocesses never touch the real OS keychain. Production code
// paths are untouched.

import { setKeychainBackend } from '../../src/services/keychain';
import { InMemoryKeychain } from '../helpers/in-memory-keychain';

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
