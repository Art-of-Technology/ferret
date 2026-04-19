// Shared helpers for UK-format CSV importers (Barclays, HSBC, etc).
//
// Why a shared module: the Barclays / HSBC parsers used to each ship their own
// `parseUkDate` and `parseFloatSafe` copies. They were near-identical and drifted
// over time, which made fixes (validation, error reporting) inconsistent. This
// module is the single source of truth — fixes here apply to every importer.

import { ValidationError } from '../../lib/errors';

/**
 * Parse a UK-format date string `dd/MM/yyyy` (also tolerates `dd/MM/yy`).
 *
 * Validates that the parsed components round-trip back to the same date. e.g.
 * `32/13/2026` no longer silently becomes a future date — it throws.
 *
 * @param s          Raw date string from the CSV cell.
 * @param parserName Name of the calling parser (for error messages).
 */
export function parseUkDate(s: string, parserName: string): Date {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (!m) throw new ValidationError(`${parserName} parser: invalid date '${s}'`);
  const day = Number.parseInt(m[1] as string, 10);
  const month = Number.parseInt(m[2] as string, 10);
  let year = Number.parseInt(m[3] as string, 10);
  if (year < 100) year += 2000;

  const d = new Date(Date.UTC(year, month - 1, day));
  // Round-trip check: rejects e.g. 32/13/2026, 30/02/2026, etc.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw new ValidationError(`${parserName} parser: invalid date '${s}'`);
  }
  return d;
}

/**
 * Parse a numeric amount cell. Strips `£` and thousands separators.
 *
 * Empty or whitespace-only cells return `0` (banks emit empty cells for
 * unused debit/credit columns). Non-empty cells that fail to parse throw a
 * `ValidationError` rather than silently corrupting to `0`.
 *
 * @param s          Raw amount string from the CSV cell.
 * @param parserName Name of the calling parser (for error messages).
 * @param rowNumber  1-based row number for the error message (optional).
 */
export function parseFloatSafe(s: string, parserName: string, rowNumber?: number): number {
  if (!s) return 0;
  const cleaned = s.replace(/[£,]/g, '').trim();
  if (!cleaned) return 0;
  const n = Number.parseFloat(cleaned);
  if (!Number.isFinite(n) || !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(cleaned)) {
    const at = rowNumber !== undefined ? ` at row ${rowNumber}` : '';
    throw new ValidationError(`${parserName} parser: invalid amount '${s}'${at}`);
  }
  return n;
}
