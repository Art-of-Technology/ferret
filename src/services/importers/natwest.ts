// NatWest CSV parser.
//
// Header (verified, NatWest online banking transaction download):
//   Date, Type, Description, Value, Balance, Account Name, Account Number
//
// Date format: dd/MM/yyyy.
// Sign convention: NatWest uses a single signed 'Value' column where debits
// are already negative. We pass through.

import { ValidationError } from '../../lib/errors';
import { type ParsedTransaction, parseCsv } from './index';

export function parseNatwest(raw: string): ParsedTransaction[] {
  const rows = parseCsv(raw);
  if (rows.length === 0) return [];

  let headerIdx = -1;
  let headers: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const lower = row.map((c) => c.trim().toLowerCase());
    if (
      lower.includes('date') &&
      lower.includes('value') &&
      (lower.includes('account name') || lower.includes('account number'))
    ) {
      headerIdx = i;
      headers = lower;
      break;
    }
  }
  if (headerIdx === -1) {
    throw new ValidationError('NatWest parser: header row not found');
  }

  const idx = {
    date: headers.indexOf('date'),
    description: headers.indexOf('description'),
    value: headers.indexOf('value'),
  };
  if (idx.date === -1 || idx.description === -1 || idx.value === -1) {
    throw new ValidationError('NatWest parser: missing required columns');
  }

  const out: ParsedTransaction[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((c) => c.trim() === '')) continue;

    const dateStr = (row[idx.date] ?? '').trim();
    const description = (row[idx.description] ?? '').trim();
    const valueStr = (row[idx.value] ?? '').trim();
    if (!dateStr) continue;

    out.push({
      date: parseUkDate(dateStr),
      amount: parseFloatSafe(valueStr),
      description,
      currency: 'GBP',
    });
  }
  return out;
}

function parseUkDate(s: string): Date {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (!m) throw new ValidationError(`NatWest parser: invalid date '${s}'`);
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
