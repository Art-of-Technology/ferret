import { defineCommand } from 'citty';
import { notImplemented } from '../lib/errors';

export default defineCommand({
  meta: { name: 'link', description: 'Connect a bank via OAuth (TrueLayer)' },
  args: {
    provider: { type: 'string', description: 'TrueLayer provider id (e.g. uk-ob-lloyds)' },
  },
  run() {
    notImplemented('link', 2);
  },
});
