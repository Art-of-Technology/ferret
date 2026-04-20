#!/usr/bin/env bun
import { defineCommand, runCommand, runMain } from 'citty';
import pkg from '../package.json' with { type: 'json' };
import { subCommands } from './commands';
import { loadFerretEnv } from './lib/env-file';
import { FerretError, OAuthCancelledError } from './lib/errors';

loadFerretEnv();

const main = defineCommand({
  meta: {
    name: 'ferret',
    version: pkg.version,
    description: pkg.description,
  },
  subCommands,
});

// citty's runMain wraps runCommand in a try/catch that calls
// `console.error(error, "\n")` and forces exit code 1 — which both destroys
// our typed exit codes and drops Bun's rich error format (source snippets,
// enumerable fields) into the terminal. Route command execution through
// runCommand directly so we can format FerretErrors ourselves; only fall back
// to runMain for --help / --version since they rely on citty's showUsage
// resolver.
const rawArgs = process.argv.slice(2);
const META_FLAGS = new Set(['--help', '-h', '--version', '-v']);
const isMetaInvocation = rawArgs.some((a) => META_FLAGS.has(a));

const execute = isMetaInvocation ? runMain(main, { rawArgs }) : runCommand(main, { rawArgs });

Promise.resolve(execute).catch((err: unknown) => {
  if (err instanceof FerretError) {
    // OAuthCancelledError is user-initiated (hit "Cancel" in browser) so we
    // render just the message — no class name prefix, no stack. Every other
    // FerretError keeps the `Name: message` prefix for grep-ability.
    const body = err instanceof OAuthCancelledError ? err.message : `${err.name}: ${err.message}`;
    process.stderr.write(`${body}\n`);
    process.exit(err.exitCode);
  }
  // citty CLIError carries an E_* code; surface the message without the
  // rich-error dump.
  const e = err as { code?: unknown; message?: unknown };
  if (e && typeof e.code === 'string' && e.code.startsWith('E_')) {
    process.stderr.write(`${String(e.message ?? 'Unknown CLI error')}\n`);
    process.exit(1);
  }
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
