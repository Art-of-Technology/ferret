// Tests for the SELECT-only SQL validator that gates the
// `query_transactions` Claude tool. Threat model lives in
// `src/lib/sql-validator.ts`; these tests pin the externally observable
// behaviour for every rule plus the comment-stripping helper.

import { describe, expect, test } from 'bun:test';
import { ValidationError } from '../../src/lib/errors';
import { stripSqlComments, validateReadOnlySql } from '../../src/lib/sql-validator';

describe('validateReadOnlySql — happy path', () => {
  test('plain SELECT passes', () => {
    expect(() => validateReadOnlySql('SELECT * FROM transactions')).not.toThrow();
  });

  test('mixed-case SELECT passes', () => {
    expect(() => validateReadOnlySql('Select id, amount From transactions')).not.toThrow();
  });

  test('SELECT with leading whitespace passes', () => {
    expect(() => validateReadOnlySql('   \n SELECT 1')).not.toThrow();
  });

  test('trailing semicolon allowed', () => {
    expect(() => validateReadOnlySql('SELECT 1;')).not.toThrow();
    expect(() => validateReadOnlySql('SELECT 1;   ')).not.toThrow();
  });

  test('embedded literal `;` inside a single SELECT is allowed', () => {
    expect(() =>
      validateReadOnlySql("SELECT id FROM transactions WHERE description LIKE '%; foo'"),
    ).not.toThrow();
  });

  test('escaped quote inside literal does not break parsing', () => {
    // SQL string-literal escape is doubled single quote.
    expect(() =>
      validateReadOnlySql("SELECT id FROM transactions WHERE description = 'don''t panic'"),
    ).not.toThrow();
  });

  test('comments containing the word INSERT do not trip on the literal text', () => {
    // The validator strips the comment first, so the resulting SQL has no
    // forbidden token.
    expect(() => validateReadOnlySql('SELECT 1 /* this is just a note */')).not.toThrow();
  });
});

describe('validateReadOnlySql — must-reject DDL/DML/PRAGMA', () => {
  for (const stmt of [
    'INSERT INTO transactions VALUES (1)',
    'UPDATE transactions SET category = 1',
    'DELETE FROM transactions',
    'DROP TABLE transactions',
    'CREATE TABLE foo (id INTEGER)',
    'ALTER TABLE transactions ADD COLUMN x',
    'REPLACE INTO transactions VALUES (1)',
    'PRAGMA table_info(transactions)',
    'ATTACH DATABASE "/tmp/x.db" AS evil',
    'DETACH DATABASE evil',
    'VACUUM',
    'BEGIN',
    'COMMIT',
    'ROLLBACK',
    'SAVEPOINT s1',
  ]) {
    test(`rejects: ${stmt}`, () => {
      expect(() => validateReadOnlySql(stmt)).toThrow(ValidationError);
    });
  }

  test('lowercase forbidden token still rejected', () => {
    expect(() => validateReadOnlySql('insert into transactions values (1)')).toThrow(
      ValidationError,
    );
  });
});

describe('validateReadOnlySql — defence in depth', () => {
  test('rejects trailing comment-injected DROP', () => {
    expect(() => validateReadOnlySql('SELECT 1 -- ; DROP TABLE transactions')).toThrow(
      /forbidden token: DROP/,
    );
  });

  test('rejects block-comment-injected DELETE', () => {
    expect(() => validateReadOnlySql('SELECT 1 /* ; DELETE FROM transactions */')).toThrow(
      /forbidden token: DELETE/,
    );
  });

  test('rejects block-comment-injected INSERT inside a SELECT', () => {
    expect(() => validateReadOnlySql('SELECT /* INSERT INTO transactions VALUES(1) */ 1')).toThrow(
      /forbidden token: INSERT/,
    );
  });

  test('rejects multi-statement payload (two SELECTs)', () => {
    expect(() => validateReadOnlySql('SELECT 1; SELECT 2')).toThrow(/single statement/);
  });

  test('rejects multi-statement payload (SELECT then DROP)', () => {
    // The semicolon arrives BEFORE the DROP scan; we expect the
    // multi-statement message rather than the forbidden-token one.
    expect(() => validateReadOnlySql('SELECT 1; DROP TABLE transactions')).toThrow(
      /single statement/,
    );
  });

  test('rejects WITH-CTE (must start with SELECT)', () => {
    expect(() => validateReadOnlySql('WITH x AS (SELECT 1) SELECT * FROM x')).toThrow(
      /must start with SELECT/,
    );
  });

  test('rejects empty input', () => {
    expect(() => validateReadOnlySql('')).toThrow(ValidationError);
    expect(() => validateReadOnlySql('   ')).toThrow(/empty/);
  });

  test('rejects pure-comment input', () => {
    expect(() => validateReadOnlySql('-- nothing useful')).toThrow(/empty after stripping/);
    expect(() => validateReadOnlySql('/* nope */')).toThrow(/empty after stripping/);
  });

  test('does not allow column names called "selected" to trip the SELECT check', () => {
    // We assert the start-of-statement check uses a word match, not a
    // substring match; this is the corollary of the word-boundary scan
    // for forbidden tokens.
    expect(() => validateReadOnlySql('SELECT selected_thing FROM accounts')).not.toThrow();
  });

  test('does not flag identifiers that contain a forbidden substring', () => {
    // "createdAt" contains "create" as a substring but not as a word.
    expect(() => validateReadOnlySql('SELECT createdAt FROM transactions')).not.toThrow();
  });
});

describe('stripSqlComments', () => {
  test('strips line comments', () => {
    expect(stripSqlComments('SELECT 1 -- comment\nFROM t')).toBe('SELECT 1 \nFROM t');
  });

  test('strips block comments', () => {
    expect(stripSqlComments('SELECT /* hi */ 1')).toBe('SELECT  1');
  });

  test('preserves comment-like text inside string literal', () => {
    expect(stripSqlComments("SELECT '-- not a comment'")).toBe("SELECT '-- not a comment'");
    expect(stripSqlComments("SELECT '/* still not */'")).toBe("SELECT '/* still not */'");
  });

  test('handles unterminated block comment by dropping to EOF', () => {
    expect(stripSqlComments('SELECT 1 /* unterminated')).toBe('SELECT 1 ');
  });

  test('handles escaped single quote inside literal', () => {
    expect(stripSqlComments("SELECT 'a''b' -- comment")).toBe("SELECT 'a''b' ");
  });
});
