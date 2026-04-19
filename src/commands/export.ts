import { defineCommand } from 'citty';
import { and, eq, gte, lte } from 'drizzle-orm';
import { getDb } from '../db/client';
import { accounts, transactions } from '../db/schema';
import { ValidationError } from '../lib/errors';

type ExportFormat = 'csv' | 'json';

interface ExportRow {
  id: string;
  account_id: string;
  account_name: string | null;
  source: string;
  timestamp: string;
  amount: number;
  currency: string;
  description: string;
  merchant_name: string | null;
  transaction_type: string | null;
  category: string | null;
  category_source: string | null;
  provider_category: string | null;
  running_balance: number | null;
  is_pending: boolean;
}

export default defineCommand({
  meta: { name: 'export', description: 'Export transactions as CSV or JSON' },
  args: {
    format: { type: 'string', description: 'csv | json (default csv)' },
    since: { type: 'string', description: 'Lower-bound date (yyyy-MM-dd)' },
    until: { type: 'string', description: 'Upper-bound date (yyyy-MM-dd)' },
    category: { type: 'string', description: 'Filter by category' },
  },
  run({ args }) {
    const formatArg = args.format ? String(args.format).toLowerCase() : 'csv';
    if (formatArg !== 'csv' && formatArg !== 'json') {
      throw new ValidationError(`Invalid format: ${formatArg}. Use 'csv' or 'json'.`);
    }
    const format: ExportFormat = formatArg as ExportFormat;

    const since = args.since ? parseIsoDate(String(args.since), 'since') : undefined;
    const until = args.until ? parseIsoDate(String(args.until), 'until', true) : undefined;
    const category = args.category ? String(args.category) : undefined;

    const { db } = getDb();

    const conditions = [];
    if (since) conditions.push(gte(transactions.timestamp, since));
    if (until) conditions.push(lte(transactions.timestamp, until));
    if (category) conditions.push(eq(transactions.category, category));

    const baseQuery = db
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        accountName: accounts.displayName,
        isManual: accounts.isManual,
        timestamp: transactions.timestamp,
        amount: transactions.amount,
        currency: transactions.currency,
        description: transactions.description,
        merchantName: transactions.merchantName,
        transactionType: transactions.transactionType,
        category: transactions.category,
        categorySource: transactions.categorySource,
        providerCategory: transactions.providerCategory,
        runningBalance: transactions.runningBalance,
        isPending: transactions.isPending,
      })
      .from(transactions)
      .leftJoin(accounts, eq(transactions.accountId, accounts.id));

    const rows =
      conditions.length > 0 ? baseQuery.where(and(...conditions)).all() : baseQuery.all();

    const out: ExportRow[] = rows.map((r) => ({
      id: r.id,
      account_id: r.accountId,
      account_name: r.accountName ?? null,
      source: r.isManual ? 'csv' : 'sync',
      timestamp: r.timestamp.toISOString(),
      amount: r.amount,
      currency: r.currency,
      description: r.description,
      merchant_name: r.merchantName ?? null,
      transaction_type: r.transactionType ?? null,
      category: r.category ?? null,
      category_source: r.categorySource ?? null,
      provider_category: r.providerCategory ?? null,
      running_balance: r.runningBalance ?? null,
      is_pending: Boolean(r.isPending),
    }));

    if (format === 'json') {
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      return;
    }

    // CSV: streaming, write header + rows.
    const headers: Array<keyof ExportRow> = [
      'id',
      'account_id',
      'account_name',
      'source',
      'timestamp',
      'amount',
      'currency',
      'description',
      'merchant_name',
      'transaction_type',
      'category',
      'category_source',
      'provider_category',
      'running_balance',
      'is_pending',
    ];
    process.stdout.write(`${headers.join(',')}\n`);
    for (const row of out) {
      const cells = headers.map((h) => csvEscape(row[h]));
      process.stdout.write(`${cells.join(',')}\n`);
    }
  },
});

function parseIsoDate(s: string, label: string, endOfDay = false): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) {
    throw new ValidationError(`Invalid --${label} date: ${s}. Expected yyyy-MM-dd.`);
  }
  const y = Number.parseInt(m[1] as string, 10);
  const mo = Number.parseInt(m[2] as string, 10);
  const d = Number.parseInt(m[3] as string, 10);
  const date = endOfDay
    ? new Date(Date.UTC(y, mo - 1, d, 23, 59, 59, 999))
    : new Date(Date.UTC(y, mo - 1, d));
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError(`Invalid --${label} date: ${s}.`);
  }
  return date;
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : String(value);
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
