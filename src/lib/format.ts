// Output formatters for `ferret ls` (and any other command that needs a
// table / JSON / CSV view). All functions are pure and TTY-aware where
// applicable so the same row data renders correctly to both terminals and
// pipelines.

import Table from 'cli-table3';
import pc from 'picocolors';

export interface TableOptions {
  /** Explicit column header order. Defaults to the keys of the first row. */
  head?: string[];
  /** Force-disable colors regardless of TTY (useful for tests). */
  colors?: boolean;
}

/** Reports whether stdout is connected to an interactive terminal. */
export function isTty(): boolean {
  return Boolean(process.stdout.isTTY);
}

/**
 * Format a numeric amount as a localized currency string. When the number is
 * negative AND we're rendering to a TTY, the result is wrapped in red so it
 * stands out as an outflow. Pipes/files get plain text.
 */
export function formatCurrency(amount: number, currency: string): string {
  if (!Number.isFinite(amount)) {
    return String(amount);
  }
  let formatted: string;
  try {
    formatted = new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency,
    }).format(amount);
  } catch {
    // Unknown currency code — fall back to a sensible plain rendering rather
    // than throwing inside a formatter.
    formatted = `${amount.toFixed(2)} ${currency}`;
  }
  if (amount < 0 && isTty() && pc.isColorSupported) {
    return pc.red(formatted);
  }
  return formatted;
}

/**
 * Render an array of row objects as a unicode-bordered table. When stdout is
 * not a TTY (or `colors: false`), the table is rendered with ASCII-only
 * borders and no styling so it stays grep-friendly.
 */
export function formatTable(rows: Record<string, unknown>[], options: TableOptions = {}): string {
  if (rows.length === 0) return '';
  const head = options.head ?? Object.keys(rows[0] as Record<string, unknown>);
  const useColors = options.colors ?? isTty();

  const tableOpts: ConstructorParameters<typeof Table>[0] = useColors
    ? { head }
    : {
        head,
        // Plain ASCII borders + no styling so piped output is reproducible.
        chars: {
          top: '-',
          'top-mid': '+',
          'top-left': '+',
          'top-right': '+',
          bottom: '-',
          'bottom-mid': '+',
          'bottom-left': '+',
          'bottom-right': '+',
          left: '|',
          'left-mid': '+',
          mid: '-',
          'mid-mid': '+',
          right: '|',
          'right-mid': '+',
          middle: '|',
        },
        style: { head: [], border: [] },
      };

  const table = new Table(tableOpts);
  for (const row of rows) {
    table.push(head.map((k) => stringifyCell((row as Record<string, unknown>)[k])));
  }
  return table.toString();
}

/**
 * Stable JSON serialization: keys sorted recursively so consumers (jq, diff,
 * snapshot tests) get byte-deterministic output across runs.
 */
export function formatJson(rows: unknown): string {
  return JSON.stringify(sortKeys(rows), null, 2);
}

/**
 * Serialize an array of row objects as RFC 4180 CSV.
 * - Header row derived from the union of keys in row order of first appearance.
 * - Fields containing `,`, `"`, `\r`, or `\n` are wrapped in double quotes.
 * - Embedded `"` is escaped as `""`.
 * - `null` / `undefined` render as empty fields.
 */
export function formatCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        headers.push(k);
      }
    }
  }
  const lines: string[] = [headers.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(stringifyCell(row[h]))).join(','));
  }
  return lines.join('\r\n');
}

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function stringifyCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
