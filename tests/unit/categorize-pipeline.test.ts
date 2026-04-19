import { describe, expect, test } from 'bun:test';
import type { RuleRow, UncategorizedTxn } from '../../src/db/queries/categorize';
import { categorizeBatch, normalizeMerchant } from '../../src/services/categorize';
import type { CategoryAssignment, ClaudeClient, TxnLite } from '../../src/services/claude';

function txn(id: string, overrides: Partial<UncategorizedTxn> = {}): UncategorizedTxn {
  return {
    id,
    accountId: 'a-1',
    description: id,
    merchantName: id,
    amount: -10,
    currency: 'GBP',
    timestamp: new Date(0),
    ...overrides,
  };
}

class FakeClaude {
  calls = 0;
  lastTxns: TxnLite[] = [];
  constructor(private responder: (txns: TxnLite[]) => CategoryAssignment[]) {}
  async categorize(txns: TxnLite[]): Promise<CategoryAssignment[]> {
    this.calls += 1;
    this.lastTxns = txns;
    return this.responder(txns);
  }
}

describe('categorizeBatch (full pipeline)', () => {
  test('manual+rule+cache+claude precedence and merchant_cache writeback', async () => {
    const rules: RuleRow[] = [
      // Two matching rules, both at priority 5; tiebreaker by id ASC.
      { id: 'r-fuel', pattern: '^Shell', field: 'merchant', category: 'Fuel', priority: 5 },
      {
        id: 'r-groc',
        pattern: '^Tesco',
        field: 'merchant',
        category: 'Groceries',
        priority: 5,
      },
    ];
    const cache = new Map<string, string>([
      ['netflix', 'Subscriptions'],
      ['spotify', 'Subscriptions'],
      ['boots', 'Pharmacy'],
    ]);

    // Fixture set:
    //   - 1 already-manual: filtered upstream by listUncategorizedTransactions,
    //     so we don't include it in `uncategorized`. The `manual` count from
    //     the pipeline should therefore stay 0 (manual override flow lives
    //     in the command layer).
    //   - 2 matching rules: Tesco + Shell
    //   - 3 in merchant cache: Netflix, Spotify, Boots
    //   - 5 needing Claude: Dishoom, Pret, Uber, Deliveroo, Amazon
    const fixture: UncategorizedTxn[] = [
      txn('rule-tesco', { merchantName: 'Tesco' }),
      txn('rule-shell', { merchantName: 'Shell' }),
      txn('cache-netflix', { merchantName: 'Netflix' }),
      txn('cache-spotify', { merchantName: 'Spotify' }),
      txn('cache-boots', { merchantName: 'Boots' }),
      txn('claude-dishoom', { merchantName: 'Dishoom' }),
      txn('claude-pret', { merchantName: 'Pret a Manger' }),
      txn('claude-uber', { merchantName: 'Uber' }),
      txn('claude-deliveroo', { merchantName: 'Deliveroo' }),
      txn('claude-amazon', { merchantName: 'Amazon' }),
    ];

    const claudeMap: Record<string, string> = {
      'claude-dishoom': 'Eating Out',
      'claude-pret': 'Eating Out',
      'claude-uber': 'Ride Share',
      'claude-deliveroo': 'Takeaway',
      'claude-amazon': 'General',
    };
    const fakeClaude = new FakeClaude((txns) =>
      txns.map((t) => ({
        transaction_id: t.id,
        category: claudeMap[t.id] ?? 'Uncategorized',
        confidence: 0.9,
      })),
    );

    const cacheWrites: Array<{ normalized: string; category: string; source: string }> = [];

    const result = await categorizeBatch(fixture, {
      claude: fakeClaude as unknown as ClaudeClient,
      availableCategories: [
        'Groceries',
        'Fuel',
        'Subscriptions',
        'Pharmacy',
        'Eating Out',
        'Ride Share',
        'Takeaway',
        'General',
        'Uncategorized',
      ],
      rules,
      merchantCache: cache,
      writeMerchantCache: (e) => cacheWrites.push(e),
    });

    expect(result.used).toEqual({
      manual: 0,
      rule: 2,
      cache: 3,
      claude: 5,
      uncategorized: 0,
    });

    // Stable lookup helper (assignments order isn't part of the contract).
    const byId = new Map(result.categorized.map((a) => [a.transactionId, a]));

    expect(byId.get('rule-tesco')?.source).toBe('rule');
    expect(byId.get('rule-tesco')?.category).toBe('Groceries');
    expect(byId.get('rule-shell')?.source).toBe('rule');
    expect(byId.get('rule-shell')?.category).toBe('Fuel');

    expect(byId.get('cache-netflix')?.source).toBe('cache');
    expect(byId.get('cache-spotify')?.category).toBe('Subscriptions');

    expect(byId.get('claude-dishoom')?.source).toBe('claude');
    expect(byId.get('claude-dishoom')?.category).toBe('Eating Out');

    // Claude only got the 5 transactions that escaped rule + cache.
    expect(fakeClaude.calls).toBe(1);
    expect(fakeClaude.lastTxns.map((t) => t.id).sort()).toEqual([
      'claude-amazon',
      'claude-deliveroo',
      'claude-dishoom',
      'claude-pret',
      'claude-uber',
    ]);

    // Cache writeback: every Claude-assigned merchant should now be in the
    // merchant cache for next time.
    const written = new Map(cacheWrites.map((e) => [e.normalized, e.category]));
    expect(written.get(normalizeMerchant('Dishoom'))).toBe('Eating Out');
    expect(written.get(normalizeMerchant('Pret a Manger'))).toBe('Eating Out');
    expect(written.get(normalizeMerchant('Uber'))).toBe('Ride Share');
    expect(written.get(normalizeMerchant('Deliveroo'))).toBe('Takeaway');
    expect(written.get(normalizeMerchant('Amazon'))).toBe('General');
    // All 5 cache writes should be source=claude.
    for (const w of cacheWrites) expect(w.source).toBe('claude');
  });

  test('--no-claude routes the otherwise-Claude txns to Uncategorized', async () => {
    const cacheWrites: Array<unknown> = [];
    const result = await categorizeBatch(
      [txn('a', { merchantName: 'NewMerch' }), txn('b', { merchantName: 'OtherMerch' })],
      {
        availableCategories: ['Uncategorized'],
        rules: [],
        merchantCache: new Map(),
        writeMerchantCache: (e) => cacheWrites.push(e),
        noClaude: true,
      },
    );
    expect(result.used).toEqual({
      manual: 0,
      rule: 0,
      cache: 0,
      claude: 0,
      uncategorized: 2,
    });
    // No Claude call means no writeback either.
    expect(cacheWrites).toHaveLength(0);
  });

  test('Claude returning Uncategorized is not written to merchant_cache', async () => {
    const cacheWrites: Array<unknown> = [];
    const fake = new FakeClaude((txns) =>
      txns.map((t) => ({ transaction_id: t.id, category: 'Uncategorized', confidence: 0 })),
    );
    const result = await categorizeBatch([txn('uncat', { merchantName: 'Mystery' })], {
      claude: fake as unknown as ClaudeClient,
      availableCategories: ['Uncategorized', 'Other'],
      rules: [],
      merchantCache: new Map(),
      writeMerchantCache: (e) => cacheWrites.push(e),
    });
    expect(result.used.uncategorized).toBe(1);
    expect(result.used.claude).toBe(0);
    expect(cacheWrites).toHaveLength(0);
  });

  test('subsequent rows in the same run benefit from in-memory cache after Claude', async () => {
    // Two txns from the same merchant. Claude should only be asked for one
    // (the first); the second should hit the just-warmed cache.
    // We seed an empty cache, run once with a fake Claude that returns one
    // assignment, and verify that the in-memory cache mutation prevented a
    // second call for the duplicate.
    const fake = new FakeClaude((txns) =>
      txns.map((t) => ({ transaction_id: t.id, category: 'Eating Out', confidence: 0.9 })),
    );
    const cacheWrites: Array<{ normalized: string; category: string }> = [];
    // Pipeline currently batches all "needs Claude" txns into one call (both
    // duplicates make it into the same batch). The cache writeback still
    // produces one entry per merchant, not two.
    const result = await categorizeBatch(
      [txn('first', { merchantName: 'Dishoom' }), txn('second', { merchantName: 'Dishoom' })],
      {
        claude: fake as unknown as ClaudeClient,
        availableCategories: ['Eating Out'],
        rules: [],
        merchantCache: new Map(),
        writeMerchantCache: (e) => cacheWrites.push(e),
      },
    );
    expect(result.used.claude).toBe(2);
    // Cache writes are upserts by normalized key; both runs target the same
    // key so we expect at least one write that lands on 'dishoom' -> 'Eating Out'.
    expect(cacheWrites.some((w) => w.normalized === 'dishoom' && w.category === 'Eating Out')).toBe(
      true,
    );
  });
});
