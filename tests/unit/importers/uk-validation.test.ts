import { describe, expect, test } from 'bun:test';
import { ValidationError } from '../../../src/lib/errors';
import { EMPTY_DESCRIPTION, parseBarclays } from '../../../src/services/importers/barclays';
import { parseHsbc } from '../../../src/services/importers/hsbc';
import { parseFloatSafe, parseUkDate } from '../../../src/services/importers/uk-date';

describe('parseUkDate (shared)', () => {
  test('parses dd/MM/yyyy', () => {
    const d = parseUkDate('15/04/2026', 'Test');
    expect(d.toISOString().slice(0, 10)).toBe('2026-04-15');
  });

  test('rejects out-of-range day (32/01/2026)', () => {
    expect(() => parseUkDate('32/01/2026', 'Test')).toThrow(ValidationError);
  });

  test('rejects out-of-range month (15/13/2026)', () => {
    expect(() => parseUkDate('15/13/2026', 'Test')).toThrow(ValidationError);
  });

  test('rejects 30/02/2026 (Feb has no 30th)', () => {
    expect(() => parseUkDate('30/02/2026', 'Test')).toThrow(ValidationError);
  });

  test('rejects garbage', () => {
    expect(() => parseUkDate('not-a-date', 'Test')).toThrow(ValidationError);
  });
});

describe('parseFloatSafe (shared)', () => {
  test('returns 0 for empty string', () => {
    expect(parseFloatSafe('', 'Test')).toBe(0);
    expect(parseFloatSafe('   ', 'Test')).toBe(0);
  });

  test('parses signed decimals and strips £/commas', () => {
    expect(parseFloatSafe('£1,234.56', 'Test')).toBe(1234.56);
    expect(parseFloatSafe('-12.50', 'Test')).toBe(-12.5);
  });

  test('throws ValidationError for non-empty unparseable input', () => {
    expect(() => parseFloatSafe('not a number', 'Test')).toThrow(ValidationError);
    expect(() => parseFloatSafe('12abc', 'Test')).toThrow(ValidationError);
  });

  test('error message includes row number when provided', () => {
    try {
      parseFloatSafe('xyz', 'Bank', 42);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as Error).message).toContain('row 42');
    }
  });
});

describe('Barclays parser', () => {
  test('uses synthetic description marker when memo and subcategory are empty', () => {
    const csv = ['Number,Date,Account,Amount,Subcategory,Memo', '1,15/04/2026,Acct,-12.50,,'].join(
      '\n',
    );
    const rows = parseBarclays(csv);
    expect(rows.length).toBe(1);
    expect(rows[0]?.description).toBe(EMPTY_DESCRIPTION);
  });

  test('throws on invalid date', () => {
    const csv = [
      'Number,Date,Account,Amount,Subcategory,Memo',
      '1,32/13/2026,Acct,-12.50,,Tesco',
    ].join('\n');
    expect(() => parseBarclays(csv)).toThrow(ValidationError);
  });

  test('throws on unparseable amount', () => {
    const csv = [
      'Number,Date,Account,Amount,Subcategory,Memo',
      '1,15/04/2026,Acct,nope,,Tesco',
    ].join('\n');
    expect(() => parseBarclays(csv)).toThrow(ValidationError);
  });
});

describe('HSBC parser', () => {
  test('throws on invalid date', () => {
    const csv = ['Date,Description,Amount,Balance', '30/02/2026,Tesco,-12.50,100'].join('\n');
    expect(() => parseHsbc(csv)).toThrow(ValidationError);
  });

  test('throws on unparseable amount', () => {
    const csv = ['Date,Description,Amount,Balance', '15/04/2026,Tesco,nope,100'].join('\n');
    expect(() => parseHsbc(csv)).toThrow(ValidationError);
  });
});
