// Subprocess helper for the secret-leak integration test.
//
// Invoked via `Bun.spawnSync` with `HOME` pointing at a per-test tmp dir so
// `getDb()` resolves to that dir rather than the developer's real ~/.ferret.
// Running the seed in a child process means we never have to mutate the
// parent test runner's `process.env.HOME`, which would be hostile to any
// concurrently scheduled bun:test case.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb } from '../../src/db/client';

const here = fileURLToPath(new URL('.', import.meta.url));
const migrationsDir = resolve(here, '..', '..', 'src', 'db', 'migrations');

const { db, raw } = getDb();
migrate(db, { migrationsFolder: migrationsDir });

const now = Math.floor(Date.now() / 1000);
raw
  .prepare(
    `INSERT OR IGNORE INTO connections
       (id, provider_id, provider_name, created_at, expires_at, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
  )
  .run('seed-conn-001', 'test', 'Test Bank', now, now + 86400, 'active');
