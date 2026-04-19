import { expect, test } from 'bun:test';
import { detectFormat } from '../../../src/services/importers';
import { parseRevolut } from '../../../src/services/importers/revolut';

const FIXTURE = [
  'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance',
  'CARD_PAYMENT,Current,2026-04-15 09:00:00,2026-04-15 09:01:00,Tesco,-12.50,0.00,GBP,COMPLETED,500.00',
  'CARD_PAYMENT,Current,2026-04-16 12:00:00,2026-04-16 12:00:30,FX Coffee,-3.00,0.20,EUR,COMPLETED,496.80',
  'TOPUP,Current,2026-04-17 08:00:00,2026-04-17 08:00:00,Top-Up,100.00,0.00,GBP,COMPLETED,596.80',
  'CARD_PAYMENT,Current,2026-04-18 10:00:00,,Pending Coffee,-5.00,0.00,GBP,PENDING,591.80',
].join('\n');

test('detects Revolut from header', () => {
  expect(detectFormat(FIXTURE.split('\n')[0] as string)).toBe('revolut');
});

test('parses Revolut rows: skips non-COMPLETED, applies fee, preserves currency', () => {
  const rows = parseRevolut(FIXTURE);
  // PENDING row is skipped.
  expect(rows.length).toBe(3);

  expect(rows[0]?.amount).toBe(-12.5);
  expect(rows[0]?.currency).toBe('GBP');
  expect(rows[0]?.description).toBe('Tesco');

  // Net = -3.00 - 0.20 = -3.20 (fee subtracted from outflow).
  expect(rows[1]?.amount).toBeCloseTo(-3.2, 5);
  expect(rows[1]?.currency).toBe('EUR');

  expect(rows[2]?.amount).toBe(100);
  expect(rows[2]?.currency).toBe('GBP');
});
