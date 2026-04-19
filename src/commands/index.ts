// Command auto-registry.
//
// To add a new command:
//   1. Create `src/commands/<name>.ts` with `export default defineCommand(...)`.
//   2. Add one import + one entry to the `subCommands` object below.
//
// The registry key (always the basename of the file) is what shows up as
// `ferret <name>` on the CLI. Reserved keys: `index`. Do not rename existing
// keys without bumping a major release.

import type { CommandDef } from 'citty';
import ask from './ask';
import budget from './budget';
import config from './config';
import connections from './connections';
import exportCmd from './export';
import importCmd from './import';
import init from './init';
import link from './link';
import ls from './ls';
import rules from './rules';
import sync from './sync';
import tag from './tag';
import unlink from './unlink';
import version from './version';

// citty's CommandDef is invariant in its ArgsDef generic, so each command file
// produces a distinct narrow type. The registry only needs to expose them as
// opaque CommandDefs.
// biome-ignore lint/suspicious/noExplicitAny: see comment above.
export const subCommands: Record<string, CommandDef<any>> = {
  ask,
  budget,
  config,
  connections,
  export: exportCmd,
  import: importCmd,
  init,
  link,
  ls,
  rules,
  sync,
  tag,
  unlink,
  version,
};
