import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { type BunSQLiteDatabase, drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema';

export const FERRET_HOME = join(process.env.HOME ?? homedir(), '.ferret');
export const DB_PATH = join(FERRET_HOME, 'ferret.db');

let cached: { db: BunSQLiteDatabase<typeof schema>; raw: Database } | null = null;

export function getDb(dbPath: string = DB_PATH): {
  db: BunSQLiteDatabase<typeof schema>;
  raw: Database;
} {
  if (cached && cached.raw.filename === dbPath) return cached;

  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const fresh = !existsSync(dbPath);
  const raw = new Database(dbPath, { create: true });

  if (fresh) {
    try {
      chmodSync(dbPath, 0o600);
    } catch {
      // best-effort on platforms that don't support chmod (e.g. Windows)
    }
  }

  raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec('PRAGMA foreign_keys = ON;');

  const db = drizzle(raw, { schema });
  cached = { db, raw };
  return cached;
}

export function resetDbCache(): void {
  cached = null;
}

export const db: BunSQLiteDatabase<typeof schema> = new Proxy(
  {} as BunSQLiteDatabase<typeof schema>,
  {
    get(_target, prop, receiver) {
      const real = getDb().db as unknown as Record<string | symbol, unknown>;
      const value = real[prop as string | symbol];
      if (typeof value === 'function') {
        return (value as (...args: unknown[]) => unknown).bind(real);
      }
      return value;
    },
  },
);
