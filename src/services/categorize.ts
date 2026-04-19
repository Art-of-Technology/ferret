// Categorization pipeline (PRD §4.4).
//
// Order of precedence:
//   1. manual override (handled at the command layer, not here)
//   2. rule match (regex against merchant or description, priority DESC)
//   3. merchant cache (exact match on normalized merchant)
//   4. Claude classification (batched, optional)
//   5. Uncategorized
//
// The pipeline returns assignments per transaction plus a counts breakdown
// the command layer renders. Cache writeback after Claude: every newly
// classified merchant is written to `merchant_cache` so the next run skips
// the API call (PRD §8.2 cost note: steady-state cost trends to zero).

import type { RuleRow, TxnAssignment, UncategorizedTxn } from '../db/queries/categorize';
import {
  getRules as defaultGetRules,
  loadMerchantCache as defaultLoadMerchantCache,
  upsertMerchantCacheEntry as defaultUpsertMerchantCacheEntry,
} from '../db/queries/categorize';
import type { ClaudeClient, TxnLite } from './claude';

export type AssignmentSource = TxnAssignment['source'] | 'uncategorized';

export interface SourceCounts {
  manual: number;
  rule: number;
  cache: number;
  claude: number;
  uncategorized: number;
}

export interface CategorizationResult {
  /** Per-transaction outcome. Always one entry per input. */
  categorized: PipelineAssignment[];
  /** Tally by source for the summary print-out. */
  used: SourceCounts;
}

export interface PipelineAssignment {
  transactionId: string;
  category: string;
  source: AssignmentSource;
  confidence?: number;
  /** Which rule matched, when source = 'rule'. */
  ruleId?: string;
}

export interface CategorizeOptions {
  /** Inject a Claude client. If omitted, the Claude step is skipped (rule-only). */
  claude?: ClaudeClient;
  /** Categories the LLM is allowed to pick from. */
  availableCategories: string[];
  /** Override pre-loaded rules (test injection). */
  rules?: RuleRow[];
  /** Override pre-loaded merchant cache (test injection). */
  merchantCache?: Map<string, string>;
  /**
   * Override the cache writeback. When undefined, real DB writes happen
   * (the pipeline persists every Claude assignment to merchant_cache).
   */
  writeMerchantCache?: (entry: {
    normalized: string;
    category: string;
    confidence: number | null;
    source: 'claude' | 'manual';
  }) => void;
  /** Set true to skip the Claude step entirely (e.g. --no-claude). */
  noClaude?: boolean;
}

/**
 * Normalize a merchant string for cache keys: lower-case, strip non-alnum,
 * collapse whitespace runs to a single space, trim. The same function is
 * used both when seeding the cache (post-Claude) and when looking up.
 *
 * Examples:
 *   "Tesco Stores 4567" -> "tesco stores 4567"
 *   "PRET A MANGER #21" -> "pret a manger 21"
 *   "  Amazon.co.uk  "  -> "amazon co uk"
 */
export function normalizeMerchant(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Resolve which string the rule should regex-match against. */
function fieldValue(txn: UncategorizedTxn, field: string): string {
  if (field === 'merchant') return txn.merchantName ?? '';
  return txn.description ?? '';
}

/**
 * Sort a rule list into the canonical apply order: priority DESC, id ASC.
 * Returns a new array; input is not mutated. `getRules()` already returns
 * rules in this order, so callers loading from the DB can skip this; only
 * use it when the caller has hand-built or merged a rule list.
 */
export function sortRules(ruleList: RuleRow[]): RuleRow[] {
  return [...ruleList].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Apply the rule list in priority order. Returns the first matching rule
 * (highest priority wins). The list MUST be pre-sorted (priority DESC,
 * id ASC) — `categorizeBatch` sorts once and passes it in here so we
 * don't re-sort per transaction. Bad regex rows are skipped.
 */
export function applyRules(
  txn: UncategorizedTxn,
  sortedRules: RuleRow[],
): { category: string; ruleId: string } | null {
  for (const rule of sortedRules) {
    let re: RegExp;
    try {
      // Case-insensitive by default — matches user expectations
      // (`^Tesco` should match `tesco superstore 99`).
      re = new RegExp(rule.pattern, 'i');
    } catch {
      continue;
    }
    const value = fieldValue(txn, rule.field);
    if (re.test(value)) {
      return { category: rule.category, ruleId: rule.id };
    }
  }
  return null;
}

/**
 * Apply the merchant cache. Exact match on normalized merchant. We try the
 * merchant_name column first (preferred), then fall back to description so
 * banks that don't surface a clean merchant still get cache hits.
 */
export function applyMerchantCache(
  txn: UncategorizedTxn,
  cache: Map<string, string>,
): { category: string; key: string } | null {
  const candidates: string[] = [];
  if (txn.merchantName) candidates.push(normalizeMerchant(txn.merchantName));
  candidates.push(normalizeMerchant(txn.description));
  for (const key of candidates) {
    if (key.length === 0) continue;
    const cat = cache.get(key);
    if (cat) return { category: cat, key };
  }
  return null;
}

/**
 * Run the full pipeline against a list of uncategorized transactions.
 * `manual` is never returned by this function — the manual override flow
 * lives in the command layer and writes directly via
 * `applyCategoryAssignments`. The 'manual' field on `used` is therefore
 * always 0 here.
 */
export async function categorizeBatch(
  uncategorized: UncategorizedTxn[],
  opts: CategorizeOptions,
  // Allow swapping the DB-backed loaders for tests. Defaults read live.
  deps: {
    getRules?: typeof defaultGetRules;
    loadMerchantCache?: typeof defaultLoadMerchantCache;
    upsertMerchantCacheEntry?: typeof defaultUpsertMerchantCacheEntry;
  } = {},
): Promise<CategorizationResult> {
  // Sort the rule list once for the whole batch. `getRules()` already
  // returns them sorted, but caller-injected `opts.rules` (tests, future
  // overrides) may not be — sort defensively a single time, not per txn.
  const ruleList = sortRules(opts.rules ?? (deps.getRules ?? defaultGetRules)());
  const cache = opts.merchantCache ?? (deps.loadMerchantCache ?? defaultLoadMerchantCache)();
  const writeCache = opts.writeMerchantCache ?? createDefaultCacheWriter(deps);

  const out: PipelineAssignment[] = [];
  const counts: SourceCounts = {
    manual: 0,
    rule: 0,
    cache: 0,
    claude: 0,
    uncategorized: 0,
  };

  // Stage 2 + 3: rule and cache. Anything that escapes both becomes a
  // candidate for Claude (or 'uncategorized' if --no-claude).
  const claudeQueue: UncategorizedTxn[] = [];

  for (const txn of uncategorized) {
    const ruleHit = applyRules(txn, ruleList);
    if (ruleHit) {
      out.push({
        transactionId: txn.id,
        category: ruleHit.category,
        source: 'rule',
        ruleId: ruleHit.ruleId,
      });
      counts.rule += 1;
      continue;
    }
    const cacheHit = applyMerchantCache(txn, cache);
    if (cacheHit) {
      out.push({
        transactionId: txn.id,
        category: cacheHit.category,
        source: 'cache',
      });
      counts.cache += 1;
      continue;
    }
    claudeQueue.push(txn);
  }

  // Stage 4: Claude — only if we have a client AND we weren't told to skip.
  if (claudeQueue.length > 0 && opts.claude && !opts.noClaude) {
    const lite: TxnLite[] = claudeQueue.map((t) => ({
      id: t.id,
      merchant: t.merchantName ?? t.description,
      description: t.description,
      amount: t.amount,
      currency: t.currency,
    }));
    const assignments = await opts.claude.categorize(lite, opts.availableCategories);
    const byId = new Map<string, (typeof assignments)[number]>();
    for (const a of assignments) byId.set(a.transaction_id, a);

    for (const txn of claudeQueue) {
      const a = byId.get(txn.id);
      // Distinguish three signals:
      //   - no assignment back from Claude (a === undefined) -> Uncategorized,
      //     confidence is `undefined` so downstream knows it's "missing".
      //   - explicit Uncategorized -> respect Claude's confidence (which the
      //     wrapper guarantees is 0 for Uncategorized, but we don't conflate
      //     "missing" with "returned zero").
      //   - any other category -> source = claude, even at confidence 0
      //     (a 0-confidence non-Uncategorized result is still a deliberate
      //     pick by Claude; we record it rather than silently dropping it).
      if (!a) {
        out.push({
          transactionId: txn.id,
          category: 'Uncategorized',
          source: 'uncategorized',
        });
        counts.uncategorized += 1;
        continue;
      }
      if (a.category === 'Uncategorized') {
        out.push({
          transactionId: txn.id,
          category: 'Uncategorized',
          source: 'uncategorized',
          confidence: a.confidence,
        });
        counts.uncategorized += 1;
        continue;
      }
      const category = a.category;
      const confidence = a.confidence;
      out.push({
        transactionId: txn.id,
        category,
        source: 'claude',
        confidence,
      });
      counts.claude += 1;
      // Cache writeback: future txns from the same merchant skip Claude.
      // Prefer merchant_name; fall back to description so banks that don't
      // surface a clean merchant still get a useful cache key. The local
      // in-memory map is mutated as well so subsequent rows in the same
      // run also benefit.
      const key = normalizeMerchant(txn.merchantName ?? txn.description);
      if (key.length > 0) {
        cache.set(key, category);
        writeCache({
          normalized: key,
          category,
          confidence,
          source: 'claude',
        });
      }
    }
  } else {
    // No Claude available (or --no-claude): fall through as Uncategorized.
    for (const txn of claudeQueue) {
      out.push({
        transactionId: txn.id,
        category: 'Uncategorized',
        source: 'uncategorized',
      });
      counts.uncategorized += 1;
    }
  }

  return { categorized: out, used: counts };
}

function createDefaultCacheWriter(deps: {
  upsertMerchantCacheEntry?: typeof defaultUpsertMerchantCacheEntry;
}): NonNullable<CategorizeOptions['writeMerchantCache']> {
  const upsert = deps.upsertMerchantCacheEntry ?? defaultUpsertMerchantCacheEntry;
  return (entry) => upsert(entry);
}

/**
 * Filter the pipeline output down to the subset that should actually be
 * written back to `transactions`. Currently: everything except the
 * 'uncategorized' fallback (we leave those rows NULL so a future `tag` run
 * picks them up again).
 */
export function toTxnUpdates(result: CategorizationResult): TxnAssignment[] {
  const out: TxnAssignment[] = [];
  for (const a of result.categorized) {
    if (a.source === 'uncategorized') continue;
    out.push({
      transactionId: a.transactionId,
      category: a.category,
      source: a.source as TxnAssignment['source'],
    });
  }
  return out;
}
