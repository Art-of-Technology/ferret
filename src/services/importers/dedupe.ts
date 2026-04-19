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
// (typically a few dozen rows, not the whole account history). The strict
// path additionally short-circuits via id-equality and a (date,amount,desc)
// hash index built once per import — see `buildStrictIndex` below.

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
