import { describe, expect, test } from 'bun:test';
import { formatDate, parseDate, parseDuration } from '../../src/lib/dates';
import { ValidationError } from '../../src/lib/errors';

describe('parseDuration', () => {
  const NOW = new Date(Date.UTC(2026, 3, 19, 12, 0, 0)); // 2026-04-19T12:00:00Z

  test('parses days', () => {
    const result = parseDuration('30d', NOW);
    expect(result.toISOString()).toBe('2026-03-20T12:00:00.000Z');
  });

  test('parses weeks', () => {
    const result = parseDuration('2w', NOW);
    expect(result.toISOString()).toBe('2026-04-05T12:00:00.000Z');
  });

  test('parses months', () => {
    const result = parseDuration('6m', NOW);
    expect(result.getUTCFullYear()).toBe(2025);
    expect(result.getUTCMonth()).toBe(9); // October (0-indexed)
    expect(result.getUTCDate()).toBe(19);
  });

  test('parses years', () => {
    const result = parseDuration('2y', NOW);
    expect(result.getUTCFullYear()).toBe(2024);
    expect(result.getUTCMonth()).toBe(3);
    expect(result.getUTCDate()).toBe(19);
  });

  test('parses ISO date as absolute', () => {
    const result = parseDuration('2026-01-01', NOW);
    expect(result.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  test('handles zero duration', () => {
    const result = parseDuration('0d', NOW);
    expect(result.getTime()).toBe(NOW.getTime());
  });

  test('throws on bad input', () => {
    expect(() => parseDuration('hello')).toThrow(ValidationError);
    expect(() => parseDuration('')).toThrow(ValidationError);
    expect(() => parseDuration('30')).toThrow(ValidationError);
    expect(() => parseDuration('30x')).toThrow(ValidationError);
    expect(() => parseDuration('-30d')).toThrow(ValidationError);
  });

  test('is timezone-stable', () => {
    // Whatever local timezone we're in, parseDuration('30d', NOW) should return
    // a Date whose UTC time is exactly 30 * 86400 seconds before NOW.
    const result = parseDuration('30d', NOW);
    expect(NOW.getTime() - result.getTime()).toBe(30 * 86_400 * 1000);
  });
});

describe('parseDate', () => {
  test('parses yyyy-MM-dd at UTC midnight', () => {
    const d = parseDate('2026-04-19');
    expect(d.toISOString()).toBe('2026-04-19T00:00:00.000Z');
  });

  test('handles leap years', () => {
    const d = parseDate('2024-02-29');
    expect(d.toISOString()).toBe('2024-02-29T00:00:00.000Z');
  });

  test('rejects non-leap-year Feb 29', () => {
    expect(() => parseDate('2025-02-29')).toThrow(ValidationError);
  });

  test('rejects Feb 30', () => {
    expect(() => parseDate('2025-02-30')).toThrow(ValidationError);
  });

  test('rejects bad format', () => {
    expect(() => parseDate('2026/04/19')).toThrow(ValidationError);
    expect(() => parseDate('19-04-2026')).toThrow(ValidationError);
    expect(() => parseDate('2026-4-9')).toThrow(ValidationError);
    expect(() => parseDate('not-a-date')).toThrow(ValidationError);
    expect(() => parseDate('')).toThrow(ValidationError);
  });

  test('rejects out-of-range months/days', () => {
    expect(() => parseDate('2026-13-01')).toThrow(ValidationError);
    expect(() => parseDate('2026-00-01')).toThrow(ValidationError);
    expect(() => parseDate('2026-01-00')).toThrow(ValidationError);
    expect(() => parseDate('2026-01-32')).toThrow(ValidationError);
  });
});

describe('formatDate', () => {
  test('formats default yyyy-MM-dd in UTC', () => {
    const d = new Date(Date.UTC(2026, 3, 19, 12, 0, 0));
    expect(formatDate(d)).toBe('2026-04-19');
  });

  test('round-trips parseDate', () => {
    const iso = '2026-04-19';
    expect(formatDate(parseDate(iso))).toBe(iso);
  });

  test('respects custom format', () => {
    const d = new Date(Date.UTC(2026, 3, 19, 0, 0, 0));
    expect(formatDate(d, 'yyyy/MM/dd')).toMatch(/2026\/04\/19/);
  });

  test('throws on invalid Date', () => {
    expect(() => formatDate(new Date('not-a-date'))).toThrow(ValidationError);
  });
});
