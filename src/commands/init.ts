import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineCommand } from 'citty';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb, getDbPath, getFerretHome } from '../db/client';
import { categories } from '../db/schema';
import { configPath, loadConfig, writeConfig } from '../lib/config';

// Default category taxonomy from PRD §6.2 (30 entries: 9 parents + 21 children).
const DEFAULT_CATEGORIES: Array<{ name: string; parent: string | null }> = [
  { name: 'Housing', parent: null },
  { name: 'Rent/Mortgage', parent: 'Housing' },
  { name: 'Utilities', parent: 'Housing' },
  { name: 'Home Insurance', parent: 'Housing' },
  { name: 'Food', parent: null },
  { name: 'Groceries', parent: 'Food' },
  { name: 'Eating Out', parent: 'Food' },
  { name: 'Takeaway', parent: 'Food' },
  { name: 'Transport', parent: null },
  { name: 'Public Transport', parent: 'Transport' },
  { name: 'Fuel', parent: 'Transport' },
  { name: 'Ride Share', parent: 'Transport' },
  { name: 'Entertainment', parent: null },
  { name: 'Subscriptions', parent: 'Entertainment' },
  { name: 'Events', parent: 'Entertainment' },
  { name: 'Media', parent: 'Entertainment' },
  { name: 'Shopping', parent: null },
  { name: 'Clothing', parent: 'Shopping' },
  { name: 'Electronics', parent: 'Shopping' },
  { name: 'General', parent: 'Shopping' },
  { name: 'Health', parent: null },
  { name: 'Pharmacy', parent: 'Health' },
  { name: 'Gym/Fitness', parent: 'Health' },
  { name: 'Medical', parent: 'Health' },
  { name: 'Financial', parent: null },
  { name: 'Transfers', parent: 'Financial' },
  { name: 'Fees', parent: 'Financial' },
  { name: 'Interest', parent: 'Financial' },
  { name: 'Income', parent: null },
  { name: 'Salary', parent: 'Income' },
  { name: 'Freelance', parent: 'Income' },
  { name: 'Other', parent: 'Income' },
  { name: 'Uncategorized', parent: null },
];

function migrationsDir(): string {
  // src/commands/init.ts -> ../db/migrations
  const here = fileURLToPath(new URL('.', import.meta.url));
  return join(here, '..', 'db', 'migrations');
}

export default defineCommand({
  meta: { name: 'init', description: 'Initialize ~/.ferret, create DB, seed categories' },
  run() {
    const ferretHome = getFerretHome();
    const dbPath = getDbPath();
    if (!existsSync(ferretHome)) {
      mkdirSync(ferretHome, { recursive: true, mode: 0o700 });
      process.stdout.write(`created ${ferretHome}\n`);
    }

    const { db, raw } = getDb();
    const dir = migrationsDir();
    if (existsSync(dir)) {
      migrate(db, { migrationsFolder: dir });
      process.stdout.write(`migrated ${dbPath}\n`);
    } else {
      process.stdout.write(`warning: no migrations folder at ${dir}\n`);
    }

    // Seed categories. Idempotent via INSERT OR IGNORE.
    const insert = raw.prepare(
      'INSERT OR IGNORE INTO categories (name, parent, color, icon) VALUES (?, ?, NULL, NULL)',
    );
    const tx = raw.transaction((rows: Array<{ name: string; parent: string | null }>) => {
      for (const row of rows) insert.run(row.name, row.parent);
    });
    tx(DEFAULT_CATEGORIES);
    process.stdout.write(`seeded ${DEFAULT_CATEGORIES.length} categories\n`);

    if (!existsSync(configPath())) {
      writeConfig(loadConfig());
      process.stdout.write(`wrote ${configPath()}\n`);
    }

    // touch ref so unused import is not flagged
    void categories;
  },
});
