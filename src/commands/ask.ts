import { defineCommand } from 'citty';
import { notImplemented } from '../lib/errors';

export default defineCommand({
  meta: { name: 'ask', description: 'Natural-language financial query via Claude' },
  args: {
    question: { type: 'positional', description: 'Question text', required: true },
    model: { type: 'string', description: 'Override Claude model' },
    json: { type: 'boolean', description: 'Structured output' },
    verbose: { type: 'boolean', description: 'Show tool calls' },
  },
  run() {
    notImplemented('ask', 6);
  },
});
