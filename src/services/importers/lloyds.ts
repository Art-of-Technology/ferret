// Lloyds CSV parser.
//
// Header (verified, lloydsbank.com personal current account export):
//   Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance
//
// Date format: dd/MM/yyyy.
// Sign convention: Lloyds splits debits and credits into two columns. We
// normalize: debit -> negative, credit -> positive, single 'amount' field.

import { ValidationError } from '../../lib/errors';
import { type ParsedTransaction, parseCsv } from './index';

const HEADER_INDEXES = {
  date: 0,
  type: 1,
  sortCode: 2,
  accountNumber: 3,
  description: 4,
  debit: 5,
  credit: 6,
  balance: 7,
} as const;

export function parseLloyds(raw: string): ParsedTransaction[] {
  const rows = parseCsv(raw);
  if (rows.length === 0) return [];

  // Locate header row (skip blank leading rows if any).
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row?.some((c) => c.toLowerCase().includes('transaction date'))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    throw new ValidationError('Lloyds parser: header row not found');
  }

  const out: ParsedTransaction[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((c) => c.trim() === '')) continue;
    if (row.length < 7) continue;

    const dateStr = (row[HEADER_INDEXES.date] ?? '').trim();
    const description = (row[HEADER_INDEXES.description] ?? '').trim();
    const debitStr = (row[HEADER_INDEXES.debit] ?? '').trim();
    const creditStr = (row[HEADER_INDEXES.credit] ?? '').trim();

    if (!dateStr) continue;

    const date = parseUkDate(dateStr);
    const debit = parseFloatSafe(debitStr);
    const credit = parseFloatSafe(creditStr);

    let amount = 0;
    if (debit > 0) amount = -debit;
    else if (credit > 0) amount = credit;
    else amount = 0;

    out.push({
      date,
      amount,
      description,
      currency: 'GBP',
    });
  }
  return out;
}

function parseUkDate(s: string): Date {
  // dd/MM/yyyy
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (!m) throw new ValidationError(`Lloyds parser: invalid date '${s}'`);
  const day = Number.parseInt(m[1] as string, 10);
  const month = Number.parseInt(m[2] as string, 10);
  let year = Number.parseInt(m[3] as string, 10);
  if (year < 100) year += 2000;
  // Construct as UTC midnight to avoid timezone drift.
  return new Date(Date.UTC(year, month - 1, day));
}

function parseFloatSafe(s: string): number {
  if (!s) return 0;
  const cleaned = s.replace(/[£,]/g, '').trim();
  if (!cleaned) return 0;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}
