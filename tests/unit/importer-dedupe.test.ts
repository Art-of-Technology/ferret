import { describe, expect, test } from 'bun:test';
import { isDuplicate, levenshtein } from '../../src/services/importers/dedupe';

const baseExisting = [
  {
    id: 'csv_existing_1',
    date: new Date(Date.UTC(2026, 3, 15)),
    amount: -12.5,
    description: 'TESCO STORES 1234',
  },
];

describe('strict dedupe', () => {
  test('matches when date, amount, and normalized description are identical', () => {
    expect(
      isDuplicate(
        {
          id: 'new',
          date: new Date(Date.UTC(2026, 3, 15)),
          amount: -12.5,
          description: '  Tesco Stores 1234  ',
        },
        baseExisting,
        'strict',
      ),
    ).toBe(true);
  });

  test('does NOT match when description has a small typo', () => {
    expect(
      isDuplicate(
        {
          id: 'new',
          date: new Date(Date.UTC(2026, 3, 15)),
          amount: -12.5,
          description: 'TESCO STORES 1235',
        },
        baseExisting,
        'strict',
      ),
    ).toBe(false);
  });

  test('does NOT match when amount differs', () => {
    expect(
      isDuplicate(
        {
          id: 'new',
          date: new Date(Date.UTC(2026, 3, 15)),
          amount: -13.5,
          description: 'TESCO STORES 1234',
        },
        baseExisting,
        'strict',
      ),
    ).toBe(false);
  });

  test('does NOT match when date differs', () => {
    expect(
      isDuplicate(
        {
          id: 'new',
          date: new Date(Date.UTC(2026, 3, 16)),
          amount: -12.5,
          description: 'TESCO STORES 1234',
        },
        baseExisting,
        'strict',
      ),
    ).toBe(false);
  });
});

describe('loose dedupe', () => {
  test('matches when description differs by Levenshtein < 3', () => {
    expect(
      isDuplicate(
        {
          id: 'new',
          date: new Date(Date.UTC(2026, 3, 15)),
          amount: -12.5,
          description: 'TESCO STORES 1235', // 1 char diff
        },
        baseExisting,
        'loose',
      ),
    ).toBe(true);
  });

  test('matches across adjacent days within 1 day window', () => {
    expect(
      isDuplicate(
        {
          id: 'new',
          date: new Date(Date.UTC(2026, 3, 16)),
          amount: -12.5,
          description: 'TESCO STORES 1234',
        },
        baseExisting,
        'loose',
      ),
    ).toBe(true);
  });

  test('matches via substring', () => {
    expect(
      isDuplicate(
        {
          id: 'new',
          date: new Date(Date.UTC(2026, 3, 15)),
          amount: -12.5,
          description: 'TESCO',
        },
        baseExisting,
        'loose',
      ),
    ).toBe(true);
  });

  test('does NOT match when description very different', () => {
    expect(
      isDuplicate(
        {
          id: 'new',
          date: new Date(Date.UTC(2026, 3, 15)),
          amount: -12.5,
          description: 'AMAZON UK',
        },
        baseExisting,
        'loose',
      ),
    ).toBe(false);
  });
});

describe('levenshtein', () => {
  test('identical', () => expect(levenshtein('abc', 'abc')).toBe(0));
  test('one substitution', () => expect(levenshtein('abc', 'abd')).toBe(1));
  test('one insertion', () => expect(levenshtein('abc', 'abcd')).toBe(1));
  test('empty strings', () => {
    expect(levenshtein('', '')).toBe(0);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });
  test('classic kitten/sitting -> 3', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });
});
