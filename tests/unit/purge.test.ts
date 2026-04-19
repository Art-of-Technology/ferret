import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import purgeCmd from '../../src/commands/purge';
import { getDb, getDbPath, getFerretHome, resetDbCache } from '../../src/db/client';
import { accounts, connections, rules, transactions } from '../../src/db/schema';
import { ValidationError } from '../../src/lib/errors';
import { type KeychainBackend, setKeychainBackend } from '../../src/services/keychain';

class InMemoryKeychain implements KeychainBackend {
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

function migrationsDir(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  return resolve(here, '..', '..', 'src', 'db', 'migrations');
}

// citty passes this shape to `run`. We bypass the CLI parser and call `run`
// directly for unit coverage of the purge logic itself.
type PurgeArgs = {
  confirm?: boolean;
  'keep-config'?: boolean;
  'keep-rules'?: boolean;
};

async function runPurge(args: PurgeArgs): Promise<void> {
  // citty's CommandContext shape is wider than what purge.run actually
  // consumes (only `args`). Narrow cast keeps the unit test decoupled from
  // the full citty generic chain.
  const run = purgeCmd.run as unknown as (ctx: { args: PurgeArgs }) => Promise<void>;
  await run({ args });
}

function seed(): { keychain: InMemoryKeychain } {
  // Fresh DB + schema.
  const { db, raw } = getDb();
  migrate(db, { migrationsFolder: migrationsDir() });

  const now = new Date();
  raw
    .prepare(
      `INSERT INTO connections (id, provider_id, provider_name, created_at, expires_at, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'c1',
      'prov',
      'Test Bank',
      Math.floor(now.getTime() / 1000),
      Math.floor(now.getTime() / 1000) + 86400,
      'active',
    );
  raw
    .prepare(
      `INSERT INTO accounts (id, connection_id, account_type, display_name, currency)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run('a1', 'c1', 'TRANSACTION', 'Current', 'GBP');
  raw
    .prepare(
      `INSERT INTO transactions (id, account_id, timestamp, amount, currency, description,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      't1',
      'a1',
      Math.floor(now.getTime() / 1000),
      -9.99,
      'GBP',
      'test',
      Math.floor(now.getTime() / 1000),
      Math.floor(now.getTime() / 1000),
    );
  raw
    .prepare(
      `INSERT INTO rules (id, pattern, field, category, priority, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('r1', 'tesco', 'merchant', 'Groceries', 1, Math.floor(now.getTime() / 1000));

  const keychain = new InMemoryKeychain();
  setKeychainBackend(keychain);
  return { keychain };
}

describe('ferret purge', () => {
  let prevHome: string | undefined;
  let tmp: string;

  beforeEach(() => {
    prevHome = process.env.HOME;
    tmp = mkdtempSync(join(tmpdir(), 'ferret-purge-'));
    process.env.HOME = tmp;
    resetDbCache();
  });

  afterEach(() => {
    setKeychainBackend(null);
    resetDbCache();
    if (tmp) {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    if (prevHome === undefined) {
      process.env.HOME = '';
    } else {
      process.env.HOME = prevHome;
    }
  });

  test('refuses without --confirm and throws ValidationError', async () => {
    seed();
    await expect(runPurge({})).rejects.toBeInstanceOf(ValidationError);

    // Nothing should have been deleted.
    const { db } = getDb();
    expect(db.select().from(connections).all().length).toBe(1);
    expect(db.select().from(transactions).all().length).toBe(1);
  });

  test('--confirm wipes DB, keychain, config by default', async () => {
    const { keychain } = seed();
    await keychain.setPassword('ferret', 'truelayer:c1:access', 'tok-a');
    await keychain.setPassword('ferret', 'anthropic:api_key', 'sk-ant-xxx');

    writeFileSync(join(getFerretHome(), 'config.json'), '{}');

    await runPurge({ confirm: true });

    // DB file is gone.
    expect(existsSync(getDbPath())).toBe(false);
    // Keychain wiped.
    expect(keychain.size()).toBe(0);
    // Config removed.
    expect(existsSync(join(getFerretHome(), 'config.json'))).toBe(false);

    // Re-open a fresh DB and ensure tables would be empty after re-migrating.
    resetDbCache();
    const { db: db2, raw: raw2 } = getDb();
    migrate(db2, { migrationsFolder: migrationsDir() });
    expect(db2.select().from(connections).all().length).toBe(0);
    expect(db2.select().from(accounts).all().length).toBe(0);
    expect(db2.select().from(transactions).all().length).toBe(0);
    // categories table is seeded by `init`, so untouched post-migration = 0.
    const catCount = raw2.prepare('SELECT COUNT(*) as n FROM categories').get() as {
      n: number;
    };
    expect(catCount.n).toBe(0);
  });

  test('--keep-config preserves config.json', async () => {
    seed();
    const cfgPath = join(getFerretHome(), 'config.json');
    writeFileSync(cfgPath, '{"currency":"GBP"}');

    await runPurge({ confirm: true, 'keep-config': true });

    expect(existsSync(cfgPath)).toBe(true);
    expect(existsSync(getDbPath())).toBe(false);
  });

  test('--keep-rules dumps rules JSON to stdout before deleting', async () => {
    seed();
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    type Writer = typeof process.stdout.write;
    const capture: Writer = ((chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    }) as Writer;
    process.stdout.write = capture;
    try {
      await runPurge({ confirm: true, 'keep-rules': true });
    } finally {
      process.stdout.write = originalWrite;
    }

    const out = chunks.join('');
    expect(out).toContain('tesco');
    expect(out).toContain('Groceries');

    // Rules table is empty post-purge (since DB is gone and re-created empty).
    resetDbCache();
    const { db: db2 } = getDb();
    migrate(db2, { migrationsFolder: migrationsDir() });
    expect(db2.select().from(rules).all().length).toBe(0);
  });

  test('runs cleanly on a fresh ~/.ferret with no DB', async () => {
    // No seed — nothing on disk.
    setKeychainBackend(new InMemoryKeychain());
    await runPurge({ confirm: true });
    // Just needs to not throw and print a summary.
    expect(existsSync(getDbPath())).toBe(false);
  });
});
