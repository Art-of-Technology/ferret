import { defineCommand } from 'citty';
import { ValidationError } from '../lib/errors';
import { BANK_FORMATS, type BankFormat, parseImport } from '../services/importers';

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

    const result = parseImport(file, {
      format: formatArg as BankFormat | undefined,
      account: args.account ? String(args.account) : undefined,
      dryRun: Boolean(args['dry-run']),
      dedupeStrategy: (dedupeArg ?? 'strict') as 'strict' | 'loose',
    });

    const banner = result.dryRun ? '[dry-run] ' : '';
    process.stdout.write(
      `${banner}format=${result.format} account=${result.accountId} parsed=${result.parsed} inserted=${result.inserted} duplicates=${result.duplicates}\n`,
    );

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
