import { defineCommand } from 'citty';
import { notImplemented } from '../lib/errors';

export default defineCommand({
  meta: { name: 'rules', description: 'Manage categorization rules' },
  subCommands: {
    list: defineCommand({
      meta: { name: 'list', description: 'List all rules' },
      run() {
        notImplemented('rules list', 5);
      },
    }),
    add: defineCommand({
      meta: { name: 'add', description: 'Add a rule' },
      args: {
        pattern: { type: 'positional', description: 'Regex pattern', required: true },
        category: { type: 'positional', description: 'Category', required: true },
      },
      run() {
        notImplemented('rules add', 5);
      },
    }),
    rm: defineCommand({
      meta: { name: 'rm', description: 'Remove a rule' },
      args: {
        id: { type: 'positional', description: 'Rule id', required: true },
      },
      run() {
        notImplemented('rules rm', 5);
      },
    }),
  },
});
