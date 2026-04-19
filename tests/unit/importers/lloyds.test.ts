import { expect, test } from 'bun:test';
import { detectFormat } from '../../../src/services/importers';
import { parseLloyds } from '../../../src/services/importers/lloyds';

const FIXTURE = [
  'Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance',
  '15/04/2026,DEB,30-99-50,12345678,TESCO STORES,12.50,,1234.56',
  '16/04/2026,FPI,30-99-50,12345678,SALARY ACME LTD,,2500.00,3734.56',
  '17/04/2026,DEB,30-99-50,12345678,"AMAZON, UK",45.99,,3688.57',
].join('\n');

test('detects Lloyds from header', () => {
  expect(detectFormat(FIXTURE.split('\n')[0] as string)).toBe('lloyds');
});

test('parses Lloyds rows: debit negative, credit positive, quoted commas', () => {
  const rows = parseLloyds(FIXTURE);
  expect(rows.length).toBe(3);

  expect(rows[0]?.amount).toBe(-12.5);
  expect(rows[0]?.description).toBe('TESCO STORES');
  expect(rows[0]?.currency).toBe('GBP');
  expect(rows[0]?.date.toISOString().slice(0, 10)).toBe('2026-04-15');

  expect(rows[1]?.amount).toBe(2500);
  expect(rows[1]?.description).toBe('SALARY ACME LTD');

  expect(rows[2]?.amount).toBe(-45.99);
  expect(rows[2]?.description).toBe('AMAZON, UK');
});

test('Lloyds parser tolerates UTF-8 BOM', () => {
  const withBom = `\ufeff${FIXTURE}`;
  const rows = parseLloyds(withBom);
  expect(rows.length).toBe(3);
});
