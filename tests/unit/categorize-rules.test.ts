import { describe, expect, test } from 'bun:test';
import type { RuleRow, UncategorizedTxn } from '../../src/db/queries/categorize';
import { applyMerchantCache, applyRules, normalizeMerchant } from '../../src/services/categorize';

function txn(overrides: Partial<UncategorizedTxn> = {}): UncategorizedTxn {
  return {
    id: 't-1',
    accountId: 'a-1',
    description: 'TESCO STORES 4567 LONDON',
    merchantName: 'Tesco',
    amount: -42.5,
    currency: 'GBP',
    timestamp: new Date(0),
    ...overrides,
  };
}

function rule(overrides: Partial<RuleRow>): RuleRow {
  return {
    id: 'r-1',
    pattern: '^Tesco',
    field: 'merchant',
    category: 'Groceries',
    priority: 1,
    ...overrides,
  };
}

describe('applyRules', () => {
  test('matches merchant via case-insensitive regex', () => {
    const hit = applyRules(txn({ merchantName: 'tesco superstore' }), [rule({})]);
    expect(hit?.category).toBe('Groceries');
    expect(hit?.ruleId).toBe('r-1');
  });

  test('returns null when nothing matches', () => {
    const hit = applyRules(txn({ merchantName: 'Sainsburys' }), [rule({})]);
    expect(hit).toBeNull();
  });

  test('priority DESC wins on ties of pattern matches', () => {
    const rules: RuleRow[] = [
      rule({ id: 'low', pattern: 'Tesco', category: 'General', priority: 1 }),
      rule({ id: 'high', pattern: 'Tesco', category: 'Groceries', priority: 10 }),
    ];
    const hit = applyRules(txn(), rules);
    expect(hit?.category).toBe('Groceries');
    expect(hit?.ruleId).toBe('high');
  });

  test('field switch: description matches against description column', () => {
    const merchantRule = rule({
      id: 'm',
      pattern: '^DOES_NOT_MATCH$',
      field: 'merchant',
      category: 'X',
      priority: 5,
    });
    const descRule = rule({
      id: 'd',
      pattern: 'STORES 4567',
      field: 'description',
      category: 'Groceries',
      priority: 1,
    });
    const hit = applyRules(txn({ merchantName: 'random' }), [merchantRule, descRule]);
    expect(hit?.category).toBe('Groceries');
    expect(hit?.ruleId).toBe('d');
  });

  test('skips rules with invalid regex without throwing', () => {
    const broken = rule({ id: 'bad', pattern: '(', priority: 999, category: 'NOPE' });
    const good = rule({ id: 'good', pattern: '^Tesco', priority: 1 });
    const hit = applyRules(txn(), [broken, good]);
    expect(hit?.ruleId).toBe('good');
  });
});

describe('normalizeMerchant', () => {
  test('lowercases, strips non-alnum, collapses whitespace', () => {
    expect(normalizeMerchant('Tesco Stores 4567')).toBe('tesco stores 4567');
    expect(normalizeMerchant('PRET A MANGER #21')).toBe('pret a manger 21');
    expect(normalizeMerchant('  Amazon.co.uk  ')).toBe('amazon co uk');
  });
});

describe('applyMerchantCache', () => {
  test('hits on normalized merchant_name', () => {
    const cache = new Map<string, string>([['tesco', 'Groceries']]);
    const hit = applyMerchantCache(txn({ merchantName: 'TESCO' }), cache);
    expect(hit?.category).toBe('Groceries');
    expect(hit?.key).toBe('tesco');
  });

  test('falls back to description when merchant_name is null', () => {
    const cache = new Map<string, string>([['shell garage', 'Fuel']]);
    const hit = applyMerchantCache(
      txn({ merchantName: null, description: 'SHELL GARAGE 11' }),
      cache,
    );
    // 'shell garage 11' contains 'shell garage' but applyMerchantCache uses
    // exact match — so this should miss. Use description-as-key:
    expect(hit).toBeNull();

    const cache2 = new Map<string, string>([['shell garage 11', 'Fuel']]);
    const hit2 = applyMerchantCache(
      txn({ merchantName: null, description: 'SHELL GARAGE 11' }),
      cache2,
    );
    expect(hit2?.category).toBe('Fuel');
  });

  test('returns null on empty cache', () => {
    const hit = applyMerchantCache(txn(), new Map());
    expect(hit).toBeNull();
  });
});
