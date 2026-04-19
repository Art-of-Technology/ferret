import { defineCommand } from 'citty';
import {
  configPath,
  ferretHome,
  getConfigValue,
  loadConfig,
  setConfigValue,
  writeConfig,
} from '../lib/config';
import { ValidationError } from '../lib/errors';

export default defineCommand({
  meta: { name: 'config', description: 'Read or write Ferret configuration' },
  subCommands: {
    get: defineCommand({
      meta: { name: 'get', description: 'Print a config value by dot-path' },
      args: {
        key: {
          type: 'positional',
          description: 'Dot-path key (e.g. claude.model)',
          required: true,
        },
      },
      run({ args }) {
        const key = String(args.key);
        const value = getConfigValue(loadConfig(), key);
        if (value === undefined) {
          throw new ValidationError(`No such config key: ${key}`);
        }
        process.stdout.write(
          `${typeof value === 'object' ? JSON.stringify(value, null, 2) : value}\n`,
        );
      },
    }),
    set: defineCommand({
      meta: { name: 'set', description: 'Set a config value by dot-path' },
      args: {
        key: { type: 'positional', description: 'Dot-path key', required: true },
        value: { type: 'positional', description: 'New value (auto-coerced)', required: true },
      },
      run({ args }) {
        const key = String(args.key);
        const value = String(args.value);
        const cfg = loadConfig();
        const next = setConfigValue(cfg, key, value);
        writeConfig(next);
        process.stdout.write(`set ${key} = ${value}\n`);
      },
    }),
    path: defineCommand({
      meta: { name: 'path', description: 'Print the Ferret config directory' },
      run() {
        process.stdout.write(`${ferretHome()}\n`);
        process.stdout.write(`${configPath()}\n`);
      },
    }),
  },
});
