// Single source of truth for the list of commands that `ferret --help` must
// surface. Used by both the unit-level help-output test and the integration
// secret-leak regression so the two can't drift.

export const EXPECTED_COMMANDS = [
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
] as const;
