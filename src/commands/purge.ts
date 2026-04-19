// `ferret purge` — right-to-erase per PRD §9.1 / ISO 27001 A.8.
//
// Wipes every row from every application table, clears every keychain entry
// under service `ferret`, removes the SQLite database file (and its WAL / SHM
// siblings, plus the audit log) so the raw file isn't recoverable, and —
// unless explicitly kept — deletes `~/.ferret/config.json` too.
//
// `--confirm` is mandatory. Without it we print a dry-run summary of what
// *would* be removed and exit cleanly (code 0) so the command is safe to wire
// into non-interactive scripts; the summary tells the operator to re-run with
// `--confirm` to actually execute.

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { defineCommand } from 'citty';
import consola from 'consola';
import { sql } from 'drizzle-orm';
import { getDb, getDbPath, getFerretHome, resetDbCache } from '../db/client';
import {
  accounts,
  budgets,
  categories,
  connections,
  merchantCache,
  rules,
  syncLog,
  transactions,
} from '../db/schema';
import { configPath } from '../lib/config';
import { purgeAllKeychainEntries } from '../services/keychain';

// Order matters for the live delete path: child rows before parents so FK
// constraints stay satisfied even though every table ends up empty.
const TABLES = [
  { name: 'transactions', ref: transactions },
  { name: 'accounts', ref: accounts },
  { name: 'sync_log', ref: syncLog },
  { name: 'connections', ref: connections },
  { name: 'budgets', ref: budgets },
  { name: 'rules', ref: rules },
  { name: 'merchant_cache', ref: merchantCache },
  { name: 'categories', ref: categories },
] as const;

function auditLogPath(): string {
  return join(getFerretHome(), 'audit.log');
}

function dbSidecars(dbPath: string): string[] {
  return [`${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`];
}

export default defineCommand({
  meta: {
    name: 'purge',
    description: 'Erase all Ferret-managed data (DB, keychain, audit log)',
  },
  args: {
    confirm: {
      type: 'boolean',
      description: 'Required. Without it, the command prints a dry run and exits.',
    },
    'keep-config': {
      type: 'boolean',
      description: 'Preserve ~/.ferret/config.json',
    },
    'keep-rules': {
      type: 'boolean',
      description: 'Print rules as JSON to stdout before deleting them',
    },
  },
  async run({ args }) {
    const confirm = Boolean(args.confirm);
    const keepConfig = Boolean(args['keep-config']);
    const keepRules = Boolean(args['keep-rules']);

    const ferretHome = getFerretHome();
    const dbPath = getDbPath();
    const dbExists = existsSync(dbPath);
    const auditPath = auditLogPath();
    const auditExists = existsSync(auditPath);
    const cfgPath = configPath();
    const cfgExists = existsSync(cfgPath);

    if (!confirm) {
      // Dry-run path: print a summary of what *would* happen and exit 0.
      // Non-interactive scripts can wire this in safely and branch on the
      // hint text without having to special-case a non-zero exit code.
      process.stdout.write('ferret purge (dry run — pass --confirm to execute):\n');
      process.stdout.write(`  - would remove: all rows from ${TABLES.length} tables\n`);
      process.stdout.write('  - would remove: every keychain entry under service "ferret"\n');
      process.stdout.write(
        `  - would remove: DB file ${dbPath}${dbExists ? '' : ' (not present)'}\n`,
      );
      process.stdout.write(
        `  - would remove: audit log ${auditPath}${auditExists ? '' : ' (not present)'}\n`,
      );
      process.stdout.write(
        `  - would ${keepConfig ? 'keep' : 'remove'}: config ${cfgPath}${cfgExists ? '' : ' (not present)'}\n`,
      );
      if (keepRules) {
        process.stdout.write('  - --keep-rules: rules would be JSON-dumped first\n');
      }
      process.stdout.write('run with --confirm to execute\n');
      return;
    }

    let rowsRemoved = 0;
    let tablesTouched = 0;

    if (dbExists) {
      const { db } = getDb();

      if (keepRules) {
        const existing = db.select().from(rules).all();
        // Emit the backup BEFORE any deletes so even a mid-purge crash leaves
        // the user with a recoverable rules snapshot on stdout.
        process.stdout.write(`${JSON.stringify(existing, null, 2)}\n`);
      }

      // Temporarily turn off FK enforcement so we can wipe every table in a
      // single transaction without having to respect delete order mid-statement.
      // The `try` must cover both the PRAGMA OFF *and* the transaction so that
      // a throw from either leaves the `finally` to restore PRAGMA ON. If we
      // only wrapped the transaction, an error inside `db.transaction` would
      // unwind past the PRAGMA restore on some code paths and leak the OFF
      // state into whichever process-level handle runs next.
      try {
        db.run(sql`PRAGMA foreign_keys = OFF`);
        db.transaction((tx) => {
          for (const t of TABLES) {
            const countRow = tx.select({ n: sql<number>`count(*)` }).from(t.ref).all()[0];
            const count = countRow ? Number(countRow.n) : 0;
            if (count > 0) {
              rowsRemoved += count;
              tablesTouched += 1;
            }
            tx.delete(t.ref).run();
          }
        });
      } finally {
        db.run(sql`PRAGMA foreign_keys = ON`);
      }

      // Drop the cache BEFORE removing the file so any downstream `getDb()`
      // call re-opens a fresh handle instead of pointing at a deleted inode.
      resetDbCache();
      for (const f of [dbPath, ...dbSidecars(dbPath)]) {
        if (existsSync(f)) rmSync(f, { force: true });
      }
    }

    const keychainCleared = await purgeAllKeychainEntries().catch((err) => {
      consola.warn(`Could not fully clear keychain entries: ${(err as Error).message}`);
      return 0;
    });

    if (auditExists) {
      rmSync(auditPath, { force: true });
    }
    // Best-effort: remove any rotated audit log siblings (audit.log.1, .2, …).
    if (existsSync(ferretHome)) {
      try {
        for (const name of readdirSync(ferretHome)) {
          if (name.startsWith('audit.log.')) {
            rmSync(join(ferretHome, name), { force: true });
          }
        }
      } catch {
        // Dir disappeared mid-scan — non-fatal.
      }
    }

    let configState: 'kept' | 'removed' | 'absent';
    if (!cfgExists) {
      configState = 'absent';
    } else if (keepConfig) {
      configState = 'kept';
    } else {
      rmSync(cfgPath, { force: true });
      configState = 'removed';
    }

    consola.success(
      `${rowsRemoved} rows removed across ${tablesTouched} tables, ${keychainCleared} keychain entries cleared, DB file ${dbExists ? 'removed' : 'absent'}, config ${configState}`,
    );
  },
});
