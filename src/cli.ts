#!/usr/bin/env bun
import { defineCommand, runMain } from 'citty';
import pkg from '../package.json' with { type: 'json' };
import { subCommands } from './commands';
import { loadFerretEnv } from './lib/env-file';
import { FerretError } from './lib/errors';

loadFerretEnv();

const main = defineCommand({
  meta: {
    name: 'ferret',
    version: pkg.version,
    description: pkg.description,
  },
  subCommands,
});

runMain(main).catch((err: unknown) => {
  if (err instanceof FerretError) {
    process.stderr.write(`${err.name}: ${err.message}\n`);
    process.exit(err.exitCode);
  }
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
