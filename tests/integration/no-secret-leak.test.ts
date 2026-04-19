// Compliance regression test (#45): no canary secret placed in env vars or a
// keychain stub may ever appear in any command's stdout/stderr, including
// --help screens, validation-error paths, and --verbose runs.
//
// Strategy:
//   1. Seed env vars with canary tokens so `resolveSecret` etc. pick them up.
//   2. Preload `tests/integration/keychain-preload.ts` into each subprocess so
//      `FERRET_TEST_KEYCHAIN_SEED` replaces the real OS keychain with an
//      in-memory stub containing the keychain-only canaries.
//   3. Run every command in EXPECTED_COMMANDS with --help, with deliberately
//      bad args, and — where supported — with --verbose.
//   4. Assert no canary string leaks into combined stdout+stderr for any run.

import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb, resetDbCache } from '../../src/db/client';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI_ENTRY = join(PROJECT_ROOT, 'src', 'cli.ts');
const PRELOAD = join(PROJECT_ROOT, 'tests', 'integration', 'keychain-preload.ts');

// Canary strings. The literal substrings we assert on are short and unique so
// a coincidental match against random help text is impossible.
const CANARIES = {
  anthropic: 'sk-ant-CANARY-claude-DEADBEEF',
  tlSecret: 'CANARY-truelayer-DEADBEEF',
  tlId: 'CANARY-id-DEADBEEF',
  access: 'CANARY-access-DEADBEEF',
  refresh: 'CANARY-refresh-DEADBEEF',
} as const;

// Duplicated from tests/unit/cli.test.ts on purpose: we want the regression
// suite to catch a drift if either test's list goes stale relative to the
// registry. The cli.test.ts test exercises the "registry matches help"
// invariant; this test exercises the "registry matches log hygiene"
// invariant.
const EXPECTED_COMMANDS = [
  'init',
  'link',
  'unlink',
  'remove',
  'connections',
  'sync',
  'ls',
  'tag',
  'rules',
  'ask',
  'budget',
  'import',
  'export',
  'config',
  'version',
  'purge',
];

// Commands that accept --verbose. The CLI currently doesn't formally declare
// it on most commands, but running them with --verbose still exercises the
// argv path without changing correctness for the leak test.
const VERBOSE_COMMANDS = ['ask', 'sync', 'tag'] as const;

// Deliberately-bad argument sets that should trigger the validation-error
// path for each applicable command. Commands without required args simply
// run (or print help), which is still useful coverage.
const BAD_ARGS: Record<string, string[]> = {
  unlink: [], // unlink requires <connectionId>
  remove: ['--all', 'conn-x'], // mutually exclusive flags per remove.ts
  rules: ['add', '[invalid-regex', 'Groceries'],
  budget: ['set', 'Groceries', 'not-a-number'],
  import: [], // import requires <file>
  export: ['--format', 'yaml'],
  purge: [], // purge without --confirm
  // `--timeout notanumber` is rejected BEFORE the OAuth server spawns, so the
  // test doesn't hang and no authorize URL (which legitimately contains the
  // client_id) is ever printed.
  link: ['--timeout', 'notanumber'],
  config: ['get'], // config get without key
  ask: [], // ask without prompt
  tag: ['--unknown-flag'],
  sync: ['--history', 'nope'],
  ls: ['--since', 'not-a-date'],
};

function buildEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.HOME = home;
  env.NO_COLOR = '1';
  // Match cli.test.ts: force production so consola doesn't suppress citty
  // --help output under bun:test's auto NODE_ENV=test.
  env.NODE_ENV = 'production';
  env.ANTHROPIC_API_KEY = CANARIES.anthropic;
  env.TRUELAYER_CLIENT_SECRET = CANARIES.tlSecret;
  env.TRUELAYER_CLIENT_ID = CANARIES.tlId;
  env.FERRET_TEST_KEYCHAIN_SEED = JSON.stringify([
    { account: 'truelayer:seed-conn-001:access', password: CANARIES.access },
    { account: 'truelayer:seed-conn-001:refresh', password: CANARIES.refresh },
    { account: 'anthropic:api_key', password: CANARIES.anthropic },
    { account: 'truelayer:client_secret', password: CANARIES.tlSecret },
  ]);
  return env;
}

interface RunResult {
  label: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runFerret(label: string, args: string[], home: string): RunResult {
  const res = Bun.spawnSync({
    cmd: ['bun', 'run', '--preload', PRELOAD, CLI_ENTRY, ...args],
    cwd: PROJECT_ROOT,
    env: buildEnv(home),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    label,
    stdout: res.stdout.toString(),
    stderr: res.stderr.toString(),
    exitCode: res.exitCode ?? 0,
  };
}

function assertNoLeak(result: RunResult): void {
  const combined = `${result.stdout}\n${result.stderr}`;
  for (const [name, value] of Object.entries(CANARIES)) {
    if (combined.includes(value)) {
      throw new Error(
        `Canary "${name}" (${value}) leaked into output of "${result.label}"\n` +
          `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
      );
    }
  }
}

function seedDatabase(home: string): void {
  // Inject a connection row whose id matches the keychain stub's CANARY
  // tokens. Done in-process (no network, no keytar). The HOME override must
  // already be active when this is called so `getDb()` resolves to the tmp
  // dir rather than the real ~/.ferret.
  process.env.HOME = home;
  const here = fileURLToPath(new URL('.', import.meta.url));
  const migrationsDir = resolve(here, '..', '..', 'src', 'db', 'migrations');
  resetDbCache();
  const { db, raw } = getDb();
  migrate(db, { migrationsFolder: migrationsDir });
  const now = Math.floor(Date.now() / 1000);
  raw
    .prepare(
      `INSERT OR IGNORE INTO connections
         (id, provider_id, provider_name, created_at, expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('seed-conn-001', 'test', 'Test Bank', now, now + 86400, 'active');
  resetDbCache();
}

test('no canary secret leaks into any command output', () => {
  const home = mkdtempSync(join(tmpdir(), 'ferret-leak-'));
  const prevHome = process.env.HOME;
  try {
    seedDatabase(home);
  } finally {
    // Restore the parent process HOME; children get `home` via buildEnv.
    if (prevHome === undefined) {
      process.env.HOME = '';
    } else {
      process.env.HOME = prevHome;
    }
  }

  const runs: RunResult[] = [];

  // Top-level help.
  runs.push(runFerret('ferret --help', ['--help'], home));

  for (const cmd of EXPECTED_COMMANDS) {
    runs.push(runFerret(`${cmd} --help`, [cmd, '--help'], home));

    const bad = BAD_ARGS[cmd];
    if (bad !== undefined) {
      runs.push(runFerret(`${cmd} ${bad.join(' ')}`.trim(), [cmd, ...bad], home));
    }
  }

  for (const cmd of VERBOSE_COMMANDS) {
    runs.push(runFerret(`${cmd} --verbose --help`, [cmd, '--verbose', '--help'], home));
  }

  const failures: string[] = [];
  for (const r of runs) {
    try {
      assertNoLeak(r);
    } catch (err) {
      failures.push((err as Error).message);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Secret-leak assertions failed:\n\n${failures.join('\n\n')}`);
  }

  // Sanity: we must have actually exercised every registered command.
  const seen = new Set(runs.map((r) => r.label.split(' ')[0]));
  for (const cmd of EXPECTED_COMMANDS) {
    expect(seen.has(cmd)).toBe(true);
  }
}, 120_000);
