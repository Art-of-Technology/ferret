import { defineCommand } from 'citty';
import { notImplemented } from '../lib/errors';

export default defineCommand({
  meta: { name: 'export', description: 'Export transactions as CSV or JSON' },
  args: {
    format: { type: 'string', description: 'csv | json' },
    since: { type: 'string', description: 'Lower-bound date' },
    until: { type: 'string', description: 'Upper-bound date' },
    category: { type: 'string', description: 'Filter by category' },
  },
  run() {
    notImplemented('export', 4);
  },
});
