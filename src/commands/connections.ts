import { defineCommand } from 'citty';
import { notImplemented } from '../lib/errors';

export default defineCommand({
  meta: { name: 'connections', description: 'List active bank connections' },
  run() {
    notImplemented('connections', 2);
  },
});
