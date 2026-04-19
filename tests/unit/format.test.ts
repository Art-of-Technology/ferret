import { describe, expect, test } from 'bun:test';
import { formatCsv, formatCurrency, formatJson, formatTable } from '../../src/lib/format';

describe('formatCurrency', () => {
  test('formats positive GBP', () => {
    expect(formatCurrency(12.34, 'GBP')).toContain('12.34');
    expect(formatCurrency(12.34, 'GBP')).toContain('£');
  });

  test('formats USD', () => {
    expect(formatCurrency(99, 'USD')).toContain('99');
    expect(formatCurrency(99, 'USD')).toContain('$');
  });

  test('formats EUR', () => {
    expect(formatCurrency(7.5, 'EUR')).toContain('7.50');
  });

  test('formats negative amounts', () => {
    const out = formatCurrency(-50, 'GBP');
    // Should show the magnitude with a minus or parentheses; Intl chooses the
    // locale-appropriate convention. Either way the digits are there.
    expect(out).toContain('50');
  });

  test('falls back gracefully on unknown currency', () => {
    const out = formatCurrency(10, 'XXX');
    expect(out).toContain('10');
  });

  test('handles non-finite numbers without crashing', () => {
    expect(formatCurrency(Number.NaN, 'GBP')).toBe('NaN');
    expect(formatCurrency(Number.POSITIVE_INFINITY, 'GBP')).toBe('Infinity');
  });
});

describe('formatCsv', () => {
  test('returns empty string for empty input', () => {
    expect(formatCsv([])).toBe('');
  });

  test('renders headers from first row keys', () => {
    const out = formatCsv([{ a: 1, b: 'x' }]);
    const [header, row] = out.split('\r\n');
    expect(header).toBe('a,b');
    expect(row).toBe('1,x');
  });

  test('quotes fields containing commas', () => {
    const out = formatCsv([{ a: 'hello, world' }]);
    expect(out).toContain('"hello, world"');
  });

  test('quotes fields containing quotes and doubles them', () => {
    const out = formatCsv([{ a: 'she said "hi"' }]);
    expect(out).toContain('"she said ""hi"""');
  });

  test('quotes fields containing newlines', () => {
    const out = formatCsv([{ a: 'line1\nline2' }]);
    expect(out).toContain('"line1\nline2"');
  });

  test('quotes fields containing carriage returns', () => {
    const out = formatCsv([{ a: 'line1\r\nline2' }]);
    expect(out.split('\r\n').length).toBeGreaterThan(2);
    expect(out).toContain('"line1\r\nline2"');
  });

  test('renders null/undefined as empty fields', () => {
    const out = formatCsv([{ a: null, b: undefined, c: 'ok' }]);
    expect(out.split('\r\n')[1]).toBe(',,ok');
  });

  test('uses RFC 4180 CRLF line endings', () => {
    const out = formatCsv([{ a: 1 }, { a: 2 }]);
    expect(out).toContain('\r\n');
  });

  test('preserves key order across rows even when keys are missing', () => {
    const out = formatCsv([
      { a: 1, b: 2 },
      { a: 3, c: 4 },
    ]);
    const lines = out.split('\r\n');
    expect(lines[0]).toBe('a,b,c');
    expect(lines[1]).toBe('1,2,');
    expect(lines[2]).toBe('3,,4');
  });
});

describe('formatJson', () => {
  test('sorts keys recursively for determinism', () => {
    const out = formatJson([{ b: 1, a: { d: 2, c: 3 } }]);
    // Find the order in which keys appear in the serialized output.
    const aIdx = out.indexOf('"a"');
    const bIdx = out.indexOf('"b"');
    const cIdx = out.indexOf('"c"');
    const dIdx = out.indexOf('"d"');
    expect(aIdx).toBeLessThan(bIdx);
    expect(cIdx).toBeLessThan(dIdx);
  });

  test('preserves array order', () => {
    const out = formatJson([3, 1, 2]);
    expect(out).toBe('[\n  3,\n  1,\n  2\n]');
  });

  test('serializes empty array', () => {
    expect(formatJson([])).toBe('[]');
  });

  test('handles nested objects and primitives', () => {
    const out = formatJson({ x: [{ b: 2, a: 1 }] });
    expect(JSON.parse(out)).toEqual({ x: [{ a: 1, b: 2 }] });
  });
});

describe('formatTable', () => {
  test('returns empty string on empty input', () => {
    expect(formatTable([])).toBe('');
  });

  test('renders headers and rows', () => {
    const out = formatTable([{ name: 'Alice', age: 30 }], { colors: false });
    expect(out).toContain('name');
    expect(out).toContain('Alice');
    expect(out).toContain('30');
  });

  test('renders with custom head order', () => {
    const out = formatTable([{ a: 1, b: 2 }], { head: ['b', 'a'], colors: false });
    const bIdx = out.indexOf('b');
    const aIdx = out.indexOf('a');
    expect(bIdx).toBeLessThan(aIdx);
  });
});
