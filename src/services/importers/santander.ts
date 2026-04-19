// Santander CSV parser.
//
// TODO: validate against real export.
//
// Santander UK exports are unusual: their downloadable .txt/.csv format begins
// with a metadata block (From: ... To: ... Account: ... ) followed by
// per-transaction blocks separated by blank lines:
//   Date: 31/03/2026
//   Description: GROCERIES
//   Amount: -45.20
//   Balance: 1234.56
//
// We support BOTH this block format AND a plainer comma-separated header form
// (Date,Description,Amount,Balance) in case the user pre-converts the export.
//
// Date format: dd/MM/yyyy.
// Sign convention: signed amount, debits negative.

import { ValidationError } from '../../lib/errors';
import { type ParsedTransaction, parseCsv } from './index';
import { parseFloatSafe, parseUkDate } from './uk-date';

export function parseSantander(raw: string): ParsedTransaction[] {
  // Detect block format vs CSV format. Block format has lines like "Date:" and
  // "Amount:" not in CSV header form.
  const looksLikeBlocks = /\bAmount:/i.test(raw) && /\bDate:/i.test(raw);
  if (looksLikeBlocks) {
    return parseBlocks(raw);
  }
  return parseCsvForm(raw);
}

function parseBlocks(raw: string): ParsedTransaction[] {
  const out: ParsedTransaction[] = [];
  const lines = raw.split(/\r?\n/);
  let date: Date | null = null;
  let description = '';
  let amount: number | null = null;

  const flush = () => {
    if (date && amount !== null) {
      out.push({ date, amount, description, currency: 'GBP' });
    }
    date = null;
    description = '';
    amount = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }
    const m = /^([A-Za-z][A-Za-z ]*?):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = (m[1] as string).trim().toLowerCase();
    const value = (m[2] as string).trim();

    switch (key) {
      case 'date':
        date = parseUkDate(value, 'Santander');
        break;
      case 'description':
        description = value;
        break;
      case 'amount':
        amount = parseFloatSafe(value, 'Santander');
        break;
      default:
        // Ignore Balance, From, To, Account, etc.
        break;
    }
  }
  flush();
  return out;
}

function parseCsvForm(raw: string): ParsedTransaction[] {
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
    throw new ValidationError('Santander parser: header row not found');
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
    if (!dateStr) continue;
    out.push({
      date: parseUkDate(dateStr, 'Santander'),
      amount: parseFloatSafe((row[idx.amount] ?? '').trim(), 'Santander', i + 1),
      description: (row[idx.description] ?? '').trim(),
      currency: 'GBP',
    });
  }
  return out;
}
