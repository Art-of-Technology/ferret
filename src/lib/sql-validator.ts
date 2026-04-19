// SELECT-only SQL validator for the `query_transactions` Claude tool
// (PRD §4.5, §8.2 safety constraint).
//
// Threat model: a model-controlled SQL string is about to be passed to
// `db.prepare(sql).all(...)`. We therefore reject anything that:
//
//   - is not a single SELECT statement,
//   - contains a forbidden DDL/DML/PRAGMA token (case-insensitive,
//     word-boundary so `selected_row` is fine),
//   - hides forbidden tokens inside SQL comments (`-- ...`, `/* ... */`),
//   - sneaks a second statement into a string literal followed by `;`.
//
// The validator is intentionally conservative: false-positives are far
// cheaper than running an INSERT/DROP issued by a confused or malicious
// model. Everything throws `ValidationError` so the caller surfaces a
// PRD §7.2 exit-code-6 to the user.
//
// Trailing `;` is allowed (a single statement may end in a semicolon).
// Embedded `;` characters inside a single string literal are allowed
// (e.g. `WHERE description LIKE '%; %'`) provided no SQL after the
// closing quote re-enters statement scope.

import { ValidationError } from './errors';

/**
 * Forbidden top-level tokens. Any of these (case-insensitive,
 * word-boundary) anywhere in the comment-stripped query causes a reject.
 * `TRANSACTION` covers both `BEGIN TRANSACTION` and bare `TRANSACTION`.
 */
const FORBIDDEN_TOKENS = [
  'PRAGMA',
  'ATTACH',
  'DETACH',
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'CREATE',
  'ALTER',
  'REPLACE',
  'VACUUM',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'TRANSACTION',
  'SAVEPOINT',
] as const;

/**
 * Validate that `sql` is a single SELECT statement safe to execute via
 * `bun:sqlite`'s `db.prepare(sql).all(...)`. Throws `ValidationError`
 * with a descriptive message when the input fails any rule.
 *
 * Rules (applied in order so the first failure wins):
 *   1. Strip SQL comments (`-- to EOL`, `/* ... *\/` blocks). Comments are
 *      a known smuggling vector ("SELECT 1 -- INSERT INTO...") so all
 *      subsequent checks run against the stripped form.
 *   2. After trimming, the statement must start with the keyword SELECT
 *      (case-insensitive). WITH-CTEs and pragmas are rejected.
 *   3. Any `;` other than a single trailing one (after trimming) is
 *      rejected as a multi-statement attempt — including semicolons that
 *      sit outside string literals after the first `SELECT`.
 *   4. Forbidden DDL/DML/PRAGMA tokens are rejected case-insensitively
 *      with word boundaries.
 */
export function validateReadOnlySql(sql: string): void {
  if (typeof sql !== 'string') {
    throw new ValidationError('SQL must be a string');
  }
  if (sql.length === 0) {
    throw new ValidationError('SQL is empty');
  }

  const stripped = stripSqlComments(sql).trim();
  if (stripped.length === 0) {
    throw new ValidationError('SQL is empty after stripping comments');
  }

  // Rule 2: must start with SELECT.
  const firstWord = stripped.match(/^[A-Za-z_]+/);
  if (!firstWord || firstWord[0].toUpperCase() !== 'SELECT') {
    throw new ValidationError(
      `SQL must start with SELECT, got "${firstWord?.[0] ?? stripped.slice(0, 16)}"`,
    );
  }

  // Rule 3: at most one trailing semicolon. Find every `;` outside a
  // string literal; any non-final one is a multi-statement attempt. A
  // final `;` (only whitespace after it) is allowed.
  const semis = findTopLevelSemicolons(stripped);
  for (let i = 0; i < semis.length; i += 1) {
    const idx = semis[i];
    if (idx === undefined) continue;
    const tail = stripped.slice(idx + 1).trim();
    if (tail.length > 0) {
      throw new ValidationError('SQL must be a single statement; multiple statements detected');
    }
  }

  // Rule 4: no forbidden tokens, even nested. We scan BOTH the stripped
  // form (so semicolons inside string literals can't smuggle a `; DROP`
  // past us) AND the original (defence-in-depth: any forbidden token
  // anywhere — including inside a comment — gets rejected; we'd rather
  // false-positive on a benign code-comment that mentions DROP than risk
  // a parser-divergence trick where SQLite evaluates the comment and we
  // don't). Same word-boundary regex either way.
  const checks = [stripped.toUpperCase(), sql.toUpperCase()];
  for (const token of FORBIDDEN_TOKENS) {
    const re = new RegExp(`\\b${token}\\b`);
    if (checks.some((c) => re.test(c))) {
      throw new ValidationError(`SQL contains forbidden token: ${token}`);
    }
  }
}

/**
 * Strip `--`-to-EOL and `/* ... *\/` comments, respecting single-quoted
 * string literals so a literal `'--'` is preserved verbatim. SQLite's
 * standard double-quote-as-identifier is honoured (we don't treat `"`
 * as a string delimiter) since identifier quoting can't carry comment
 * tokens through.
 */
export function stripSqlComments(sql: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (inString) {
      out += ch;
      if (ch === "'") {
        // SQL string-literal escape is `''` (two single quotes).
        if (next === "'") {
          out += next;
          i += 2;
          continue;
        }
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === "'") {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '-' && next === '-') {
      // Skip until newline (or EOF).
      i += 2;
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      // Skip until closing `*/`. Unterminated block comments are treated
      // as comment-to-EOF.
      i += 2;
      while (i < sql.length) {
        if (sql[i] === '*' && sql[i + 1] === '/') {
          i += 2;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Return the indices of every `;` that sits OUTSIDE a single-quoted
 * string literal in `sql`. Used by rule 3 above to detect a multi-
 * statement payload.
 */
function findTopLevelSemicolons(sql: string): number[] {
  const out: number[] = [];
  let inString = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (inString) {
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          i += 1;
          continue;
        }
        inString = false;
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      continue;
    }
    if (ch === ';') out.push(i);
  }
  return out;
}
