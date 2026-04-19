// Dedupe logic for CSV imports.
//
// PRD §4.7:
// - For txns with provider_transaction_id, dedupe by id (won't apply for CSV).
// - For CSV: hash of (date, amount, description) -> check transactions.id.
//   - 'strict' requires exact match across all 3.
//   - 'loose' does fuzzy match on description (Levenshtein distance < 3 or
//     normalized substring).
//
// Performance note: the orchestrator narrows the candidate set to a date
// window before calling these helpers, so `existing` here is already small
// (typically a few dozen rows, not the whole account history). Both modes
// additionally use a pre-built hash index to avoid the O(parsed × window)
// inner scan:
//   - strict: key = (date, amount, normalized desc) — exact O(1) lookup, see
//     `buildStrictIndex` / `isDuplicateStrict`.
//   - loose:  key = (date, amount) — bucket lookup with the (small) bucket
//     scanned for substring/Levenshtein, see `buildLooseBuckets` /
//     `isDuplicateLoose`. Average case O(parsed + window); worst case still
//     O(parsed × window) but only when every existing row shares the same
//     (date, amount), which is vanishingly unlikely in real bank data.

export interface DedupeCandidate {
  id: string;
  date: Date;
  amount: number;
  description: string;
}

export interface ExistingTxn {
  id: string;
  date: Date;
  amount: number;
  description: string;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Hash key for strict-mode dedupe: (yyyy-MM-dd, amount-rounded, normalized desc).
 *
 * We round to cents to avoid floating-point jitter producing distinct keys for
 * the same logical amount (e.g. 12.5 vs 12.500000000000002).
 */
function strictKey(date: Date, amount: number, description: string): string {
  const iso = date.toISOString().slice(0, 10);
  const cents = Math.round(amount * 100);
  return `${iso}|${cents}|${normalize(description)}`;
}

/**
 * Pre-built index for strict-mode dedupe. Build once per import batch, query
 * O(1) per candidate row. Also exposes the raw id set for the id-equality
 * short-circuit (covers re-importing the exact same file).
 */
export interface StrictDedupeIndex {
  ids: Set<string>;
  keys: Set<string>;
}

export function buildStrictIndex(existing: readonly ExistingTxn[]): StrictDedupeIndex {
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const ex of existing) {
    ids.add(ex.id);
    keys.add(strictKey(ex.date, ex.amount, ex.description));
  }
  return { ids, keys };
}

/**
 * Returns true when `candidate` matches some entry in `existing` per the chosen
 * strategy. Used to skip inserting a CSV row that already lives in the DB.
 *
 * `existing` should already be narrowed to a date window by the caller (the
 * orchestrator does this for each import batch). For strict-mode hot loops,
 * prefer `isDuplicateStrict` with a pre-built index.
 */
export function isDuplicate(
  candidate: DedupeCandidate,
  existing: readonly ExistingTxn[],
  strategy: 'strict' | 'loose',
): boolean {
  // Fast id-equality short-circuit (covers re-imports of the exact same file).
  for (const ex of existing) {
    if (ex.id === candidate.id) return true;
  }

  if (strategy === 'strict') {
    return existing.some((ex) => strictEquals(ex, candidate));
  }
  return existing.some((ex) => looseEquals(ex, candidate));
}

/**
 * Strict-mode dedupe via pre-built hash index. O(1) per call.
 */
export function isDuplicateStrict(candidate: DedupeCandidate, index: StrictDedupeIndex): boolean {
  if (index.ids.has(candidate.id)) return true;
  return index.keys.has(strictKey(candidate.date, candidate.amount, candidate.description));
}

/**
 * Bucket key for loose-mode dedupe: (yyyy-MM-dd, amount-rounded). Description
 * is intentionally excluded — loose mode allows substring / small-edit
 * differences in description, so we hash on the parts that must match
 * exactly and scan within the (typically tiny) bucket.
 */
function looseBucketKey(date: Date, amount: number): string {
  const iso = date.toISOString().slice(0, 10);
  const cents = Math.round(amount * 100);
  return `${iso}|${cents}`;
}

/**
 * Pre-built bucket index for loose-mode dedupe. Build once per import batch.
 *
 * Average case: O(parsed + window) total across all rows, since each candidate
 * looks up a bucket in O(1) and most buckets contain 0–3 entries. The id set
 * powers the same id-equality short-circuit as the strict path.
 */
export interface LooseDedupeIndex {
  ids: Set<string>;
  buckets: Map<string, ExistingTxn[]>;
}

// O(parsed + window) average: O(window) to build buckets once, O(1) lookup +
// O(bucket size) scan per parsed row. See module header for full reasoning.
export function buildLooseBuckets(existing: readonly ExistingTxn[]): LooseDedupeIndex {
  const ids = new Set<string>();
  const buckets = new Map<string, ExistingTxn[]>();
  for (const ex of existing) {
    ids.add(ex.id);
    // Loose mode tolerates ±1 day, so index the row under its own day AND the
    // adjacent days. This keeps lookup a single O(1) hit per candidate.
    const dayMs = ex.date.getTime();
    for (const offset of [-ONE_DAY_MS, 0, ONE_DAY_MS] as const) {
      const key = looseBucketKey(new Date(dayMs + offset), ex.amount);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = [];
        buckets.set(key, bucket);
      }
      bucket.push(ex);
    }
  }
  return { ids, buckets };
}

/**
 * Loose-mode dedupe via pre-built bucket index. Average O(1) per call (plus
 * a small constant for the in-bucket fuzzy check).
 */
export function isDuplicateLoose(candidate: DedupeCandidate, index: LooseDedupeIndex): boolean {
  if (index.ids.has(candidate.id)) return true;
  const bucket = index.buckets.get(looseBucketKey(candidate.date, candidate.amount));
  if (!bucket) return false;
  // Bucket already filtered to (same day ± 1, same rounded amount). The
  // remaining work is the description fuzzy match, scoped to a handful of rows.
  for (const ex of bucket) {
    if (looseEquals(ex, candidate)) return true;
  }
  return false;
}

function strictEquals(a: ExistingTxn, b: DedupeCandidate): boolean {
  if (!sameDay(a.date, b.date)) return false;
  if (Math.abs(a.amount - b.amount) > 0.005) return false;
  return normalize(a.description) === normalize(b.description);
}

function looseEquals(a: ExistingTxn, b: DedupeCandidate): boolean {
  // Loose: same day (or adjacent day), amount equal to within 0.01, and
  // description either substring-matches normalized form OR Levenshtein < 3.
  if (Math.abs(a.date.getTime() - b.date.getTime()) > ONE_DAY_MS) return false;
  if (Math.abs(a.amount - b.amount) > 0.01) return false;

  const aDesc = normalize(a.description);
  const bDesc = normalize(b.description);
  if (!aDesc || !bDesc) return aDesc === bDesc;
  if (aDesc === bDesc) return true;
  if (aDesc.includes(bDesc) || bDesc.includes(aDesc)) return true;
  return levenshtein(aDesc, bDesc) < 3;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Iterative two-row Levenshtein distance. O(n*m) time, O(min(n,m)) space.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Make `short` the shorter to keep memory low.
  const short = a.length > b.length ? b : a;
  const long = a.length > b.length ? a : b;

  const m = short.length;
  const n = long.length;
  let prev = new Array<number>(m + 1);
  let curr = new Array<number>(m + 1);
  for (let i = 0; i <= m; i++) prev[i] = i;

  for (let j = 1; j <= n; j++) {
    curr[0] = j;
    const bj = long.charCodeAt(j - 1);
    for (let i = 1; i <= m; i++) {
      const cost = short.charCodeAt(i - 1) === bj ? 0 : 1;
      const del = (prev[i] as number) + 1;
      const ins = (curr[i - 1] as number) + 1;
      const sub = (prev[i - 1] as number) + cost;
      let min = del;
      if (ins < min) min = ins;
      if (sub < min) min = sub;
      curr[i] = min;
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[m] as number;
}
