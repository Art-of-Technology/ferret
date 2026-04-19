// HSBC CSV parser.
//
// TODO(#27): validate against real export.
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
import { parseFloatSafe, parseUkDate } from './uk-date';

const PARSER_NAME = 'HSBC';

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
    throw new ValidationError(`${PARSER_NAME} parser: header row not found`);
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
      date: parseUkDate(dateStr, PARSER_NAME),
      amount: parseFloatSafe(amountStr, PARSER_NAME, i + 1),
      description,
      currency: 'GBP',
    });
  }
  return out;
}
