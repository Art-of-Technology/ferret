import { defineCommand } from 'citty';
import { notImplemented } from '../lib/errors';

export default defineCommand({
  meta: { name: 'sync', description: 'Sync transactions from connected banks' },
  args: {
    connection: { type: 'string', description: 'Sync only one connection by id' },
    since: { type: 'string', description: 'Override last_synced_at, e.g. 30d' },
    'dry-run': { type: 'boolean', description: 'Fetch without writing' },
  },
  run() {
    notImplemented('sync', 3);
  },
});
