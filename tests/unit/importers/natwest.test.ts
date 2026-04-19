import { expect, test } from 'bun:test';
import { detectFormat } from '../../../src/services/importers';
import { parseNatwest } from '../../../src/services/importers/natwest';

const FIXTURE = [
  'Date,Type,Description,Value,Balance,Account Name,Account Number',
  '15/04/2026,POS,"PRET A MANGER",-4.50,1000.00,MAIN,12345678',
  '16/04/2026,BAC,"REFUND",10.00,1010.00,MAIN,12345678',
].join('\n');

test('detects NatWest from header', () => {
  expect(detectFormat(FIXTURE.split('\n')[0] as string)).toBe('natwest');
});

test('does NOT misdetect a generic ledger header as NatWest', () => {
  // Pre-fix, the signature triggered on date+account name+account number+value.
  // A generic export with those columns but missing Type/Description should not
  // match: the new signature requires both 'type' and 'description' headers.
  expect(detectFormat('date,account name,account number,value')).not.toBe('natwest');
  expect(detectFormat('date,description,account name,account number,value')).not.toBe('natwest');
});

test('parses NatWest rows preserving signed values', () => {
  const rows = parseNatwest(FIXTURE);
  expect(rows.length).toBe(2);

  expect(rows[0]?.amount).toBe(-4.5);
  expect(rows[0]?.description).toBe('PRET A MANGER');
  expect(rows[0]?.currency).toBe('GBP');
  expect(rows[0]?.date.toISOString().slice(0, 10)).toBe('2026-04-15');

  expect(rows[1]?.amount).toBe(10);
  expect(rows[1]?.description).toBe('REFUND');
});
