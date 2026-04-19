// `ferret ask <question>` — natural-language financial query (PRD §4.5).
//
// Streams Claude tokens to stdout in default mode; collects them when
// `--json` is used so the structured payload contains the full answer.
// `--verbose` echoes tool calls + per-tool summaries to stderr so the
// user can audit which queries Claude ran without polluting the answer
// stream.
//
// SIGINT handling: on Ctrl-C we flip an AbortController so the tool loop
// exits between iterations rather than ripping out mid-call. Exit code
// 130 follows the standard "killed by SIGINT" convention.

import { defineCommand } from 'citty';
import consola from 'consola';
import { loadConfig } from '../lib/config';
import { ValidationError } from '../lib/errors';
import { formatJson } from '../lib/format';
import { ANTHROPIC_API_KEY, resolveSecret } from '../lib/secrets';
import { type AskEvent, runAsk } from '../services/ask';
import { ClaudeClient } from '../services/claude';

/**
 * Per-line cap for `--verbose` tool-call previews on stderr. 240 chars
 * keeps long `query_transactions` SQL legible without flooding the
 * terminal; 237 leaves room for the trailing "..." marker we append when
 * the payload exceeds the cap.
 */
const VERBOSE_PREVIEW_MAX = 240;
const VERBOSE_PREVIEW_BODY = VERBOSE_PREVIEW_MAX - 3; // "..." suffix budget

interface CollectedAsk {
  answer: string;
  toolsUsed: Array<{ name: string; input: unknown; ok: boolean; summary: string }>;
  iterations: number;
  stopReason: string | null;
}

export default defineCommand({
  meta: { name: 'ask', description: 'Natural-language financial query via Claude' },
  args: {
    question: { type: 'positional', description: 'Question text', required: true },
    model: { type: 'string', description: 'Override Claude model' },
    json: { type: 'boolean', description: 'Structured output (question, tools_used, answer)' },
    verbose: { type: 'boolean', description: 'Show tool calls + summaries on stderr' },
  },
  async run({ args }) {
    const question = String(args.question ?? '').trim();
    if (question.length === 0) {
      // Empty user input is a validation failure (PRD §7.2 exit code 6),
      // not a config issue (exit 2).
      throw new ValidationError('ask: question is required');
    }
    const wantJson = Boolean(args.json);
    const verbose = Boolean(args.verbose);
    const modelOverride =
      typeof args.model === 'string' && args.model.length > 0 ? args.model : undefined;

    const apiKey = await resolveSecret(ANTHROPIC_API_KEY);
    const cfg = loadConfig();
    const claudeClient = new ClaudeClient({
      apiKey,
      model: modelOverride ?? cfg.claude.model,
    });

    // SIGINT -> abort. Single handler per invocation; remove after run so
    // we don't leak listeners when tests import this module repeatedly.
    const ac = new AbortController();
    const onSig = (): void => {
      ac.abort();
    };
    process.on('SIGINT', onSig);

    try {
      const collected: CollectedAsk = {
        answer: '',
        toolsUsed: [],
        iterations: 0,
        stopReason: null,
      };

      const stream = runAsk({
        question,
        model: modelOverride,
        claudeClient,
        verbose,
        abortSignal: ac.signal,
        maxTokens: cfg.claude.max_tokens_per_ask,
      });

      // Capture every assistant tool_call for `--verbose` even if the
      // user is in plain-stream mode; we only echo when verbose is on.
      let pendingCall: { name: string; input: unknown } | null = null;

      for await (const event of stream) {
        handleEvent(event, {
          collected,
          wantJson,
          verbose,
          onPendingCall: (e) => {
            pendingCall = e;
          },
          consumePendingCall: (ok, summary) => {
            if (pendingCall) {
              collected.toolsUsed.push({ ...pendingCall, ok, summary });
              pendingCall = null;
            }
          },
        });
      }

      if (wantJson) {
        const out = {
          question,
          answer: collected.answer,
          tools_used: collected.toolsUsed.map((t) => ({
            name: t.name,
            input: t.input,
            ok: t.ok,
            summary: t.summary,
          })),
          iterations: collected.iterations,
          stop_reason: collected.stopReason,
        };
        process.stdout.write(`${formatJson(out)}\n`);
      } else {
        // Default-mode streamed tokens already wrote as they arrived.
        // Add a trailing newline so the next shell prompt is on its own line.
        if (!collected.answer.endsWith('\n')) process.stdout.write('\n');
      }

      if (ac.signal.aborted) {
        // Mirror standard "killed by SIGINT" exit code.
        process.exit(130);
      }
    } finally {
      process.off('SIGINT', onSig);
    }
  },
});

interface HandleEventCtx {
  collected: CollectedAsk;
  wantJson: boolean;
  verbose: boolean;
  onPendingCall: (e: { name: string; input: unknown }) => void;
  consumePendingCall: (ok: boolean, summary: string) => void;
}

function handleEvent(event: AskEvent, ctx: HandleEventCtx): void {
  switch (event.type) {
    case 'token': {
      ctx.collected.answer += event.text;
      if (!ctx.wantJson) {
        process.stdout.write(event.text);
      }
      break;
    }
    case 'tool_call': {
      ctx.onPendingCall({ name: event.name, input: event.input });
      if (ctx.verbose) {
        consola.info(`tool call: ${event.name} ${safeStringify(event.input)}`);
      }
      break;
    }
    case 'tool_result': {
      ctx.consumePendingCall(event.ok, event.summary);
      if (ctx.verbose) {
        const tag = event.ok ? 'tool ok' : 'tool err';
        consola.info(`${tag}: ${event.summary}`);
      }
      break;
    }
    case 'done': {
      ctx.collected.iterations = event.iterations;
      ctx.collected.stopReason = event.stopReason;
      break;
    }
  }
}

function safeStringify(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    if (s.length > VERBOSE_PREVIEW_MAX) return `${s.slice(0, VERBOSE_PREVIEW_BODY)}...`;
    return s;
  } catch {
    return String(v);
  }
}
