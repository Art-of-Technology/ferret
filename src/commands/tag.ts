// `ferret tag` — categorize transactions per PRD §4.4.
//
// Surface:
//   - `ferret tag`               process uncategorized only
//   - `ferret tag --retag`       wipe cache+claude assignments, re-run pipeline
//   - `ferret tag <id> <cat>`    manual override (also seeds merchant cache)
//   - `ferret tag --dry-run`     preview without writing
//   - `ferret tag --no-claude`   rule + cache only (per #18 risk mitigation)

import { defineCommand } from 'citty';
import consola from 'consola';
import pc from 'picocolors';
import {
  applyCategoryAssignments,
  categoryExists,
  clearAutoCategorizations,
  getTransactionById,
  listAllNonManualTransactions,
  listCategoryNames,
  listUncategorizedTransactions,
  upsertMerchantCacheEntry,
} from '../db/queries/categorize';
import { loadConfig } from '../lib/config';
import { ConfigError, ValidationError } from '../lib/errors';
import { formatTable } from '../lib/format';
import { ANTHROPIC_API_KEY, tryResolveSecret } from '../lib/secrets';
import {
  type PipelineAssignment,
  type SourceCounts,
  categorizeBatch,
  normalizeMerchant,
  toTxnUpdates,
} from '../services/categorize';
import { ClaudeClient } from '../services/claude';

export default defineCommand({
  meta: { name: 'tag', description: 'Categorize transactions (rules + cache + Claude)' },
  args: {
    txnId: {
      type: 'positional',
      description: 'Transaction id (manual override)',
      required: false,
    },
    category: {
      type: 'positional',
      description: 'Category name (manual override)',
      required: false,
    },
    retag: { type: 'boolean', description: 'Reclassify all non-manual rows' },
    'dry-run': { type: 'boolean', description: 'Preview classifications without writing' },
    // citty parses `--no-X` as `X = false`, so we expose the user-facing
    // `--no-claude` flag by declaring `claude` (default true) and checking
    // `!args.claude` below. The help text reflects the user-facing form.
    claude: {
      type: 'boolean',
      description: 'Use Claude for unmatched merchants (default true; pass --no-claude to disable)',
      default: true,
    },
  },
  async run({ args }) {
    const dryRun = Boolean(args['dry-run']);
    const noClaude = args.claude === false;
    const retag = Boolean(args.retag);

    // Manual override path. citty surfaces missing positionals as undefined.
    const txnId = typeof args.txnId === 'string' ? args.txnId : undefined;
    const category = typeof args.category === 'string' ? args.category : undefined;
    if (txnId && category) {
      await runManualOverride(txnId, category, dryRun);
      return;
    }
    if (txnId && !category) {
      throw new ValidationError(
        'Manual override requires both <txn_id> and <category>; missing <category>.',
      );
    }

    if (retag) {
      const cleared = dryRun ? 0 : clearAutoCategorizations();
      if (!dryRun) {
        consola.info(`reset ${cleared} auto-categorized rows (manual + rule preserved)`);
      } else {
        consola.info('dry-run: skipped wiping cache+claude rows');
      }
    }

    const uncategorized = retag ? listAllNonManualTransactions() : listUncategorizedTransactions();
    if (uncategorized.length === 0) {
      consola.success('nothing to categorize');
      return;
    }

    const availableCategories = listCategoryNames();
    if (availableCategories.length === 0) {
      throw new ConfigError('No categories defined. Run `ferret init` to seed defaults.');
    }

    let claude: ClaudeClient | undefined;
    if (!noClaude) {
      const key = await tryResolveSecret(ANTHROPIC_API_KEY);
      if (!key) {
        consola.warn(
          'ANTHROPIC_API_KEY not set — falling back to rule + cache only. Pass --no-claude to silence this.',
        );
      } else {
        const cfg = loadConfig();
        claude = new ClaudeClient({ apiKey: key, model: cfg.claude.model });
      }
    }

    const result = await categorizeBatch(uncategorized, {
      claude,
      noClaude,
      availableCategories,
    });

    // Print summary + per-row table.
    consola.info(`processed ${uncategorized.length} transactions`);
    process.stdout.write(`${renderCounts(result.used)}\n`);
    process.stdout.write(`${renderAssignmentTable(result.categorized)}\n`);

    if (dryRun) {
      consola.info('dry-run: no writes performed');
      return;
    }

    const updates = toTxnUpdates(result);
    if (updates.length > 0) {
      applyCategoryAssignments(updates);
    }
    consola.success(
      `wrote ${updates.length} category assignments (${result.used.uncategorized} left as Uncategorized)`,
    );
  },
});

async function runManualOverride(txnId: string, category: string, dryRun: boolean): Promise<void> {
  if (!categoryExists(category)) {
    throw new ValidationError(
      `Unknown category: "${category}". Run \`ferret config\` or check the categories table.`,
    );
  }
  const txn = getTransactionById(txnId);
  if (!txn) {
    throw new ValidationError(`No transaction found with id "${txnId}".`);
  }

  if (dryRun) {
    consola.info(
      `dry-run: would set ${txnId} -> ${category} (source=manual) and seed merchant cache`,
    );
    return;
  }

  applyCategoryAssignments([{ transactionId: txnId, category, source: 'manual' }]);

  // Per PRD §4.4 note: "manual override creates merchant cache entry".
  const key = normalizeMerchant(txn.merchantName ?? txn.description);
  if (key.length > 0) {
    upsertMerchantCacheEntry({
      normalized: key,
      category,
      confidence: 1,
      source: 'manual',
    });
  }
  consola.success(`tagged ${txnId} -> ${category} (manual; merchant cache updated)`);
}

function renderCounts(c: SourceCounts): string {
  const parts: string[] = [];
  parts.push(pc.bold('source counts:'));
  parts.push(`  manual:        ${c.manual}`);
  parts.push(`  rule:          ${c.rule}`);
  parts.push(`  cache:         ${c.cache}`);
  parts.push(`  claude:        ${c.claude}`);
  parts.push(`  uncategorized: ${c.uncategorized}`);
  return parts.join('\n');
}

function renderAssignmentTable(rows: PipelineAssignment[]): string {
  if (rows.length === 0) return 'no assignments';
  const display = rows.slice(0, 200).map((r) => ({
    txn: r.transactionId,
    category: r.category,
    source: r.source,
    confidence: r.confidence === undefined ? '' : r.confidence.toFixed(2),
  }));
  const table = formatTable(display);
  if (rows.length > display.length) {
    return `${table}\n  (+${rows.length - display.length} more rows)`;
  }
  return table;
}
