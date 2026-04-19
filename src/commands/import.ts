import { defineCommand } from 'citty';
import { notImplemented } from '../lib/errors';

export default defineCommand({
  meta: { name: 'import', description: 'Import transactions from CSV' },
  args: {
    file: { type: 'positional', description: 'Path to CSV file', required: true },
    format: { type: 'string', description: 'Force format (lloyds, natwest, ...)' },
    account: { type: 'string', description: 'Attach to specific account id' },
    'dry-run': { type: 'boolean', description: 'Preview without writing' },
    'dedupe-strategy': { type: 'string', description: 'strict | loose' },
  },
  run() {
    notImplemented('import', 8);
  },
});
