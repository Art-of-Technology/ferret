// Anthropic Claude API wrapper per PRD §8.2 + §9.4.
//
// Design note for Phase 5 (`ferret ask`): the wrapper exposes a low-level
// `messagesCreate()` passthrough alongside the high-level `categorize()`. Phase 5
// will layer a tool-use loop on top of `messagesCreate()` (and may use
// `withTools()` to build a per-call request). This file is intentionally
// additive — Phase 5 should not need to modify it; just import the client and
// call `messagesCreate()` with `tools` + a `tool_choice`.
//
// Behaviour:
//   - 429 -> respect Retry-After (seconds), exponential backoff with jitter
//     (250ms base) up to 3 retries, then RateLimitError.
//   - 5xx -> exponential backoff with jitter (250ms base) up to 3 retries,
//     then NetworkError.
//   - other 4xx -> NetworkError with status + body context (no retry).
//   - network failures (fetch throw) -> NetworkError.
//
// Secrets: the API key is supplied by the caller (typically resolved via
// `resolveSecret(ANTHROPIC_API_KEY)`). It is sent in the `x-api-key` header
// per Anthropic's spec and never logged.

import { NetworkError, RateLimitError, ValidationError } from '../lib/errors';

export const ANTHROPIC_BASE = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';

/** Default model from PRD §5.4 config. */
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-7';

/** Per-call max tokens for the categorization batch path. */
export const CATEGORIZE_MAX_TOKENS = 2048;

/** Hard cap on transactions per Claude call (PRD §4.4). */
export const CATEGORIZE_BATCH_SIZE = 50;

/** Tool name used to coerce structured JSON output for categorization. */
export const CATEGORIZE_TOOL_NAME = 'record_categorizations';

/** Minimal fetch type (mirrors services/truelayer.ts so tests can inject). */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface TxnLite {
  /** Stable id used to round-trip the assignment back to the txn row. */
  id: string;
  /** Pre-normalized merchant or raw description, whichever caller prefers. */
  merchant: string;
  /** Free-form description (the bank string). */
  description: string;
  /** Signed amount; included so Claude can use it as a hint. */
  amount: number;
  currency: string;
}

export interface CategoryAssignment {
  transaction_id: string;
  category: string;
  /** 0.0–1.0; "Uncategorized" must come back with confidence 0. */
  confidence: number;
}

export interface ClaudeClientOptions {
  apiKey: string;
  model?: string;
  fetch?: FetchLike;
  /** ms-resolution sleep; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Override max retries for 429 / 5xx (default 3). */
  maxRetries?: number;
  /** Random function (jitter; injectable for determinism in tests). */
  random?: () => number;
  /** Override base URL (mostly for tests / proxies). */
  baseUrl?: string;
}

/**
 * Subset of Anthropic's tool spec we actually use. Kept narrow so Phase 5
 * can extend without us depending on the SDK's generated types.
 */
export interface ClaudeTool {
  name: string;
  description?: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [k: string]: unknown;
  };
}

export type ClaudeToolChoice = { type: 'auto' } | { type: 'any' } | { type: 'tool'; name: string };

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string | ClaudeContentBlock[];
}

export type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string | Array<{ type: 'text'; text: string }>;
      is_error?: boolean;
    };

export interface MessagesCreateRequest {
  model?: string;
  max_tokens: number;
  system?: string;
  messages: ClaudeMessage[];
  tools?: ClaudeTool[];
  tool_choice?: ClaudeToolChoice;
}

export interface ClaudeMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: ClaudeContentBlock[];
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
  stop_sequence: string | null;
  usage?: { input_tokens: number; output_tokens: number };
}

const DEFAULT_RETRIES = 3;
const BACKOFF_BASE_MS = 250;
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class ClaudeClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly randomFn: () => number;
  private readonly maxRetries: number;
  private readonly baseUrl: string;

  constructor(opts: ClaudeClientOptions) {
    if (!opts.apiKey || opts.apiKey.length === 0) {
      throw new ValidationError('ClaudeClient requires a non-empty apiKey');
    }
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_CLAUDE_MODEL;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.sleepFn = opts.sleep ?? defaultSleep;
    this.randomFn = opts.random ?? Math.random;
    this.maxRetries = opts.maxRetries ?? DEFAULT_RETRIES;
    this.baseUrl = opts.baseUrl ?? ANTHROPIC_BASE;
  }

  /** Read-only model accessor (ask command logs this). */
  get defaultModel(): string {
    return this.model;
  }

  private backoff(attempt: number): number {
    const expo = BACKOFF_BASE_MS * 2 ** attempt;
    const jitter = expo * this.randomFn();
    return Math.round(expo + jitter);
  }

  /**
   * Low-level passthrough to POST /v1/messages. Phase 5 (`ferret ask`) uses
   * this directly with `tools` + `tool_choice` to drive the tool-use loop.
   */
  async messagesCreate(req: MessagesCreateRequest): Promise<ClaudeMessageResponse> {
    const body: MessagesCreateRequest & { model: string } = {
      ...req,
      model: req.model ?? this.model,
    };
    const url = `${this.baseUrl}/v1/messages`;
    let attempt = 0;
    while (true) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        // Network-level failure (DNS / TCP / TLS). Retry with backoff like 5xx.
        if (attempt >= this.maxRetries) {
          throw new NetworkError(
            `Anthropic /v1/messages unreachable after ${this.maxRetries} retries: ${(err as Error).message}`,
          );
        }
        await this.sleepFn(this.backoff(attempt));
        attempt += 1;
        continue;
      }

      if (res.ok) {
        return (await res.json()) as ClaudeMessageResponse;
      }

      if (res.status === 429) {
        if (attempt >= this.maxRetries) {
          throw new RateLimitError(
            `Anthropic /v1/messages rate-limited (429) after ${this.maxRetries} retries.`,
          );
        }
        const retryAfterHeader = res.headers.get('retry-after');
        const retryAfterMs = parseRetryAfter(retryAfterHeader);
        await this.sleepFn(retryAfterMs ?? this.backoff(attempt));
        attempt += 1;
        continue;
      }

      if (res.status >= 500 && res.status < 600) {
        if (attempt >= this.maxRetries) {
          const text = await safeReadText(res);
          throw new NetworkError(
            `Anthropic /v1/messages failed (${res.status}) after ${this.maxRetries} retries: ${truncate(text, 300)}`,
          );
        }
        await this.sleepFn(this.backoff(attempt));
        attempt += 1;
        continue;
      }

      // Other 4xx — terminal.
      const text = await safeReadText(res);
      const parsed = safeParseJson<{ error?: { message?: string; type?: string } }>(text);
      const detail = parsed?.error?.message ?? text;
      throw new NetworkError(
        `Anthropic /v1/messages failed (${res.status}): ${truncate(detail, 300)}`,
      );
    }
  }

  /**
   * Categorize a batch of transactions. Splits at 50/call (PRD §4.4) and
   * coerces structured JSON output via tool use (PRD §8.2). Confidence is
   * clamped to [0, 1]; "Uncategorized" is returned for unknown txn ids.
   */
  async categorize(txns: TxnLite[], availableCategories: string[]): Promise<CategoryAssignment[]> {
    if (txns.length === 0) return [];
    if (availableCategories.length === 0) {
      throw new ValidationError('categorize() requires at least one available category');
    }

    const tool = buildCategorizeTool(availableCategories);
    const out: CategoryAssignment[] = [];

    for (let i = 0; i < txns.length; i += CATEGORIZE_BATCH_SIZE) {
      const batch = txns.slice(i, i + CATEGORIZE_BATCH_SIZE);
      const resp = await this.messagesCreate({
        max_tokens: CATEGORIZE_MAX_TOKENS,
        system: buildCategorizeSystemPrompt(availableCategories),
        tools: [tool],
        tool_choice: { type: 'tool', name: CATEGORIZE_TOOL_NAME },
        messages: [
          {
            role: 'user',
            content: JSON.stringify(
              batch.map((t) => ({
                transaction_id: t.id,
                merchant: t.merchant,
                description: t.description,
                amount: t.amount,
                currency: t.currency,
              })),
            ),
          },
        ],
      });

      const parsed = parseCategorizeResponse(resp);
      const seen = new Set(parsed.map((p) => p.transaction_id));
      out.push(...parsed);
      // Anything Claude omitted from its tool input falls through as
      // Uncategorized so the pipeline still has a deterministic result for
      // every input txn.
      for (const t of batch) {
        if (!seen.has(t.id)) {
          out.push({ transaction_id: t.id, category: 'Uncategorized', confidence: 0 });
        }
      }
    }
    return out;
  }
}

// ---------- Public helpers (also used by Phase 5) ----------

/**
 * Builder for adding tools to a `messagesCreate` request without mutating the
 * client. Phase 5 will use this to attach the ask-mode tool suite.
 */
export function withTools(
  base: MessagesCreateRequest,
  tools: ClaudeTool[],
  toolChoice?: ClaudeToolChoice,
): MessagesCreateRequest {
  return {
    ...base,
    tools: [...(base.tools ?? []), ...tools],
    tool_choice: toolChoice ?? base.tool_choice ?? { type: 'auto' },
  };
}

export function buildCategorizeSystemPrompt(availableCategories: string[]): string {
  // Mirrors PRD §8.2's example. The tool-use coercion is what gives us
  // structured output; the prompt is short and focused on the rubric.
  return [
    'You are a financial transaction classifier.',
    'Given a list of bank transactions, classify each into exactly one of these categories:',
    availableCategories.join(', '),
    '.',
    'Use "Uncategorized" if unsure. Confidence is 0.0 to 1.0.',
    `Call the ${CATEGORIZE_TOOL_NAME} tool with one entry per transaction_id from the input.`,
  ].join(' ');
}

export function buildCategorizeTool(availableCategories: string[]): ClaudeTool {
  return {
    name: CATEGORIZE_TOOL_NAME,
    description:
      'Record categorizations for the supplied bank transactions. One entry per transaction_id.',
    input_schema: {
      type: 'object',
      properties: {
        assignments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              transaction_id: { type: 'string' },
              category: { type: 'string', enum: availableCategories },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
            },
            required: ['transaction_id', 'category', 'confidence'],
          },
        },
      },
      required: ['assignments'],
    },
  };
}

export function parseCategorizeResponse(resp: ClaudeMessageResponse): CategoryAssignment[] {
  const block = resp.content.find(
    (b): b is Extract<ClaudeContentBlock, { type: 'tool_use' }> =>
      b.type === 'tool_use' && b.name === CATEGORIZE_TOOL_NAME,
  );
  if (!block) {
    throw new NetworkError(
      `Anthropic categorize response missing ${CATEGORIZE_TOOL_NAME} tool_use block; stop_reason=${resp.stop_reason ?? 'null'}`,
    );
  }
  const input = block.input as { assignments?: unknown };
  const arr = Array.isArray(input?.assignments) ? input.assignments : [];
  const out: CategoryAssignment[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.transaction_id === 'string' ? r.transaction_id : null;
    const category = typeof r.category === 'string' ? r.category : null;
    if (!id || !category) continue;
    let conf = typeof r.confidence === 'number' ? r.confidence : 0;
    if (!Number.isFinite(conf)) conf = 0;
    if (conf < 0) conf = 0;
    if (conf > 1) conf = 1;
    out.push({ transaction_id: id, category, confidence: conf });
  }
  return out;
}

// ---------- Internal helpers ----------

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function safeParseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}...`;
}
