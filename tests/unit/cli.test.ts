import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The auto-registry must surface every src/commands/<name>.ts file by its
// basename. This test is the regression that proves it.
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

test('ferret --help lists every command from src/commands/', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ferret-cli-'));
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.HOME = tmp;
  env.NO_COLOR = '1';
  // bun:test sets NODE_ENV=test, which makes consola (used by citty for --help)
  // suppress info-level output. Override so the help text reaches stdout.
  env.NODE_ENV = 'production';
  const res = Bun.spawnSync({
    cmd: ['bun', 'run', join(projectRoot, 'src', 'cli.ts'), '--help'],
    cwd: projectRoot,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = `${res.stdout.toString()}\n${res.stderr.toString()}`;
  for (const name of EXPECTED_COMMANDS) {
    expect(out).toContain(name);
  }
});
