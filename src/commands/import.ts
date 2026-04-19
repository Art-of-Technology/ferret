import { defineCommand } from 'citty';
import { appendAuditEvent } from '../lib/audit';
import { ValidationError } from '../lib/errors';
import {
  BANK_FORMATS,
  type BankFormat,
  DEFAULT_PREVIEW_ROWS,
  parseImport,
} from '../services/importers';

export default defineCommand({
  meta: { name: 'import', description: 'Import transactions from CSV' },
  args: {
    file: { type: 'positional', description: 'Path to CSV file', required: true },
    format: {
      type: 'string',
      description: `Force format (${BANK_FORMATS.join('|')})`,
    },
    account: { type: 'string', description: 'Attach to specific account id' },
    'dry-run': { type: 'boolean', description: 'Preview without writing' },
    'dedupe-strategy': {
      type: 'string',
      description: 'strict | loose (default strict)',
    },
    'preview-rows': {
      type: 'string',
      description: `Number of rows shown under --dry-run (default ${DEFAULT_PREVIEW_ROWS})`,
    },
  },
  run({ args }) {
    const file = String(args.file);
    const formatArg = args.format ? String(args.format).toLowerCase() : undefined;
    if (formatArg && !BANK_FORMATS.includes(formatArg as BankFormat)) {
      throw new ValidationError(
        `Unknown format: ${formatArg}. Supported: ${BANK_FORMATS.join(', ')}.`,
      );
    }
    const dedupeArg = args['dedupe-strategy']
      ? String(args['dedupe-strategy']).toLowerCase()
      : undefined;
    if (dedupeArg && dedupeArg !== 'strict' && dedupeArg !== 'loose') {
      throw new ValidationError(`Invalid dedupe strategy: ${dedupeArg}. Use 'strict' or 'loose'.`);
    }

    let previewRows: number | undefined;
    if (args['preview-rows'] !== undefined) {
      const n = Number.parseInt(String(args['preview-rows']), 10);
      if (!Number.isFinite(n) || n < 0) {
        throw new ValidationError(
          `Invalid --preview-rows: ${String(args['preview-rows'])}. Expected a non-negative integer.`,
        );
      }
      previewRows = n;
    }

    const result = parseImport(file, {
      format: formatArg as BankFormat | undefined,
      account: args.account ? String(args.account) : undefined,
      dryRun: Boolean(args['dry-run']),
      dedupeStrategy: (dedupeArg ?? 'strict') as 'strict' | 'loose',
      previewRows,
    });

    const banner = result.dryRun ? '[dry-run] ' : '';
    process.stdout.write(
      `${banner}format=${result.format} account=${result.accountId} parsed=${result.parsed} inserted=${result.inserted} duplicates=${result.duplicates}\n`,
    );

    // Audit trail: completion is only recorded for real runs (not dry-run).
    // Per issue #48 we log counts only — never the filename / absolute path.
    if (!result.dryRun) {
      appendAuditEvent('import.completed', {
        format: result.format,
        rows_added: result.inserted,
        rows_duplicate: result.duplicates,
      });
    }

    if (result.dryRun && result.preview.length > 0) {
      process.stdout.write('preview:\n');
      for (const tx of result.preview) {
        const iso = tx.date.toISOString().slice(0, 10);
        const amt = formatAmount(tx.amount);
        const cur = tx.currency ?? 'GBP';
        process.stdout.write(`  ${iso}  ${amt} ${cur}  ${tx.description}\n`);
      }
    }
  },
});

function formatAmount(n: number): string {
  const sign = n < 0 ? '-' : ' ';
  return `${sign}${Math.abs(n).toFixed(2).padStart(9, ' ')}`;
}
