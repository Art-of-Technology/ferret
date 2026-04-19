// Barclays CSV parser.
//
// TODO: validate against real export.
//
// Best-effort header (Barclays online banking statement download):
//   Number,Date,Account,Amount,Subcategory,Memo
//
// Date format: dd/MM/yyyy.
// Sign convention: Barclays uses a single signed Amount column where debits
// are negative. Pass through.
// Description is sourced from the Memo column.

import { ValidationError } from '../../lib/errors';
import { type ParsedTransaction, parseCsv } from './index';

export function parseBarclays(raw: string): ParsedTransaction[] {
  const rows = parseCsv(raw);
  if (rows.length === 0) return [];

  let headerIdx = -1;
  let headers: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const lower = row.map((c) => c.trim().toLowerCase());
    if (lower.includes('memo') && lower.includes('amount') && lower.includes('date')) {
      headerIdx = i;
      headers = lower;
      break;
    }
  }
  if (headerIdx === -1) {
    throw new ValidationError('Barclays parser: header row not found');
  }

  const idx = {
    date: headers.indexOf('date'),
    amount: headers.indexOf('amount'),
    memo: headers.indexOf('memo'),
    subcategory: headers.indexOf('subcategory'),
  };

  const out: ParsedTransaction[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((c) => c.trim() === '')) continue;

    const dateStr = (row[idx.date] ?? '').trim();
    const amountStr = (row[idx.amount] ?? '').trim();
    const memo = (row[idx.memo] ?? '').trim();
    const sub = idx.subcategory !== -1 ? (row[idx.subcategory] ?? '').trim() : '';
    if (!dateStr) continue;

    const description = memo || sub;
    out.push({
      date: parseUkDate(dateStr),
      amount: parseFloatSafe(amountStr),
      description,
      currency: 'GBP',
    });
  }
  return out;
}

function parseUkDate(s: string): Date {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (!m) throw new ValidationError(`Barclays parser: invalid date '${s}'`);
  const day = Number.parseInt(m[1] as string, 10);
  const month = Number.parseInt(m[2] as string, 10);
  let year = Number.parseInt(m[3] as string, 10);
  if (year < 100) year += 2000;
  return new Date(Date.UTC(year, month - 1, day));
}

function parseFloatSafe(s: string): number {
  if (!s) return 0;
  const cleaned = s.replace(/[£,]/g, '').trim();
  if (!cleaned) return 0;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}
