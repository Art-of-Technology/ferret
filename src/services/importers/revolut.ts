// Revolut CSV parser.
//
// Header (verified, Revolut personal account export, 2024+ format):
//   Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
//
// Date format: yyyy-MM-dd HH:mm:ss (UTC).
// Sign convention: Revolut uses signed Amount (negative = outflow). Pass through.
// Currency varies per row (multi-currency), so we surface the per-row Currency.
// State filter: only include 'COMPLETED' rows (skip PENDING/REVERTED/DECLINED).

import { ValidationError } from '../../lib/errors';
import { type ParsedTransaction, parseCsv } from './index';

export function parseRevolut(raw: string): ParsedTransaction[] {
  const rows = parseCsv(raw);
  if (rows.length === 0) return [];

  let headerIdx = -1;
  let headers: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const lower = row.map((c) => c.trim().toLowerCase());
    if (
      lower.includes('started date') &&
      lower.includes('completed date') &&
      lower.includes('amount')
    ) {
      headerIdx = i;
      headers = lower;
      break;
    }
  }
  if (headerIdx === -1) {
    throw new ValidationError('Revolut parser: header row not found');
  }

  const idx = {
    completed: headers.indexOf('completed date'),
    started: headers.indexOf('started date'),
    description: headers.indexOf('description'),
    amount: headers.indexOf('amount'),
    fee: headers.indexOf('fee'),
    currency: headers.indexOf('currency'),
    state: headers.indexOf('state'),
  };
  if (idx.amount === -1) {
    throw new ValidationError('Revolut parser: missing Amount column');
  }

  const out: ParsedTransaction[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((c) => c.trim() === '')) continue;

    if (idx.state !== -1) {
      const state = (row[idx.state] ?? '').trim().toUpperCase();
      if (state && state !== 'COMPLETED') continue;
    }

    const dateStr =
      (idx.completed !== -1 ? row[idx.completed] : undefined) ??
      (idx.started !== -1 ? row[idx.started] : undefined) ??
      '';
    const date = parseRevolutDate(String(dateStr).trim());
    const amount = parseFloatSafe(String(row[idx.amount] ?? '').trim());
    const fee = idx.fee !== -1 ? parseFloatSafe(String(row[idx.fee] ?? '').trim()) : 0;
    const description = idx.description !== -1 ? String(row[idx.description] ?? '').trim() : '';
    const currency =
      idx.currency !== -1
        ? String(row[idx.currency] ?? '')
            .trim()
            .toUpperCase()
        : 'GBP';

    // Revolut Amount is the net (without fee) in the export. Subtract fee for
    // outflows so the recorded amount matches what left the account.
    const net = amount - fee;

    out.push({
      date,
      amount: net,
      description,
      currency: currency || 'GBP',
    });
  }
  return out;
}

function parseRevolutDate(s: string): Date {
  // yyyy-MM-dd HH:mm:ss or yyyy-MM-dd or ISO with 'T'.
  if (!s) throw new ValidationError('Revolut parser: empty date');
  const isoLike = s.replace(' ', 'T');
  const d = new Date(isoLike.endsWith('Z') ? isoLike : `${isoLike}Z`);
  if (Number.isNaN(d.getTime())) {
    // Fallback: try plain Date parsing.
    const d2 = new Date(s);
    if (Number.isNaN(d2.getTime())) {
      throw new ValidationError(`Revolut parser: invalid date '${s}'`);
    }
    return d2;
  }
  return d;
}

function parseFloatSafe(s: string): number {
  if (!s) return 0;
  const cleaned = s.replace(/[£$€,]/g, '').trim();
  if (!cleaned) return 0;
  const n = Number.parseFloat(cleaned);
  if (!Number.isFinite(n) || !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(cleaned)) {
    throw new ValidationError(`Revolut parser: invalid amount '${s}'`);
  }
  return n;
}
