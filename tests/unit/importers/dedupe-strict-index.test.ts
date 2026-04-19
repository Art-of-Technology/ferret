import { describe, expect, test } from 'bun:test';
import {
  buildStrictIndex,
  isDuplicate,
  isDuplicateStrict,
} from '../../../src/services/importers/dedupe';

const existing = [
  {
    id: 'csv_existing_1',
    date: new Date(Date.UTC(2026, 3, 15)),
    amount: -12.5,
    description: 'TESCO STORES 1234',
  },
  {
    id: 'csv_existing_2',
    date: new Date(Date.UTC(2026, 3, 16)),
    amount: 25,
    description: 'REFUND',
  },
];

describe('strict dedupe via hash index', () => {
  const index = buildStrictIndex(existing);

  test('id-equality short-circuit', () => {
    expect(
      isDuplicateStrict(
        {
          id: 'csv_existing_1',
          date: new Date(Date.UTC(2030, 0, 1)),
          amount: 999,
          description: 'completely different',
        },
        index,
      ),
    ).toBe(true);
  });

  test('matches by (date, amount, normalized description)', () => {
    expect(
      isDuplicateStrict(
        {
          id: 'new',
          date: new Date(Date.UTC(2026, 3, 15)),
          amount: -12.5,
          description: '  Tesco Stores 1234  ',
        },
        index,
      ),
    ).toBe(true);
  });

  test('does NOT match across days', () => {
    expect(
      isDuplicateStrict(
        {
          id: 'new',
          date: new Date(Date.UTC(2026, 3, 17)),
          amount: -12.5,
          description: 'TESCO STORES 1234',
        },
        index,
      ),
    ).toBe(false);
  });

  test('does NOT match when amount differs', () => {
    expect(
      isDuplicateStrict(
        {
          id: 'new',
          date: new Date(Date.UTC(2026, 3, 15)),
          amount: -13.5,
          description: 'TESCO STORES 1234',
        },
        index,
      ),
    ).toBe(false);
  });

  test('agrees with the existing isDuplicate strict path', () => {
    const cand = {
      id: 'new',
      date: new Date(Date.UTC(2026, 3, 15)),
      amount: -12.5,
      description: 'TESCO STORES 1234',
    };
    expect(isDuplicateStrict(cand, index)).toBe(isDuplicate(cand, existing, 'strict'));
  });
});
