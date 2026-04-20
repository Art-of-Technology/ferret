import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadFerretEnv,
  parseEnvFile,
  readFileOrEmpty,
  upsertEnvLine,
} from '../../src/lib/env-file';

describe('parseEnvFile', () => {
  test('parses plain KEY=value lines', () => {
    expect(parseEnvFile('FOO=bar\nBAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  test('trims whitespace around keys and values', () => {
    expect(parseEnvFile('  FOO  =  bar  ')).toEqual({ FOO: 'bar' });
  });

  test('skips blank lines and comment lines', () => {
    const input = ['# comment', '', 'FOO=bar', '   ', '# another', 'BAZ=qux'].join('\n');
    expect(parseEnvFile(input)).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  test('handles \\r\\n line endings', () => {
    expect(parseEnvFile('A=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' });
  });

  test('rejects keys with invalid characters', () => {
    // Hyphens, spaces, and leading digits are invalid env-var names
    // under the POSIX shell grammar we mirror here.
    const input = ['FOO-BAR=x', '9KEY=y', 'has space=z', 'OK=good'].join('\n');
    expect(parseEnvFile(input)).toEqual({ OK: 'good' });
  });

  test('ignores lines without = or starting with =', () => {
    expect(parseEnvFile('no_equals\n=no_key\nGOOD=yes')).toEqual({ GOOD: 'yes' });
  });

  test('strips matching double quotes', () => {
    expect(parseEnvFile('X="hello"')).toEqual({ X: 'hello' });
  });

  test('strips matching single quotes', () => {
    expect(parseEnvFile("X='hello'")).toEqual({ X: 'hello' });
  });

  test('leaves mismatched quotes intact', () => {
    // Value starts with " but ends with ' — not a matching pair,
    // so the quotes are preserved as literal characters rather than
    // silently collapsing to `hello'`.
    expect(parseEnvFile('X="hello\'')).toEqual({ X: '"hello\'' });
  });

  test('leaves a single lone quote character intact', () => {
    // A single " would otherwise be treated as both opening and
    // closing quote and collapse to the empty string. Guard against
    // that by requiring length >= 2 before stripping.
    expect(parseEnvFile('X="')).toEqual({ X: '"' });
    expect(parseEnvFile("X='")).toEqual({ X: "'" });
  });

  test('expands escape sequences inside double quotes', () => {
    expect(parseEnvFile('X="line1\\nline2"')).toEqual({ X: 'line1\nline2' });
    expect(parseEnvFile('X="col1\\tcol2"')).toEqual({ X: 'col1\tcol2' });
    expect(parseEnvFile('X="back\\\\slash"')).toEqual({ X: 'back\\slash' });
    expect(parseEnvFile('X="quote\\""')).toEqual({ X: 'quote"' });
  });

  test('single quotes are literal — no escape expansion', () => {
    expect(parseEnvFile("X='line1\\nline2'")).toEqual({ X: 'line1\\nline2' });
  });

  test('preserves embedded equals signs in values', () => {
    // The split is on the *first* `=` only — values containing `=`
    // (e.g. base64-encoded tokens) must round-trip unchanged.
    expect(parseEnvFile('KEY=a=b=c')).toEqual({ KEY: 'a=b=c' });
  });

  test('last occurrence of a key wins', () => {
    // Matches the behaviour most dotenv parsers document.
    expect(parseEnvFile('X=first\nX=second')).toEqual({ X: 'second' });
  });
});

describe('loadFerretEnv', () => {
  let dir: string;
  let envPath: string;
  const savedEnv: Record<string, string | undefined> = {};
  const keysUnderTest = ['FERRET_TEST_A', 'FERRET_TEST_B', 'FERRET_TEST_C'];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ferret-env-file-'));
    envPath = join(dir, '.env');
    for (const k of keysUnderTest) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of keysUnderTest) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns silently when the file does not exist', () => {
    loadFerretEnv(join(dir, 'missing.env'));
    expect(process.env.FERRET_TEST_A).toBeUndefined();
  });

  test('loads values into process.env when unset', () => {
    writeFileSync(envPath, 'FERRET_TEST_A=from_file\nFERRET_TEST_B=other\n');
    loadFerretEnv(envPath);
    expect(process.env.FERRET_TEST_A).toBe('from_file');
    expect(process.env.FERRET_TEST_B).toBe('other');
  });

  test('does NOT override values already set in process.env (shell wins)', () => {
    process.env.FERRET_TEST_A = 'from_shell';
    writeFileSync(envPath, 'FERRET_TEST_A=from_file\nFERRET_TEST_B=only_in_file\n');
    loadFerretEnv(envPath);
    expect(process.env.FERRET_TEST_A).toBe('from_shell');
    expect(process.env.FERRET_TEST_B).toBe('only_in_file');
  });

  test('skips empty values even when process.env slot is unset', () => {
    writeFileSync(envPath, 'FERRET_TEST_A=\nFERRET_TEST_B=value\n');
    loadFerretEnv(envPath);
    expect(process.env.FERRET_TEST_A).toBeUndefined();
    expect(process.env.FERRET_TEST_B).toBe('value');
  });
});

describe('readFileOrEmpty', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ferret-readfile-'));
  });

  afterEach(() => {
    // Restore readable perms on anything we chmod'd so rmSync can tear
    // the tree down even when a test intentionally revoked access.
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Best effort — rmSync will still surface a real problem below.
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns the file contents when it exists', () => {
    const path = join(dir, 'a.txt');
    writeFileSync(path, 'hello');
    expect(readFileOrEmpty(path)).toBe('hello');
  });

  test('returns empty string when the file does not exist (ENOENT)', () => {
    expect(readFileOrEmpty(join(dir, 'missing.txt'))).toBe('');
  });

  test('rethrows errors that are not ENOENT', () => {
    // Pass a directory path to force EISDIR — a non-ENOENT error that
    // the helper should propagate rather than silently swallow.
    expect(() => readFileOrEmpty(dir)).toThrow();
  });
});

describe('upsertEnvLine', () => {
  test('appends a new KEY=value when the key is not present', () => {
    expect(upsertEnvLine('', 'FOO', 'bar')).toBe('FOO=bar\n');
  });

  test('inserts a blank line before appending when the file is non-empty', () => {
    const result = upsertEnvLine('EXISTING=1\n', 'FOO', 'bar');
    expect(result).toBe('EXISTING=1\n\nFOO=bar\n');
  });

  test('does not insert a second blank line if one already trails the file', () => {
    const result = upsertEnvLine('EXISTING=1\n\n', 'FOO', 'bar');
    expect(result).toBe('EXISTING=1\n\nFOO=bar\n');
  });

  test('replaces an existing key in place', () => {
    const result = upsertEnvLine('FOO=old\nBAR=keep\n', 'FOO', 'new');
    expect(result).toBe('FOO=new\nBAR=keep\n');
  });

  test('collapses duplicate assignments of the same key', () => {
    const result = upsertEnvLine('FOO=a\nBAR=keep\nFOO=b\n', 'FOO', 'new');
    expect(result).toBe('FOO=new\nBAR=keep\n');
  });

  test('preserves comments and blank lines', () => {
    const input = '# header comment\n\nFOO=old\n# trailing comment\n';
    const result = upsertEnvLine(input, 'FOO', 'new');
    expect(result).toBe('# header comment\n\nFOO=new\n# trailing comment\n');
  });

  test('handles \\r\\n input and normalises to \\n output', () => {
    const result = upsertEnvLine('A=1\r\nB=2\r\n', 'B', '3');
    expect(result).toBe('A=1\nB=3\n');
  });

  test('guarantees exactly one trailing newline', () => {
    expect(upsertEnvLine('A=1', 'B', '2').endsWith('\n')).toBe(true);
    expect(upsertEnvLine('A=1\n\n\n', 'B', '2').endsWith('\n\n')).toBe(false);
  });
});
