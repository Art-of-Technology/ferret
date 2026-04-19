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
import { parseFloatSafe, parseUkDate } from './uk-date';

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

    const date = parseUkDate(dateStr, 'Lloyds');
    const debit = parseFloatSafe(debitStr, 'Lloyds', i + 1);
    const credit = parseFloatSafe(creditStr, 'Lloyds', i + 1);

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
