// Dedupe logic for CSV imports.
//
// PRD §4.7:
// - For txns with provider_transaction_id, dedupe by id (won't apply for CSV).
// - For CSV: hash of (date, amount, description) -> check transactions.id.
//   - 'strict' requires exact match across all 3.
//   - 'loose' does fuzzy match on description (Levenshtein distance < 3 or
//     normalized substring).

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
 * Returns true when `candidate` matches some entry in `existing` per the chosen
 * strategy. Used to skip inserting a CSV row that already lives in the DB.
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
