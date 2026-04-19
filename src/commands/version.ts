import { defineCommand } from 'citty';
import pkg from '../../package.json' with { type: 'json' };

export default defineCommand({
  meta: { name: 'version', description: 'Print Ferret version' },
  run() {
    process.stdout.write(`${pkg.version}\n`);
  },
});
