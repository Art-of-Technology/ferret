// `ferret rules` — manage regex categorization rules per PRD §7.1.
//
// Subcommands:
//   - rules list                        Tabular view sorted by priority DESC
//   - rules add <pattern> <category>    Validate regex + category, assign next slot
//   - rules rm <id>                     Remove by id
//
// Pattern matching is case-insensitive at apply time (see services/categorize.ts);
// the validator here uses the same flag so users see the same behaviour at add
// time as at tag time.

import { randomUUID } from 'node:crypto';
import { defineCommand } from 'citty';
import consola from 'consola';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { categoryExists, getNextRulePriority, getRules } from '../db/queries/categorize';
import { rules } from '../db/schema';
import { ValidationError } from '../lib/errors';
import { formatTable } from '../lib/format';

const VALID_FIELDS = new Set(['merchant', 'description']);

export default defineCommand({
  meta: { name: 'rules', description: 'Manage categorization rules' },
  subCommands: {
    list: defineCommand({
      meta: { name: 'list', description: 'List rules ordered by priority' },
      run() {
        const all = getRules();
        if (all.length === 0) {
          process.stdout.write('no rules defined\n');
          return;
        }
        const display = all.map((r) => ({
          id: r.id,
          pattern: r.pattern,
          field: r.field,
          category: r.category,
          priority: r.priority,
        }));
        process.stdout.write(`${formatTable(display)}\n`);
      },
    }),
    add: defineCommand({
      meta: { name: 'add', description: 'Add a categorization rule' },
      args: {
        pattern: { type: 'positional', description: 'Regex pattern', required: true },
        category: { type: 'positional', description: 'Target category', required: true },
        field: {
          type: 'string',
          description: 'Field to match against (merchant|description)',
          default: 'merchant',
        },
        priority: { type: 'string', description: 'Priority (higher wins; default = next slot)' },
      },
      run({ args }) {
        const pattern = String(args.pattern);
        const category = String(args.category);
        const field = String(args.field ?? 'merchant');

        if (!VALID_FIELDS.has(field)) {
          throw new ValidationError(`--field must be 'merchant' or 'description', got "${field}".`);
        }
        // Validate-only compile: we do NOT cache the compiled RegExp.
        // The pattern lives in SQLite as a string and gets compiled at
        // apply time (`services/categorize.ts > applyRules`); caching
        // across processes would be pointless and caching in this same
        // process is wasted work since `rules add` exits immediately.
        // We just want the user to see "bad regex" up front rather than
        // at the next `tag`.
        try {
          new RegExp(pattern, 'i');
        } catch (err) {
          throw new ValidationError(
            `Invalid regex pattern "${pattern}": ${(err as Error).message}`,
          );
        }
        if (!categoryExists(category)) {
          throw new ValidationError(`Unknown category: "${category}". Check the categories table.`);
        }

        let priority: number;
        if (typeof args.priority === 'string' && args.priority.length > 0) {
          const n = Number.parseInt(args.priority, 10);
          if (!Number.isFinite(n)) {
            throw new ValidationError(`--priority must be an integer, got "${args.priority}".`);
          }
          priority = n;
        } else {
          priority = getNextRulePriority();
        }

        const id = randomUUID();
        const { db } = getDb();
        db.insert(rules)
          .values({
            id,
            pattern,
            field,
            category,
            priority,
            createdAt: new Date(),
          })
          .run();
        consola.success(
          `added rule ${id} (priority ${priority}): /${pattern}/i on ${field} -> ${category}`,
        );
      },
    }),
    rm: defineCommand({
      meta: { name: 'rm', description: 'Remove a rule by id' },
      args: {
        id: { type: 'positional', description: 'Rule id', required: true },
      },
      run({ args }) {
        const id = String(args.id);
        const { db } = getDb();
        const existing = db.select().from(rules).where(eq(rules.id, id)).all();
        if (existing.length === 0) {
          throw new ValidationError(`No rule found with id "${id}".`);
        }
        db.delete(rules).where(eq(rules.id, id)).run();
        consola.success(`removed rule ${id}`);
      },
    }),
  },
  // Mirror the budget command pattern: citty 0.1.6 invokes the parent run
  // even after a subcommand has matched, so we detect and bail.
  run({ rawArgs }) {
    const SUBCOMMANDS = new Set(['list', 'add', 'rm']);
    const first = rawArgs.find((a) => !a.startsWith('-'));
    if (first && SUBCOMMANDS.has(first)) return;
    process.stdout.write('usage: ferret rules <list|add|rm>\n');
  },
});
