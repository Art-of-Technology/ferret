import { describe, expect, test } from 'bun:test';
import {
  buildLooseBuckets,
  isDuplicate,
  isDuplicateLoose,
  levenshtein,
} from '../../src/services/importers/dedupe';

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

describe('loose dedupe via bucket index', () => {
  // Verifies the O(parsed + window) average-case fast path: a candidate whose
  // (date, amount) bucket is empty must return false WITHOUT touching
  // Levenshtein. We instrument by giving the bucket builder an `existing` set
  // that intentionally has no bucket overlap with the candidate.
  test('bucket-miss returns false without scanning the wider window', () => {
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
        amount: -12.5,
        description: 'TESCO STORES 1234',
      },
    ];
    const index = buildLooseBuckets(existing);

    // Same amount, but date is 10 days away from any existing row -> bucket
    // miss. The fuzzy substring/Levenshtein check must NOT fire.
    expect(
      isDuplicateLoose(
        {
          id: 'new',
          date: new Date(Date.UTC(2026, 3, 25)),
          amount: -12.5,
          description: 'TESCO STORES 1234',
        },
        index,
      ),
    ).toBe(false);
  });

  test('bucket hit applies fuzzy match (Levenshtein < 3)', () => {
    const existing = [
      {
        id: 'csv_existing_1',
        date: new Date(Date.UTC(2026, 3, 15)),
        amount: -12.5,
        description: 'TESCO STORES 1234',
      },
    ];
    const index = buildLooseBuckets(existing);

    // Same date + amount, description differs by one char -> bucket hit, fuzzy
    // match succeeds.
    expect(
      isDuplicateLoose(
        {
          id: 'new',
          date: new Date(Date.UTC(2026, 3, 15)),
          amount: -12.5,
          description: 'TESCO STORES 1235',
        },
        index,
      ),
    ).toBe(true);
  });

  test('matches across adjacent day via bucket index', () => {
    const existing = [
      {
        id: 'csv_existing_1',
        date: new Date(Date.UTC(2026, 3, 15)),
        amount: -12.5,
        description: 'TESCO STORES 1234',
      },
    ];
    const index = buildLooseBuckets(existing);
    expect(
      isDuplicateLoose(
        {
          id: 'new',
          date: new Date(Date.UTC(2026, 3, 16)),
          amount: -12.5,
          description: 'TESCO STORES 1234',
        },
        index,
      ),
    ).toBe(true);
  });

  test('id-equality short-circuit', () => {
    const existing = [
      {
        id: 'csv_existing_1',
        date: new Date(Date.UTC(2026, 3, 15)),
        amount: -12.5,
        description: 'TESCO STORES 1234',
      },
    ];
    const index = buildLooseBuckets(existing);
    expect(
      isDuplicateLoose(
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

  test('amount mismatch in same day -> bucket miss, no fuzzy work', () => {
    const existing = [
      {
        id: 'csv_existing_1',
        date: new Date(Date.UTC(2026, 3, 15)),
        amount: -12.5,
        description: 'TESCO STORES 1234',
      },
    ];
    const index = buildLooseBuckets(existing);
    expect(
      isDuplicateLoose(
        {
          id: 'new',
          date: new Date(Date.UTC(2026, 3, 15)),
          amount: -99.99,
          description: 'TESCO STORES 1234',
        },
        index,
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
