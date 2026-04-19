import { defineCommand } from 'citty';
import { notImplemented } from '../lib/errors';

export default defineCommand({
  meta: { name: 'ls', description: 'List transactions with filters' },
  args: {
    since: { type: 'string', description: 'Lower-bound date or duration' },
    until: { type: 'string', description: 'Upper-bound date' },
    category: { type: 'string', description: 'Filter by category' },
    merchant: { type: 'string', description: 'Substring match on merchant' },
    account: { type: 'string', description: 'Account id or name' },
    min: { type: 'string', description: 'Minimum absolute amount' },
    max: { type: 'string', description: 'Maximum absolute amount' },
    incoming: { type: 'boolean', description: 'Only incoming' },
    outgoing: { type: 'boolean', description: 'Only outgoing' },
    limit: { type: 'string', description: 'Max rows (default 50)' },
    json: { type: 'boolean', description: 'JSON output' },
    csv: { type: 'boolean', description: 'CSV output' },
    sort: { type: 'string', description: 'Sort field (default timestamp desc)' },
  },
  run() {
    notImplemented('ls', 4);
  },
});
