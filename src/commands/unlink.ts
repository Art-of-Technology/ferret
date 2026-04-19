import { defineCommand } from 'citty';
import { notImplemented } from '../lib/errors';

export default defineCommand({
  meta: { name: 'unlink', description: 'Remove a connection and revoke tokens' },
  args: {
    connectionId: { type: 'positional', description: 'Connection id', required: true },
  },
  run() {
    notImplemented('unlink', 2);
  },
});
