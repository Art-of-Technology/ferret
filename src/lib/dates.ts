// UTC-safe date utilities and duration parsing.
//
// These helpers back the `--since` / `--until` flags on `ferret ls` (and will be
// reused by `sync`, `export`, and `budget` in later phases). All date math is
// done in UTC so a user querying "last 30 days" never gets shifted by their
// local timezone offset.

import { format as dfFormat } from 'date-fns/format';
import { ValidationError } from './errors';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DURATION_RE = /^(\d+)([dwmy])$/;

/**
 * Parse a duration string into a `Date` representing "now minus the duration",
 * or, when given an ISO yyyy-MM-dd string, the absolute date at UTC midnight.
 *
 * Accepted forms:
 *   - `30d` (days)
 *   - `2w`  (weeks)
 *   - `6m`  (calendar months)
 *   - `2y`  (calendar years)
 *   - `2026-01-01` (absolute, treated as UTC midnight)
 *
 * Throws `ValidationError` on unrecognized input.
 */
export function parseDuration(input: string, now: Date = new Date()): Date {
  if (typeof input !== 'string' || input.length === 0) {
    throw new ValidationError(`Invalid duration: ${JSON.stringify(input)}`);
  }
  const trimmed = input.trim();

  if (ISO_DATE_RE.test(trimmed)) {
    return parseDate(trimmed);
  }

  const m = DURATION_RE.exec(trimmed);
  if (!m) {
    throw new ValidationError(
      `Invalid duration "${input}". Expected forms like "30d", "2w", "6m", "1y", or an ISO date "yyyy-MM-dd".`,
    );
  }
  const n = Number.parseInt(m[1] ?? '', 10);
  const unit = m[2];
  if (!Number.isFinite(n) || n < 0) {
    throw new ValidationError(
      `Invalid duration "${input}": numeric component must be non-negative`,
    );
  }

  // All math in UTC to stay timezone-stable.
  const y = now.getUTCFullYear();
  const mo = now.getUTCMonth();
  const d = now.getUTCDate();
  const h = now.getUTCHours();
  const mi = now.getUTCMinutes();
  const s = now.getUTCSeconds();
  const ms = now.getUTCMilliseconds();

  switch (unit) {
    case 'd':
      return new Date(Date.UTC(y, mo, d - n, h, mi, s, ms));
    case 'w':
      return new Date(Date.UTC(y, mo, d - n * 7, h, mi, s, ms));
    case 'm':
      return new Date(Date.UTC(y, mo - n, d, h, mi, s, ms));
    case 'y':
      return new Date(Date.UTC(y - n, mo, d, h, mi, s, ms));
    default:
      // Unreachable thanks to the regex, but the strict compiler wants it.
      throw new ValidationError(`Invalid duration unit "${unit ?? ''}"`);
  }
}

/**
 * Parse a strict `yyyy-MM-dd` calendar date and return a UTC-midnight `Date`.
 * Throws `ValidationError` for any other format or for impossible dates
 * (e.g. `2025-02-30`).
 */
export function parseDate(input: string): Date {
  if (typeof input !== 'string' || !ISO_DATE_RE.test(input)) {
    throw new ValidationError(
      `Invalid date "${String(input)}". Expected yyyy-MM-dd (e.g. 2026-04-19).`,
    );
  }
  const parts = input.split('-');
  const y = Number.parseInt(parts[0] ?? '', 10);
  const mo = Number.parseInt(parts[1] ?? '', 10);
  const d = Number.parseInt(parts[2] ?? '', 10);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) {
    throw new ValidationError(`Invalid date "${input}"`);
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) {
    throw new ValidationError(`Invalid date "${input}"`);
  }
  const ms = Date.UTC(y, mo - 1, d, 0, 0, 0, 0);
  const out = new Date(ms);
  // Reject dates that round-tripped to something else (e.g. Feb 30 -> Mar 2).
  if (out.getUTCFullYear() !== y || out.getUTCMonth() !== mo - 1 || out.getUTCDate() !== d) {
    throw new ValidationError(`Invalid calendar date "${input}"`);
  }
  return out;
}

/**
 * Format a `Date` for display. Defaults to `yyyy-MM-dd` per PRD §5.4.
 *
 * date-fns' `format` is locale/TZ-aware; we always feed it a `Date` whose UTC
 * fields are the source of truth, so the rendered output is deterministic
 * across machines for date-only patterns.
 */
export function formatDate(d: Date, fmt = 'yyyy-MM-dd'): string {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
    throw new ValidationError('formatDate: not a valid Date');
  }
  // For the default date-only format, work off the UTC components so the
  // displayed day matches the stored UTC midnight regardless of local TZ.
  if (fmt === 'yyyy-MM-dd') {
    const y = d.getUTCFullYear().toString().padStart(4, '0');
    const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
    const day = d.getUTCDate().toString().padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  return dfFormat(d, fmt);
}
