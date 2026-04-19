// Barclays CSV parser.
//
// TODO(#26): validate against real export.
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
import { parseFloatSafe, parseUkDate } from './uk-date';

const PARSER_NAME = 'Barclays';

/** Synthetic placeholder when both memo and subcategory are empty. */
export const EMPTY_DESCRIPTION = '(no description)';

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
    throw new ValidationError(`${PARSER_NAME} parser: header row not found`);
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

    // Synthetic marker keeps dedupe keys distinct for rows where both memo and
    // subcategory are empty. Without this, all such rows on the same date for
    // the same amount would collapse into one hash.
    const description = memo || sub || EMPTY_DESCRIPTION;
    out.push({
      date: parseUkDate(dateStr, PARSER_NAME),
      amount: parseFloatSafe(amountStr, PARSER_NAME, i + 1),
      description,
      currency: 'GBP',
    });
  }
  return out;
}
