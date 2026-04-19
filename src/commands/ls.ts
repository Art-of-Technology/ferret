import { defineCommand } from 'citty';
import {
  type ListFilters,
  type ListSortField,
  listTransactions,
  type TransactionRow,
} from '../db/queries/list';
import { formatDate, parseDate, parseDuration } from '../lib/dates';
import { ValidationError } from '../lib/errors';
import { formatCsv, formatJson, formatTable, isTty } from '../lib/format';

const VALID_SORT_FIELDS: readonly ListSortField[] = ['timestamp', 'amount', 'merchant', 'category'];

export default defineCommand({
  meta: { name: 'ls', description: 'List transactions with filters' },
  args: {
    since: {
      type: 'string',
      description: 'Lower-bound date or duration (e.g. 30d, 2w, 2026-01-01)',
    },
    until: { type: 'string', description: 'Upper-bound date (yyyy-MM-dd)' },
    category: { type: 'string', description: 'Filter by category name (exact)' },
    merchant: { type: 'string', description: 'Substring match on merchant' },
    account: { type: 'string', description: 'Account id or display name' },
    min: { type: 'string', description: 'Minimum absolute amount' },
    max: { type: 'string', description: 'Maximum absolute amount' },
    incoming: { type: 'boolean', description: 'Only incoming transactions' },
    outgoing: { type: 'boolean', description: 'Only outgoing transactions' },
    limit: { type: 'string', description: 'Max rows (default 50)' },
    json: { type: 'boolean', description: 'Output JSON (stable schema)' },
    csv: { type: 'boolean', description: 'Output CSV (RFC 4180)' },
    sort: {
      type: 'string',
      description: 'Sort field (default timestamp.desc). Format: <field>[.asc|.desc]',
    },
  },
  run({ args }) {
    if (args.incoming && args.outgoing) {
      throw new ValidationError('--incoming and --outgoing are mutually exclusive');
    }

    const filters: ListFilters = {};
    if (typeof args.since === 'string' && args.since.length > 0) {
      filters.since = parseDuration(args.since);
    }
    if (typeof args.until === 'string' && args.until.length > 0) {
      filters.until = parseDate(args.until);
    }
    if (typeof args.category === 'string' && args.category.length > 0) {
      filters.category = args.category;
    }
    if (typeof args.merchant === 'string' && args.merchant.length > 0) {
      filters.merchant = args.merchant;
    }
    if (typeof args.account === 'string' && args.account.length > 0) {
      filters.accountId = args.account;
    }
    if (typeof args.min === 'string' && args.min.length > 0) {
      filters.min = parseAmount('--min', args.min);
    }
    if (typeof args.max === 'string' && args.max.length > 0) {
      filters.max = parseAmount('--max', args.max);
    }
    if (args.incoming) filters.direction = 'incoming';
    if (args.outgoing) filters.direction = 'outgoing';
    if (typeof args.limit === 'string' && args.limit.length > 0) {
      filters.limit = parseLimit(args.limit);
    }
    if (typeof args.sort === 'string' && args.sort.length > 0) {
      filters.sort = parseSort(args.sort);
    }

    const rows = listTransactions(filters);

    if (args.json) {
      // formatJson([]) emits `[]`, which is the correct empty payload.
      process.stdout.write(`${formatJson(rows.map(toSerializable))}\n`);
      return;
    }
    if (args.csv) {
      // For CSV, an empty row set should still emit the header line so
      // downstream tools can detect the columns.
      const csv = rows.length === 0 ? CSV_HEADER : formatCsv(rows.map(toSerializable));
      process.stdout.write(`${csv}\n`);
      return;
    }

    if (rows.length === 0) {
      process.stdout.write('no transactions match the given filters\n');
      return;
    }

    const display = rows.map((r) => ({
      date: formatDate(r.timestamp),
      account: r.accountName ?? r.accountId,
      merchant: r.merchantName ?? r.description,
      category: r.category ?? '',
      amount: formatAmountForRow(r.amount, r.currency),
    }));

    if (isTty()) {
      process.stdout.write(`${formatTable(display)}\n`);
    } else {
      // Plain TSV-ish output for pipes when neither --json nor --csv is set:
      // tabular but stripped of borders/colors so awk and cut stay happy.
      process.stdout.write(`${formatTable(display, { colors: false })}\n`);
    }
  },
});

function parseAmount(flag: string, raw: string): number {
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new ValidationError(`${flag} must be a non-negative number, got "${raw}"`);
  }
  return n;
}

function parseLimit(raw: string): number {
  // `Number.parseInt('3.9', 10)` would silently truncate to 3, so we route
  // through `Number()` first and require an integer result.
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new ValidationError(`--limit must be a positive integer, got "${raw}"`);
  }
  return n;
}

function parseSort(raw: string): { field: ListSortField; dir: 'asc' | 'desc' } {
  const [fieldRaw, dirRaw = 'desc'] = raw.split('.');
  const field = fieldRaw as ListSortField;
  if (!VALID_SORT_FIELDS.includes(field)) {
    throw new ValidationError(
      `Invalid --sort field "${fieldRaw ?? ''}". Allowed: ${VALID_SORT_FIELDS.join(', ')}`,
    );
  }
  if (dirRaw !== 'asc' && dirRaw !== 'desc') {
    throw new ValidationError(`Invalid --sort direction "${dirRaw}". Allowed: asc, desc`);
  }
  return { field, dir: dirRaw };
}

// Format an amount for table display without going through formatCurrency
// (which uses Intl + colors). For tables we want compact numbers and a
// currency suffix; the colored version is used in summaries.
function formatAmountForRow(amount: number, currency: string): string {
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount).toFixed(2);
  return `${sign}${abs} ${currency}`;
}

function toSerializable(row: TransactionRow): Record<string, unknown> {
  // `TransactionRow.timestamp` is typed as `Date`, so a defensive
  // `instanceof Date` branch was previously dead code.
  return {
    ...row,
    timestamp: row.timestamp.toISOString(),
  };
}

// Pre-computed CSV header line that mirrors the field order produced by
// `toSerializable`. Used when there are no rows to render so the output is
// still a valid CSV with the expected column set.
const CSV_HEADER = [
  'id',
  'accountId',
  'accountName',
  'timestamp',
  'amount',
  'currency',
  'description',
  'merchantName',
  'category',
  'transactionType',
].join(',');
