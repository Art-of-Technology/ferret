// Tool-use loop for `ferret ask` (PRD §4.5, §8.2).
//
// Drives a Claude conversation until the model either reaches `end_turn`
// or hits the iteration cap. Tool calls are dispatched against local
// SQLite via the analytics helpers; results are JSON-fed back into the
// conversation. Output is yielded as an async iterable of `AskEvent`s
// so the CLI can stream tokens / tool calls live without buffering the
// full response.
//
// Cost-control:
//   - per-call max tokens come from config (`claude.max_tokens_per_ask`,
//     default 4096) so a single ask can't exceed a known ceiling,
//   - hard iteration cap (default 10, configurable on the call) prevents
//     runaway loops where Claude keeps re-querying without converging,
//   - the tool registry never invokes the network — only local SQLite.
//
// The orchestrator is deliberately stateless across invocations (PRD
// §9.4: no persistent conversation between asks).

import {
  type CategorySummaryRow,
  type RecurringPaymentRow,
  type RunReadOnlyQueryResult,
  detectRecurringPayments,
  getAccountList,
  getCategorySummary,
  runReadOnlyQueryWithMeta,
} from '../db/queries/analytics';
import { loadConfig } from '../lib/config';
import { FerretError, ValidationError } from '../lib/errors';
import type { Account } from '../types/domain';
import type {
  ClaudeContentBlock,
  ClaudeMessage,
  ClaudeMessageResponse,
  ClaudeTool,
  MessagesCreateRequest,
} from './claude';
import type { ClaudeClient } from './claude';

/** Hard floor on iteration cap; below this the loop is too short to be useful. */
const MIN_ITERATIONS = 1;
/** Hard ceiling per PRD §4.5 ("Max 10 tool iterations per ask"). */
export const DEFAULT_MAX_ITERATIONS = 10;

export type AskEventType = 'token' | 'tool_call' | 'tool_result' | 'done';

export type AskEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; ok: boolean; summary: string }
  | { type: 'done'; stopReason: ClaudeMessageResponse['stop_reason']; iterations: number };

export interface AskTools {
  /**
   * SELECT-only SQL passthrough. Validated before execution. Returns the
   * (capped) row payload plus a `truncated` flag the orchestrator forwards
   * to Claude so the model knows the answer may be incomplete.
   */
  query_transactions: (input: { sql: string; params?: unknown[] }) => RunReadOnlyQueryResult;
  /** Per-category sum over a date range. */
  get_category_summary: (input: { from: string; to: string }) => CategorySummaryRow[];
  /** Recurring-payment detection. */
  get_recurring_payments: (input: { min_occurrences?: number }) => RecurringPaymentRow[];
  /** Account roster + balances. */
  get_account_list: () => Account[];
}

export interface RunAskOptions {
  question: string;
  /** Override Claude model (else falls back to client / config default). */
  model?: string;
  /** Cap tool-use iterations. Default 10, max 10. */
  maxIterations?: number;
  /** Verbose flag — only changes whether the CLI later renders tool events. */
  verbose?: boolean;
  /** Inject the Claude client (the only network surface). */
  claudeClient: ClaudeClient;
  /** Inject tool handlers (for testability). Defaults to live DB-backed handlers. */
  tools?: Partial<AskTools>;
  /** Per-call max tokens override (defaults to `claude.max_tokens_per_ask` config). */
  maxTokens?: number;
  /** Co-operative cancellation — when aborted the loop stops between iterations. */
  abortSignal?: AbortSignal;
}

export const SYSTEM_PROMPT = [
  'You are Ferret, a careful financial-analysis assistant for a single-user CLI.',
  'The user owns the underlying SQLite database; every tool call is local and read-only.',
  'Prefer the high-level helpers (get_category_summary, get_recurring_payments, get_account_list) when they fit the question.',
  'Use query_transactions for ad-hoc SQL only when the helpers cannot express the request; the database enforces SELECT-only safety.',
  'Schema: transactions(id, account_id, timestamp INTEGER seconds, amount REAL signed, currency, description, merchant_name, category, category_source, transaction_type, is_pending). accounts(id, display_name, currency, balance_current, balance_updated_at). Negative amounts are outflows.',
  'Quote currency amounts with the relevant currency symbol (£ for GBP). Be concise; prefer numbers and short summaries to long prose.',
  'If a question is ambiguous, state your assumption briefly and answer based on it rather than refusing.',
].join(' ');

/**
 * Drive a Claude conversation through the ask-mode tool loop. Yields
 * structured events the caller (CLI) can render or collect.
 */
export async function* runAsk(opts: RunAskOptions): AsyncIterable<AskEvent> {
  if (!opts.question || opts.question.trim().length === 0) {
    throw new ValidationError('ask: question is required');
  }
  const maxIterations = clampIterations(opts.maxIterations);
  const tools = bindDefaultTools(opts.tools);
  const maxTokens = resolveMaxTokens(opts.maxTokens);
  const toolDefs = buildToolDefs();

  // Conversation state. We keep the full message history because Claude's
  // tool-result feedback semantics require we echo back every prior
  // assistant `tool_use` plus its corresponding `tool_result` user block.
  const messages: ClaudeMessage[] = [{ role: 'user', content: opts.question }];

  let iterations = 0;
  let lastStopReason: ClaudeMessageResponse['stop_reason'] = null;

  while (iterations < maxIterations) {
    if (opts.abortSignal?.aborted) {
      yield { type: 'done', stopReason: 'stop_sequence', iterations };
      return;
    }
    iterations += 1;

    const req: MessagesCreateRequest = {
      max_tokens: maxTokens,
      system: SYSTEM_PROMPT,
      messages,
      tools: toolDefs,
      tool_choice: { type: 'auto' },
    };
    if (opts.model) req.model = opts.model;

    let resp: ClaudeMessageResponse;
    try {
      resp = await opts.claudeClient.messagesCreate(req);
    } catch (err) {
      if (err instanceof FerretError) throw err;
      throw err;
    }

    lastStopReason = resp.stop_reason;

    // Emit any text content from the assistant turn before processing
    // tool calls — even tool_use turns can include narrating text.
    const textBlocks: string[] = [];
    const toolUseBlocks: Array<Extract<ClaudeContentBlock, { type: 'tool_use' }>> = [];
    for (const block of resp.content) {
      if (block.type === 'text' && block.text.length > 0) {
        textBlocks.push(block.text);
        yield { type: 'token', text: block.text };
      } else if (block.type === 'tool_use') {
        toolUseBlocks.push(block);
      }
    }

    // Append the assistant turn verbatim — Claude needs the full original
    // content array (including tool_use blocks) to correlate with the
    // user-side tool_result blocks we send next iteration.
    messages.push({ role: 'assistant', content: resp.content });

    if (resp.stop_reason !== 'tool_use' || toolUseBlocks.length === 0) {
      // end_turn / max_tokens / stop_sequence -> we're done.
      break;
    }

    // Execute every tool_use block in the assistant turn and collect a
    // single user message containing one tool_result per call. Anthropic's
    // wire format requires all tool_results from one assistant turn to
    // arrive in a single subsequent user message.
    const toolResults: ClaudeContentBlock[] = [];
    for (const block of toolUseBlocks) {
      yield { type: 'tool_call', name: block.name, input: block.input };
      const { ok, summary, content } = await invokeTool(block.name, block.input, tools);
      yield { type: 'tool_result', name: block.name, ok, summary };
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content,
        is_error: !ok,
      });
    }

    messages.push({ role: 'user', content: toolResults });

    if (opts.abortSignal?.aborted) {
      yield { type: 'done', stopReason: 'stop_sequence', iterations };
      return;
    }
  }

  yield { type: 'done', stopReason: lastStopReason, iterations };
}

/** Build the four tool definitions advertised to Claude (PRD §8.2). */
export function buildToolDefs(): ClaudeTool[] {
  return [
    {
      name: 'query_transactions',
      description:
        'Run a read-only SQL query against the local SQLite database. SELECT-only; ' +
        'forbidden tokens (INSERT/UPDATE/DELETE/DROP/PRAGMA/ATTACH/...) are rejected. ' +
        'Use ? placeholders and supply values via params.',
      input_schema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'SELECT-only SQL query' },
          params: {
            type: 'array',
            description: 'Positional bind parameters for ? placeholders.',
            items: {},
          },
        },
        required: ['sql'],
      },
    },
    {
      name: 'get_category_summary',
      description: 'Total signed amount per category in [from, to]. Negative totals are outflows.',
      input_schema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'ISO date or yyyy-MM-dd, inclusive lower bound' },
          to: { type: 'string', description: 'ISO date or yyyy-MM-dd, inclusive upper bound' },
        },
        required: ['from', 'to'],
      },
    },
    {
      name: 'get_recurring_payments',
      description:
        'Detect subscriptions / recurring outflows by merchant. Default minimum 3 distinct months.',
      input_schema: {
        type: 'object',
        properties: {
          min_occurrences: {
            type: 'integer',
            description: 'Minimum distinct months a merchant must appear in.',
          },
        },
      },
    },
    {
      name: 'get_account_list',
      description: 'List all accounts with current balances.',
      input_schema: { type: 'object', properties: {} },
    },
  ];
}

/** Construct DB-backed defaults; tests can override any subset via `opts.tools`. */
function bindDefaultTools(overrides?: Partial<AskTools>): AskTools {
  return {
    query_transactions:
      overrides?.query_transactions ??
      ((input) => runReadOnlyQueryWithMeta(input.sql, input.params ?? [])),
    get_category_summary:
      overrides?.get_category_summary ??
      ((input) =>
        getCategorySummary({
          from: parseToolDate('from', input.from),
          to: parseToolDate('to', input.to),
        })),
    get_recurring_payments:
      overrides?.get_recurring_payments ??
      ((input) => detectRecurringPayments({ minOccurrences: input.min_occurrences })),
    get_account_list: overrides?.get_account_list ?? (() => getAccountList()),
  };
}

interface ToolInvocationResult {
  ok: boolean;
  /** Short human-readable summary suitable for `--verbose` output. */
  summary: string;
  /** Wire-format content for the tool_result block fed back to Claude. */
  content: string;
}

async function invokeTool(
  name: string,
  input: unknown,
  tools: AskTools,
): Promise<ToolInvocationResult> {
  try {
    switch (name) {
      case 'query_transactions': {
        const sql = readString(input, 'sql');
        const params = readArrayMaybe(input, 'params');
        const result = tools.query_transactions({ sql, params });
        const summarySuffix = result.truncated ? ' (truncated)' : '';
        return {
          ok: true,
          summary: `query_transactions -> ${result.rows.length} rows${summarySuffix}`,
          // Include the truncated flag in the wire payload so Claude can
          // hedge its answer when the result was capped.
          content: JSON.stringify({ rows: result.rows, truncated: result.truncated }),
        };
      }
      case 'get_category_summary': {
        const from = readString(input, 'from');
        const to = readString(input, 'to');
        const rows = tools.get_category_summary({ from, to });
        return {
          ok: true,
          summary: `get_category_summary -> ${rows.length} categories`,
          content: JSON.stringify({ rows }),
        };
      }
      case 'get_recurring_payments': {
        const min = readNumberMaybe(input, 'min_occurrences');
        const rows = tools.get_recurring_payments({ min_occurrences: min });
        return {
          ok: true,
          summary: `get_recurring_payments -> ${rows.length} merchants`,
          content: JSON.stringify({ rows }),
        };
      }
      case 'get_account_list': {
        const rows = tools.get_account_list();
        return {
          ok: true,
          summary: `get_account_list -> ${rows.length} accounts`,
          content: JSON.stringify({ rows }),
        };
      }
      default:
        return {
          ok: false,
          summary: `unknown tool: ${name}`,
          content: JSON.stringify({ error: `unknown tool: ${name}` }),
        };
    }
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    return {
      ok: false,
      summary: `${name} error: ${msg}`,
      content: JSON.stringify({ error: msg }),
    };
  }
}

function clampIterations(raw: number | undefined): number {
  const n =
    typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_MAX_ITERATIONS;
  if (n < MIN_ITERATIONS) return MIN_ITERATIONS;
  if (n > DEFAULT_MAX_ITERATIONS) return DEFAULT_MAX_ITERATIONS;
  return n;
}

function resolveMaxTokens(override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  try {
    const cfg = loadConfig();
    const v = cfg.claude.max_tokens_per_ask;
    if (Number.isFinite(v) && v > 0) return Math.floor(v);
  } catch {
    // Fall through to a safe default rather than failing the call.
  }
  return 4096;
}

function readString(input: unknown, key: string): string {
  if (!input || typeof input !== 'object') {
    throw new ValidationError(`tool input missing required field: ${key}`);
  }
  const v = (input as Record<string, unknown>)[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new ValidationError(`tool input field "${key}" must be a non-empty string`);
  }
  return v;
}

function readArrayMaybe(input: unknown, key: string): unknown[] | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const v = (input as Record<string, unknown>)[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new ValidationError(`tool input field "${key}" must be an array`);
  return v;
}

function readNumberMaybe(input: unknown, key: string): number | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const v = (input as Record<string, unknown>)[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ValidationError(`tool input field "${key}" must be a finite number`);
  }
  return v;
}

function parseToolDate(field: string, raw: string): Date {
  // Accept either a yyyy-MM-dd shortcut or a full ISO string. Treat plain
  // dates as UTC midnight so range comparisons against the seconds-since-
  // epoch column are timezone-stable.
  const isoLike = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw;
  const d = new Date(isoLike);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError(`get_category_summary: invalid ${field} date: "${raw}"`);
  }
  return d;
}
