import { describe, expect, test } from 'bun:test';
import { parseCsv, stripBom } from '../../src/services/importers';

describe('parseCsv', () => {
  test('round-trip: handles quoted commas and escaped quotes', () => {
    const csv = ['a,b,c', '"hello, world","she said ""hi""",42', 'plain,"with\nnewline",end'].join(
      '\n',
    );
    const rows = parseCsv(csv);
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['hello, world', 'she said "hi"', '42'],
      ['plain', 'with\nnewline', 'end'],
    ]);
  });

  test('strips a UTF-8 BOM at the start of the input', () => {
    const csv = '\ufeffa,b\n1,2';
    expect(stripBom(csv)).toBe('a,b\n1,2');
    const rows = parseCsv(csv);
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  test('handles \\r\\n and \\r row terminators', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('a,b\r1,2\r')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  test('preserves empty trailing fields', () => {
    expect(parseCsv('a,b,c\n1,,3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
    ]);
  });

  test('returns empty array for empty input', () => {
    expect(parseCsv('')).toEqual([]);
  });

  test('handles single row without terminator', () => {
    expect(parseCsv('one,two')).toEqual([['one', 'two']]);
  });
});
