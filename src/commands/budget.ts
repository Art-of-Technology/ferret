import { defineCommand } from 'citty';
import { notImplemented } from '../lib/errors';

export default defineCommand({
  meta: { name: 'budget', description: 'Manage and view monthly budgets' },
  subCommands: {
    set: defineCommand({
      meta: { name: 'set', description: 'Set or update a category budget' },
      args: {
        category: { type: 'positional', description: 'Category', required: true },
        amount: { type: 'positional', description: 'Monthly amount', required: true },
      },
      run() {
        notImplemented('budget set', 7);
      },
    }),
    rm: defineCommand({
      meta: { name: 'rm', description: 'Remove a budget' },
      args: {
        category: { type: 'positional', description: 'Category', required: true },
      },
      run() {
        notImplemented('budget rm', 7);
      },
    }),
    history: defineCommand({
      meta: { name: 'history', description: 'Month-over-month view' },
      args: {
        months: { type: 'string', description: 'Number of months back' },
      },
      run() {
        notImplemented('budget history', 7);
      },
    }),
    export: defineCommand({
      meta: { name: 'export', description: 'Export budgets as JSON' },
      run() {
        notImplemented('budget export', 7);
      },
    }),
  },
  run() {
    notImplemented('budget', 7);
  },
});
