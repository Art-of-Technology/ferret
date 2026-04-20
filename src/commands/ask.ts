// `ferret ask <question>` — natural-language financial query (PRD §4.5).
//
// Buffers Claude tokens in default mode and renders markdown → ANSI
// once the loop finishes, so users see a cleanly formatted answer
// rather than raw `**bold**` syntax. Tool-call activity surfaces as
// subtle dim status lines on stderr so the user has feedback while
// Claude is running tools between turns. `--json` still collects
// verbatim text (no rendering) so the structured payload stays
// machine-consumable. `--verbose` keeps its detailed tool-call echo
// on stderr.
//
// SIGINT handling: on Ctrl-C we flip an AbortController so the tool loop
// exits between iterations rather than ripping out mid-call. Exit code
// 130 follows the standard "killed by SIGINT" convention.

import { defineCommand } from 'citty';
import consola from 'consola';
import picocolors from 'picocolors';
import { setBudget } from '../db/queries/budgets';
import { appendAuditEvent } from '../lib/audit';
import { loadConfig } from '../lib/config';
import { FerretError, ValidationError } from '../lib/errors';
import { formatJson } from '../lib/format';
import { renderMarkdown } from '../lib/markdown-terminal';
import { ANTHROPIC_API_KEY, resolveSecret } from '../lib/secrets';
import { type AskEvent, type BudgetProposal, runAsk } from '../services/ask';
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
  proposals: BudgetProposal[];
}

export default defineCommand({
  meta: { name: 'ask', description: 'Natural-language financial query via Claude' },
  args: {
    question: { type: 'positional', description: 'Question text', required: true },
    model: { type: 'string', description: 'Override Claude model' },
    json: { type: 'boolean', description: 'Structured output (question, tools_used, answer)' },
    verbose: { type: 'boolean', description: 'Show tool calls + summaries on stderr' },
    apply: {
      type: 'boolean',
      description: 'Apply any budget proposals from propose_budgets directly via setBudget',
    },
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
    const apply = Boolean(args.apply);
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
        proposals: [],
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

      // Audit: one event per ask invocation. Per issue #48 the question
      // text, answer text, and tool inputs/outputs are all omitted — we
      // record only the counts that matter for rate / compliance
      // reporting. Fires regardless of output mode.
      appendAuditEvent('ask.invoked', {
        tool_calls_count: collected.toolsUsed.length,
        iterations: collected.iterations,
      });

      // Deduplicate proposals by category — Claude may emit the same
      // category twice across iterations (e.g. revising an amount). Keep
      // the last value the user saw streamed.
      const dedupedProposals = dedupeProposals(collected.proposals);

      // Apply once, up front, when --apply is set. Both render paths
      // (JSON + plain) consume the same `applyResults` so there's a
      // single call regardless of output mode.
      const applyResults =
        apply && dedupedProposals.length > 0 ? applyBudgetProposals(dedupedProposals) : undefined;

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
          proposed_budgets: dedupedProposals.map((p) => ({
            category: p.category,
            monthly_amount: p.monthlyAmount,
            currency: p.currency,
            rationale: p.rationale,
          })),
          applied_budgets: applyResults?.map((r) => ({
            category: r.category,
            monthly_amount: r.monthlyAmount,
            currency: r.currency,
            ok: r.ok,
            error: r.error,
          })),
          iterations: collected.iterations,
          stop_reason: collected.stopReason,
        };
        process.stdout.write(`${formatJson(out)}\n`);
      } else {
        // Render the buffered markdown answer as ANSI-styled text.
        // Pass a single trailing newline through so the next shell
        // prompt lands on its own line.
        const rendered = renderMarkdown(collected.answer);
        process.stdout.write(rendered);
        if (!rendered.endsWith('\n')) process.stdout.write('\n');
        if (dedupedProposals.length > 0) {
          renderProposals(dedupedProposals, applyResults);
        }
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
      // Buffer only — the final answer is rendered as markdown once
      // the loop completes so users don't see raw `**bold**` syntax
      // flickering past.
      ctx.collected.answer += event.text;
      break;
    }
    case 'tool_call': {
      ctx.onPendingCall({ name: event.name, input: event.input });
      if (ctx.verbose) {
        consola.info(`tool call: ${event.name} ${safeStringify(event.input)}`);
      } else if (!ctx.wantJson) {
        // Non-verbose default: surface a subtle hint on stderr so the
        // user has feedback during long tool loops without polluting
        // the stdout answer stream.
        process.stderr.write(picocolors.dim(`  … ${event.name}\n`));
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
      if (event.proposals && event.proposals.length > 0) {
        ctx.collected.proposals.push(...event.proposals);
      }
      break;
    }
  }
}

/**
 * Keep the last proposal per category. Claude often revises mid-conversation
 * (e.g. proposes Groceries £350, then re-proposes Groceries £400 after
 * checking spending) and we want the user to see the final number.
 */
function dedupeProposals(raw: BudgetProposal[]): BudgetProposal[] {
  const byCategory = new Map<string, BudgetProposal>();
  for (const p of raw) byCategory.set(p.category, p);
  return [...byCategory.values()];
}

interface ApplyResult {
  category: string;
  monthlyAmount: number;
  currency: string;
  ok: boolean;
  error?: string;
}

/**
 * Apply each proposal via setBudget(). Per-row try/catch so one bad row
 * (e.g. category later removed) does not abort the rest.
 */
function applyBudgetProposals(proposals: BudgetProposal[]): ApplyResult[] {
  const out: ApplyResult[] = [];
  for (const p of proposals) {
    try {
      setBudget(p.category, p.monthlyAmount, p.currency);
      out.push({
        category: p.category,
        monthlyAmount: p.monthlyAmount,
        currency: p.currency,
        ok: true,
      });
    } catch (err) {
      // Only surface FerretError messages verbatim (those are written for
      // user consumption). Anything else (raw drizzle / sqlite errors) can
      // leak file paths, table names, or stack frames into stdout/JSON;
      // collapse to a generic message and route the detail to consola
      // for verbose logging.
      let message: string;
      if (err instanceof FerretError) {
        message = err.message;
      } else {
        consola.warn(`setBudget("${p.category}") failed:`, err);
        message = 'failed to set budget (see logs)';
      }
      out.push({
        category: p.category,
        monthlyAmount: p.monthlyAmount,
        currency: p.currency,
        ok: false,
        error: message,
      });
    }
  }
  return out;
}

/**
 * Render proposals + either an apply summary (if `applyResults` is provided
 * by the caller — meaning --apply was set and budgets were already written)
 * or paste-ready commands. This function is purely view code; the write
 * happens at the call site in `run()` so there is exactly one
 * `applyBudgetProposals` call per command invocation.
 */
function renderProposals(
  proposals: BudgetProposal[],
  applyResults: ApplyResult[] | undefined,
): void {
  process.stdout.write('\n');
  process.stdout.write(picocolors.bold('Proposed budgets:\n'));
  for (const p of proposals) {
    const amt = formatAmount(p.monthlyAmount, p.currency);
    const why = p.rationale ? ` ${picocolors.dim(`— ${p.rationale}`)}` : '';
    process.stdout.write(`  ${picocolors.cyan(p.category)}: ${amt}${why}\n`);
  }
  process.stdout.write('\n');
  if (applyResults) {
    const okCount = applyResults.filter((r) => r.ok).length;
    const failCount = applyResults.length - okCount;
    process.stdout.write(picocolors.bold(`Applied: ${okCount} ok, ${failCount} failed\n`));
    for (const r of applyResults) {
      if (!r.ok) {
        process.stdout.write(`  ${picocolors.red('✗')} ${r.category}: ${r.error ?? 'failed'}\n`);
      }
    }
  } else {
    process.stdout.write(picocolors.dim('Run with --apply to write these, or paste:\n'));
    for (const p of proposals) {
      process.stdout.write(`  ferret budget set ${shellQuote(p.category)} ${p.monthlyAmount}\n`);
    }
  }
}

/**
 * Shell-quote a string for paste-ready POSIX commands. Always wraps in
 * single quotes (literal — no expansion) and escapes inner single quotes
 * via the standard `'\''` close-and-reopen trick. Categories like
 * "Eating Out", "O'Brien's Pub", or anything with a $/`/!/" stay safe.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function formatAmount(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${n} ${currency}`;
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
