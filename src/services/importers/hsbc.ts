// HSBC CSV parser.
//
// TODO: validate against real export.
//
// Best-effort header (HSBC UK personal banking statement download):
//   Date,Description,Amount,Balance
// Some exports also include a "Type" column. We tolerate both.
//
// Date format: dd/MM/yyyy.
// Sign convention: HSBC uses a single signed Amount column where debits are
// negative. Pass through.

import { ValidationError } from '../../lib/errors';
import { type ParsedTransaction, parseCsv } from './index';

export function parseHsbc(raw: string): ParsedTransaction[] {
  const rows = parseCsv(raw);
  if (rows.length === 0) return [];

  let headerIdx = -1;
  let headers: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const lower = row.map((c) => c.trim().toLowerCase());
    if (lower.includes('date') && lower.includes('description') && lower.includes('amount')) {
      headerIdx = i;
      headers = lower;
      break;
    }
  }
  if (headerIdx === -1) {
    throw new ValidationError('HSBC parser: header row not found');
  }

  const idx = {
    date: headers.indexOf('date'),
    description: headers.indexOf('description'),
    amount: headers.indexOf('amount'),
  };

  const out: ParsedTransaction[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((c) => c.trim() === '')) continue;

    const dateStr = (row[idx.date] ?? '').trim();
    const description = (row[idx.description] ?? '').trim();
    const amountStr = (row[idx.amount] ?? '').trim();
    if (!dateStr) continue;

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
  if (!m) throw new ValidationError(`HSBC parser: invalid date '${s}'`);
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
