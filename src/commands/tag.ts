import { defineCommand } from 'citty';
import { notImplemented } from '../lib/errors';

export default defineCommand({
  meta: { name: 'tag', description: 'Categorize transactions' },
  args: {
    txnId: { type: 'positional', description: 'Transaction id (manual override)', required: false },
    category: { type: 'positional', description: 'Category name', required: false },
    retag: { type: 'boolean', description: 'Reclassify all non-manual' },
    'dry-run': { type: 'boolean', description: 'Preview without writing' },
  },
  run() {
    notImplemented('tag', 5);
  },
});
