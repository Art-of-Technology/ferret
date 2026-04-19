// Import service: format detection + orchestration for CSV imports.
//
// PRD §4.7: supports Lloyds, NatWest, HSBC, Barclays, Santander, Revolut.
// Format auto-detection via header signature matching, with --format override.
// Dedupe against existing transactions via hash of (date, amount, description)
// when no provider transaction id exists.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { and, eq, gte, lte } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { getDb } from '../../db/client';
import { accounts, transactions } from '../../db/schema';
import * as schema from '../../db/schema';
import { DataIntegrityError, ValidationError } from '../../lib/errors';
import { parseBarclays } from './barclays';
import { buildStrictIndex, isDuplicate, isDuplicateStrict } from './dedupe';
import { parseHsbc } from './hsbc';
import { parseLloyds } from './lloyds';
import { parseNatwest } from './natwest';
import { parseRevolut } from './revolut';
import { parseSantander } from './santander';

export type BankFormat = 'lloyds' | 'natwest' | 'hsbc' | 'barclays' | 'santander' | 'revolut';

export const BANK_FORMATS: readonly BankFormat[] = [
  'lloyds',
  'natwest',
  'hsbc',
  'barclays',
  'santander',
  'revolut',
] as const;

export interface ParsedTransaction {
  date: Date;
  amount: number; // outflow negative, inflow positive (normalized)
  description: string;
  currency?: string; // defaults to GBP if absent
}

export interface ImportOptions {
  format?: BankFormat;
  account?: string;
  dryRun?: boolean;
  dedupeStrategy?: 'strict' | 'loose';
  /** Cap on the number of preview rows returned in dry-run output. Default 10. */
  previewRows?: number;
}

/** Default cap for dry-run preview rows when previewRows is not set. */
export const DEFAULT_PREVIEW_ROWS = 10;

/** Days of fuzz on either side of the import batch's date range when narrowing
 *  the dedupe candidate set. Loose mode tolerates ±1 day; we double it for
 *  safety and to absorb any out-of-order rows the bank may emit. */
const DEDUPE_DATE_FUZZ_DAYS = 7;
const DEDUPE_DATE_FUZZ_MS = DEDUPE_DATE_FUZZ_DAYS * 24 * 60 * 60 * 1000;

/** Multi-row INSERT chunk size. SQLite tolerates much larger but Drizzle's
 *  parameter binding gets sluggish past a few hundred rows per statement. */
const INSERT_CHUNK_SIZE = 500;

export interface ImportResult {
  format: BankFormat;
  accountId: string;
  parsed: number;
  inserted: number;
  duplicates: number;
  preview: ParsedTransaction[];
  dryRun: boolean;
}

/**
 * Strip a UTF-8 BOM if present.
 */
export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Pure-TS RFC-4180-light CSV parser.
 *
 * - Handles quoted fields (double quotes around field).
 * - Handles commas inside quoted fields.
 * - Handles escaped double quotes ("") inside quoted fields.
 * - Handles \r\n, \n, and \r row terminators.
 * - Trims a UTF-8 BOM at the start of the input.
 * - Returns rows as string[][]. Empty trailing newline is ignored.
 */
export function parseCsv(input: string): string[][] {
  const src = stripBom(input);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = src.length;

  while (i < len) {
    const ch = src[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < len && src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      // Treat \r or \r\n as row terminator.
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (i + 1 < len && src[i + 1] === '\n') i += 2;
      else i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // Flush trailing field/row if present.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop a single empty trailing row (from a final newline).
  if (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last && last.length === 1 && last[0] === '') rows.pop();
  }
  return rows;
}

/**
 * Detect the bank format from a CSV header line.
 *
 * Returns null when no signature matches. Caller must then either ask the user
 * to specify --format or fail with ValidationError.
 */
export function detectFormat(headerLine: string): BankFormat | null {
  const normalized = stripBom(headerLine).toLowerCase().replace(/\s+/g, ' ').trim();

  // Lloyds: "Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance"
  if (
    normalized.includes('transaction date') &&
    normalized.includes('debit amount') &&
    normalized.includes('credit amount') &&
    normalized.includes('sort code')
  ) {
    return 'lloyds';
  }

  // NatWest: "Date, Type, Description, Value, Balance, Account Name, Account Number"
  // We require 'description' AND 'value' AND 'account number' AND a literal
  // 'type' column header. The prior signature only required date + account
  // name/number + value, which was loose enough to match generic ledger
  // exports that happened to share those column names.
  const hasTypeCol =
    normalized.includes(',type,') ||
    normalized.startsWith('type,') ||
    normalized.endsWith(',type') ||
    normalized.includes(', type,');
  if (
    normalized.includes('date') &&
    normalized.includes('description') &&
    normalized.includes('value') &&
    normalized.includes('account number') &&
    hasTypeCol
  ) {
    return 'natwest';
  }

  // HSBC: "Date,Description,Amount,Balance" or with extra Type column.
  if (
    normalized.startsWith('date,') &&
    normalized.includes('description') &&
    normalized.includes('amount') &&
    normalized.includes('balance') &&
    !normalized.includes('account name') &&
    !normalized.includes('sort code') &&
    !normalized.includes('value') &&
    !normalized.includes('subcategory') &&
    !normalized.includes('memo')
  ) {
    return 'hsbc';
  }

  // Barclays: "Number,Date,Account,Amount,Subcategory,Memo"
  if (normalized.includes('subcategory') && normalized.includes('memo')) {
    return 'barclays';
  }

  // Santander: "Date: 01/01/2026" header style is unusual. Their CSV (when
  // exported) typically has: "Date,Description,Amount,Balance" prefixed by
  // "From: ... To: ..." metadata. We rely on the literal "From:" prefix or the
  // word "Santander" appearing in the file.
  if (
    normalized.startsWith('from:') ||
    normalized.startsWith('"from:') ||
    normalized.includes('santander')
  ) {
    return 'santander';
  }

  // Revolut: "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance"
  if (
    normalized.includes('started date') &&
    normalized.includes('completed date') &&
    normalized.includes('amount') &&
    normalized.includes('currency')
  ) {
    return 'revolut';
  }

  return null;
}

const PARSERS: Record<BankFormat, (raw: string) => ParsedTransaction[]> = {
  lloyds: parseLloyds,
  natwest: parseNatwest,
  hsbc: parseHsbc,
  barclays: parseBarclays,
  santander: parseSantander,
  revolut: parseRevolut,
};

/**
 * Compute a stable id for a CSV-imported transaction. Uses a SHA-256 hash of
 * (accountId, iso-date, amount, description). This becomes the dedupe key.
 */
export function transactionHashId(
  accountId: string,
  date: Date,
  amount: number,
  description: string,
): string {
  const iso = date.toISOString().slice(0, 10); // yyyy-MM-dd
  const canon = `${accountId}|${iso}|${amount.toFixed(2)}|${description.trim().toLowerCase()}`;
  return `csv_${createHash('sha256').update(canon).digest('hex').slice(0, 32)}`;
}

interface OrchestrateDeps {
  db?: BunSQLiteDatabase<typeof schema>;
}

/**
 * Orchestrate the full import: read file, detect format, parse, ensure account,
 * dedupe, insert. Wrapped in a single DB transaction.
 */
export function parseImport(
  filepath: string,
  opts: ImportOptions = {},
  deps: OrchestrateDeps = {},
): ImportResult {
  if (!existsSync(filepath)) {
    throw new ValidationError(`File not found: ${filepath}`);
  }
  const raw = readFileSync(filepath, 'utf-8');
  return runImport(raw, opts, deps);
}

/**
 * Same as parseImport but accepts the file contents directly (useful for tests).
 */
export function runImport(
  raw: string,
  opts: ImportOptions = {},
  deps: OrchestrateDeps = {},
): ImportResult {
  const stripped = stripBom(raw);
  const lines = stripped.split(/\r?\n/);
  const headerLine = lines.find((l) => l.trim().length > 0) ?? '';

  const format = opts.format ?? detectFormat(headerLine);
  if (!format) {
    throw new ValidationError(
      'Unable to detect CSV format. Use --format <bank> to specify (lloyds, natwest, hsbc, barclays, santander, revolut).',
    );
  }
  if (!BANK_FORMATS.includes(format)) {
    throw new ValidationError(`Unknown format: ${format}. Supported: ${BANK_FORMATS.join(', ')}.`);
  }

  const parser = PARSERS[format];
  const parsed = parser(stripped);

  const dedupeStrategy: 'strict' | 'loose' = opts.dedupeStrategy ?? 'strict';
  if (dedupeStrategy !== 'strict' && dedupeStrategy !== 'loose') {
    throw new ValidationError(
      `Invalid dedupe strategy: ${dedupeStrategy}. Use 'strict' or 'loose'.`,
    );
  }

  const db = deps.db ?? getDb().db;

  // Resolve target account (or create a virtual manual account).
  const accountId = opts.dryRun
    ? (opts.account ?? 'manual:dry-run')
    : ensureAccount(db, opts.account, format);

  // Validate every parsed row up front so the date-window narrowing below
  // doesn't see NaN timestamps.
  for (const tx of parsed) {
    if (Number.isNaN(tx.date.getTime())) {
      throw new DataIntegrityError(
        `Parsed transaction has invalid date: ${tx.description} / ${String(tx.amount)}`,
      );
    }
    if (!Number.isFinite(tx.amount)) {
      throw new DataIntegrityError(
        `Parsed transaction has non-finite amount: ${tx.description} / ${String(tx.amount)}`,
      );
    }
  }

  // Narrow the dedupe candidate set to the import batch's date range ±
  // DEDUPE_DATE_FUZZ_DAYS. Without this we previously fetched every
  // transaction for the account and compared each parsed row against all of
  // them — O(parsed × existing). Now both modes get a bounded window, and
  // strict mode further uses an O(1) hash index.
  let existingForDedupe: Array<{ id: string; date: Date; amount: number; description: string }> =
    [];
  if (parsed.length > 0) {
    let minTs = Number.POSITIVE_INFINITY;
    let maxTs = Number.NEGATIVE_INFINITY;
    for (const tx of parsed) {
      const t = tx.date.getTime();
      if (t < minTs) minTs = t;
      if (t > maxTs) maxTs = t;
    }
    const fromDate = new Date(minTs - DEDUPE_DATE_FUZZ_MS);
    const toDate = new Date(maxTs + DEDUPE_DATE_FUZZ_MS);
    const existing = db
      .select({
        id: transactions.id,
        timestamp: transactions.timestamp,
        amount: transactions.amount,
        description: transactions.description,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.accountId, accountId),
          gte(transactions.timestamp, fromDate),
          lte(transactions.timestamp, toDate),
        ),
      )
      .all();
    existingForDedupe = existing.map((row) => ({
      id: row.id,
      date: row.timestamp,
      amount: row.amount,
      description: row.description,
    }));
  }

  // Strict mode uses an O(1) hash lookup over the narrowed window. Loose mode
  // still iterates so it can apply substring / Levenshtein matching, but only
  // over the narrowed window (typically a few dozen rows, not the full table).
  const strictIndex = dedupeStrategy === 'strict' ? buildStrictIndex(existingForDedupe) : null;

  let inserted = 0;
  let duplicates = 0;
  const toInsert: Array<typeof transactions.$inferInsert> = [];
  const seenIds = new Set<string>();

  for (const tx of parsed) {
    const id = transactionHashId(accountId, tx.date, tx.amount, tx.description);
    if (seenIds.has(id)) {
      duplicates += 1;
      continue;
    }
    seenIds.add(id);

    const candidate = { id, date: tx.date, amount: tx.amount, description: tx.description };
    const isDup = strictIndex
      ? isDuplicateStrict(candidate, strictIndex)
      : isDuplicate(candidate, existingForDedupe, dedupeStrategy);
    if (isDup) {
      duplicates += 1;
      continue;
    }

    toInsert.push({
      id,
      accountId,
      timestamp: tx.date,
      amount: tx.amount,
      currency: tx.currency ?? 'GBP',
      description: tx.description,
      transactionType: tx.amount < 0 ? 'DEBIT' : 'CREDIT',
      isPending: false,
      metadata: { source: 'csv', format },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    inserted += 1;
  }

  if (!opts.dryRun && toInsert.length > 0) {
    // Batch into chunked multi-row INSERTs. SQLite executes one statement per
    // chunk (vs one per row), which is materially faster on large imports.
    db.transaction((tx) => {
      for (let i = 0; i < toInsert.length; i += INSERT_CHUNK_SIZE) {
        const chunk = toInsert.slice(i, i + INSERT_CHUNK_SIZE);
        tx.insert(transactions).values(chunk).run();
      }
    });
  }

  const previewCap = Math.max(0, opts.previewRows ?? DEFAULT_PREVIEW_ROWS);
  return {
    format,
    accountId,
    parsed: parsed.length,
    inserted: opts.dryRun ? 0 : inserted,
    duplicates,
    preview: previewCap === 0 ? [] : parsed.slice(0, previewCap),
    dryRun: Boolean(opts.dryRun),
  };
}

/**
 * Ensure an account exists for the import target. If `accountId` is provided,
 * verify it exists. Otherwise create (or reuse) a virtual manual account for
 * the given format.
 */
function ensureAccount(
  db: BunSQLiteDatabase<typeof schema>,
  accountId: string | undefined,
  format: BankFormat,
): string {
  if (accountId) {
    const found = db.select().from(accounts).where(eq(accounts.id, accountId)).all();
    if (found.length === 0) {
      throw new ValidationError(`Account not found: ${accountId}`);
    }
    return accountId;
  }

  // Reuse an existing manual account for this format if present.
  const manualId = `manual:${format}`;
  const existing = db.select().from(accounts).where(eq(accounts.id, manualId)).all();
  if (existing.length > 0) return manualId;

  // Create a virtual connection + account for manual imports.
  const connectionId = `manual:${format}`;
  const now = new Date();
  // Insert connection (idempotent via INSERT OR IGNORE-style: we check first).
  db.transaction((tx) => {
    const conns = tx
      .select()
      .from(schema.connections)
      .where(eq(schema.connections.id, connectionId))
      .all();
    if (conns.length === 0) {
      tx.insert(schema.connections)
        .values({
          id: connectionId,
          providerId: `manual-${format}`,
          providerName: format.charAt(0).toUpperCase() + format.slice(1),
          createdAt: now,
          // Virtual connection: keep it active forever (no PSD2 expiry for CSV).
          expiresAt: new Date(now.getTime() + 100 * 365 * 24 * 60 * 60 * 1000),
          status: 'active',
        })
        .run();
    }
    tx.insert(accounts)
      .values({
        id: manualId,
        connectionId,
        accountType: 'TRANSACTION',
        displayName: `${format.charAt(0).toUpperCase() + format.slice(1)} (manual)`,
        currency: 'GBP',
        isManual: true,
      })
      .run();
  });

  return manualId;
}
