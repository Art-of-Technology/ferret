// Unit tests for the `ferret ask` tool-use loop. The Claude client is
// fully mocked so no real API calls are issued; the tests script the
// model's responses to drive the orchestrator through every code path:
// single end_turn, single tool round-trip, max-iterations cap, and
// AbortSignal cancellation.

import { describe, expect, test } from 'bun:test';
import {
  type AskEvent,
  buildToolDefs,
  DEFAULT_MAX_ITERATIONS,
  runAsk,
  TOOL_RESULT_MAX_CHARS,
  truncateToolContent,
} from '../../src/services/ask';
import type {
  ClaudeClient,
  ClaudeMessageResponse,
  MessagesCreateRequest,
} from '../../src/services/claude';

interface ScriptedClient {
  client: ClaudeClient;
  calls: MessagesCreateRequest[];
  /** Signal seen on the most recent `messagesCreate` call (if any). */
  signals: Array<AbortSignal | undefined>;
}

/**
 * Minimal scripted ClaudeClient: returns the next response in the queue
 * on each `messagesCreate` call. Anything beyond the queue length is
 * `end_turn` with empty text so an over-long loop fails loudly.
 */
function scriptedClient(
  responses: ClaudeMessageResponse[],
  hooks: { onCall?: (req: MessagesCreateRequest) => Promise<void> | void } = {},
): ScriptedClient {
  const calls: MessagesCreateRequest[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  let i = 0;
  const client = {
    defaultModel: 'claude-opus-4-7',
    async messagesCreate(
      req: MessagesCreateRequest,
      callOpts: { signal?: AbortSignal } = {},
    ): Promise<ClaudeMessageResponse> {
      // Snapshot the messages array at call-time. The orchestrator owns
      // a single `messages` array that it mutates between iterations, so
      // a naive reference-store would let later mutations leak into the
      // earlier `calls[i]` view. Tests assert against per-call history.
      calls.push({ ...req, messages: [...req.messages] });
      signals.push(callOpts.signal);
      if (hooks.onCall) await hooks.onCall(req);
      // Mid-call abort surfaces as an AbortError throw, mirroring fetch.
      if (callOpts.signal?.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      const next = responses[i] ?? {
        id: 'fallback',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [{ type: 'text', text: '(end)' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
      };
      i += 1;
      return next;
    },
  } as unknown as ClaudeClient;
  return { client, calls, signals };
}

async function collect(stream: AsyncIterable<AskEvent>): Promise<AskEvent[]> {
  const out: AskEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe('runAsk — happy path', () => {
  test('single end_turn streams text and emits done', async () => {
    const { client, calls } = scriptedClient([
      {
        id: 'm1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [{ type: 'text', text: 'hello world' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
      },
    ]);
    const events = await collect(
      runAsk({
        question: 'hi',
        claudeClient: client,
      }),
    );
    expect(calls).toHaveLength(1);
    const tokens = events.filter((e) => e.type === 'token');
    expect(tokens).toEqual([{ type: 'token', text: 'hello world', isFinal: true }]);
    const done = events.find((e) => e.type === 'done');
    expect(done?.type).toBe('done');
    if (done?.type === 'done') {
      expect(done.iterations).toBe(1);
      expect(done.stopReason).toBe('end_turn');
    }
  });

  test('passes the system prompt and tool definitions on every call', async () => {
    const { client, calls } = scriptedClient([
      {
        id: 'm1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [{ type: 'text', text: 'answer' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
      },
    ]);
    await collect(runAsk({ question: 'q', claudeClient: client, maxTokens: 1024 }));
    expect(calls[0]?.system).toContain('Ferret');
    expect(calls[0]?.tools?.map((t) => t.name).sort()).toEqual([
      'get_account_list',
      'get_category_summary',
      'get_recurring_payments',
      'propose_budgets',
      'query_transactions',
    ]);
    expect(calls[0]?.max_tokens).toBe(1024);
  });
});

describe('runAsk — tool round trip', () => {
  test('dispatches tool, feeds result back, then ends', async () => {
    const { client, calls } = scriptedClient([
      // First response: tool_use for get_account_list.
      {
        id: 'm1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [
          { type: 'text', text: 'looking up accounts...' },
          { type: 'tool_use', id: 'tu1', name: 'get_account_list', input: {} },
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
      },
      // Second response: end_turn after seeing the tool result.
      {
        id: 'm2',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [{ type: 'text', text: 'You have 2 accounts.' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
      },
    ]);

    const events = await collect(
      runAsk({
        question: 'list my accounts',
        claudeClient: client,
        tools: {
          get_account_list: () => [
            // Skip Account fields not exercised by the orchestrator beyond
            // arity; cast through unknown is intentional for test brevity.
            { id: 'a1', displayName: 'Current' } as never,
            { id: 'a2', displayName: 'Savings' } as never,
          ],
        },
      }),
    );

    // Expect: token, tool_call, tool_result, token (paragraph break
    // injected between turns), token, done — in order. The separator
    // ensures narration from the first turn doesn't run straight into
    // the answer text from the second turn.
    const types = events.map((e) => e.type);
    expect(types).toEqual(['token', 'tool_call', 'tool_result', 'token', 'token', 'done']);

    // isFinal labeling — interim narration (the first text block,
    // part of the tool_use turn) is marked non-final so the CLI can
    // hide it; the terminal turn's text is final. The paragraph
    // separator between turns inherits the incoming turn's isFinal
    // so it stays attached to the final answer rather than getting
    // dropped with the interim narration.
    const tokens = events.filter((e) => e.type === 'token');
    expect(tokens[0]).toMatchObject({ text: 'looking up accounts...', isFinal: false });
    expect(tokens[1]).toMatchObject({ isFinal: true }); // paragraph separator
    expect(tokens[2]).toMatchObject({ text: 'You have 2 accounts.', isFinal: true });

    const call = events.find((e) => e.type === 'tool_call');
    expect(call?.type === 'tool_call' && call.name).toBe('get_account_list');
    const result = events.find((e) => e.type === 'tool_result');
    expect(result?.type === 'tool_result' && result.ok).toBe(true);
    expect(result?.type === 'tool_result' && result.summary).toContain('2 accounts');

    // The second model call should include the assistant tool_use and the
    // user tool_result block in the message history.
    expect(calls).toHaveLength(2);
    const secondMsgs = calls[1]?.messages ?? [];
    const lastUser = secondMsgs[secondMsgs.length - 1];
    expect(lastUser?.role).toBe('user');
    if (Array.isArray(lastUser?.content)) {
      const tr = lastUser?.content.find((b) => 'type' in b && b.type === 'tool_result');
      expect(tr).toBeDefined();
    } else {
      throw new Error('tool_result feedback must be an array of content blocks');
    }
  });

  test('dispatches multiple tool_use blocks from one assistant turn', async () => {
    const { client, calls } = scriptedClient([
      {
        id: 'm1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [
          { type: 'tool_use', id: 'tu1', name: 'get_account_list', input: {} },
          {
            type: 'tool_use',
            id: 'tu2',
            name: 'get_recurring_payments',
            input: { min_occurrences: 3 },
          },
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
      },
      {
        id: 'm2',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
      },
    ]);

    let listed = 0;
    let recurringCalled = 0;
    const events = await collect(
      runAsk({
        question: 'analyze',
        claudeClient: client,
        tools: {
          get_account_list: () => {
            listed += 1;
            return [];
          },
          get_recurring_payments: () => {
            recurringCalled += 1;
            return [];
          },
        },
      }),
    );

    expect(listed).toBe(1);
    expect(recurringCalled).toBe(1);
    const callsByName = events
      .filter((e) => e.type === 'tool_call')
      .map((e) => (e.type === 'tool_call' ? e.name : ''));
    expect(callsByName).toEqual(['get_account_list', 'get_recurring_payments']);

    // Both tool_results must be in a single user message in the history.
    const secondMsgs = calls[1]?.messages ?? [];
    const lastUser = secondMsgs[secondMsgs.length - 1];
    if (!Array.isArray(lastUser?.content)) {
      throw new Error('expected array content');
    }
    const trs = lastUser.content.filter((b) => 'type' in b && b.type === 'tool_result');
    expect(trs).toHaveLength(2);
  });
});

describe('runAsk — safety caps', () => {
  test('caps iterations when Claude never returns end_turn', async () => {
    // Build a stream of tool_use responses longer than the cap.
    const looping: ClaudeMessageResponse[] = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [{ type: 'tool_use', id: `tu${i}`, name: 'get_account_list', input: {} }],
      stop_reason: 'tool_use',
      stop_sequence: null,
    }));
    const { client, calls } = scriptedClient(looping);
    const events = await collect(
      runAsk({
        question: 'loop forever',
        claudeClient: client,
        tools: { get_account_list: () => [] },
      }),
    );
    expect(calls.length).toBe(DEFAULT_MAX_ITERATIONS);
    const done = events.find((e) => e.type === 'done');
    expect(done?.type === 'done' && done.iterations).toBe(DEFAULT_MAX_ITERATIONS);
  });

  test('forwards the AbortSignal into messagesCreate', async () => {
    const ac = new AbortController();
    const { client, signals } = scriptedClient([
      {
        id: 'm1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
      },
    ]);
    await collect(runAsk({ question: 'q', claudeClient: client, abortSignal: ac.signal }));
    // The loop must thread its abortSignal into every Claude call; without
    // this propagation a long streaming response can't be cancelled
    // mid-call (the previous behaviour only checked between iterations).
    expect(signals[0]).toBe(ac.signal);
  });

  test('aborts cleanly when the signal trips during a Claude call', async () => {
    // Simulate a Ctrl-C that arrives while the network call is in flight:
    // the scripted client checks the signal on entry and throws AbortError
    // (mirroring fetch), and the loop must yield `done` rather than
    // surfacing the throw to the caller.
    const ac = new AbortController();
    const { client, calls } = scriptedClient(
      [
        {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-7',
          content: [{ type: 'text', text: 'never' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
        },
      ],
      {
        onCall: () => {
          ac.abort();
        },
      },
    );
    const events = await collect(
      runAsk({ question: 'q', claudeClient: client, abortSignal: ac.signal }),
    );
    expect(calls.length).toBe(1);
    const done = events.find((e) => e.type === 'done');
    expect(done?.type).toBe('done');
  });

  test('honours AbortSignal between iterations', async () => {
    const ac = new AbortController();
    const { client, calls } = scriptedClient([
      // First response: tool_use. The orchestrator dispatches the tool,
      // then we abort BEFORE it would re-enter the loop.
      {
        id: 'm1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [{ type: 'tool_use', id: 'tu1', name: 'get_account_list', input: {} }],
        stop_reason: 'tool_use',
        stop_sequence: null,
      },
      // Second response should never be requested.
      {
        id: 'm2',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [{ type: 'text', text: 'too late' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
      },
    ]);
    const events = await collect(
      runAsk({
        question: 'q',
        claudeClient: client,
        abortSignal: ac.signal,
        tools: {
          get_account_list: () => {
            // Abort during the tool call so the post-iteration check trips.
            ac.abort();
            return [];
          },
        },
      }),
    );
    expect(calls.length).toBe(1);
    const done = events.find((e) => e.type === 'done');
    expect(done?.type).toBe('done');
  });
});

describe('runAsk — tool error handling', () => {
  test('tool exception becomes a tool_result with ok:false (not a hard throw)', async () => {
    const { client } = scriptedClient([
      {
        id: 'm1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [
          {
            type: 'tool_use',
            id: 'tu1',
            name: 'query_transactions',
            input: { sql: 'DROP TABLE x' },
          },
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
      },
      {
        id: 'm2',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [{ type: 'text', text: 'understood' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
      },
    ]);
    const events = await collect(
      runAsk({
        question: 'try evil',
        claudeClient: client,
        tools: {
          query_transactions: () => {
            throw new Error('SQL contains forbidden token: DROP');
          },
        },
      }),
    );
    const result = events.find((e) => e.type === 'tool_result');
    expect(result?.type === 'tool_result' && result.ok).toBe(false);
    expect(result?.type === 'tool_result' && result.summary).toContain('DROP');
  });
});

describe('truncateToolContent', () => {
  test('passes payloads under the cap through unchanged', () => {
    const small = JSON.stringify({ rows: [{ id: 1 }] });
    expect(truncateToolContent(small)).toBe(small);
  });

  test('truncates and appends a sentinel when over the cap', () => {
    const big = 'x'.repeat(TOOL_RESULT_MAX_CHARS + 500);
    const out = truncateToolContent(big);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain('... [truncated, 500 more chars]');
  });
});

describe('runAsk — tool result truncation', () => {
  test('oversized tool_result is truncated before reaching Claude', async () => {
    const huge = JSON.stringify({ rows: Array.from({ length: 5000 }, (_, i) => ({ id: i })) });
    expect(huge.length).toBeGreaterThan(TOOL_RESULT_MAX_CHARS);
    const { client, calls } = scriptedClient([
      {
        id: 'm1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [{ type: 'tool_use', id: 'tu1', name: 'get_account_list', input: {} }],
        stop_reason: 'tool_use',
        stop_sequence: null,
      },
      {
        id: 'm2',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
      },
    ]);
    await collect(
      runAsk({
        question: 'q',
        claudeClient: client,
        tools: {
          // Force a payload large enough to trip truncation by returning a
          // synthetic huge account list. The orchestrator stringifies via
          // the get_account_list branch, so we just need >5k entries.
          get_account_list: () =>
            Array.from({ length: 5000 }, (_, i) => ({ id: `a${i}`, displayName: 'x' }) as never),
        },
      }),
    );
    const second = calls[1]?.messages ?? [];
    const lastUser = second[second.length - 1];
    if (!Array.isArray(lastUser?.content)) throw new Error('expected array content');
    const tr = lastUser.content.find((b) => 'type' in b && b.type === 'tool_result') as
      | { content: string }
      | undefined;
    expect(tr).toBeDefined();
    expect(tr?.content.length).toBeLessThanOrEqual(
      TOOL_RESULT_MAX_CHARS + ' more chars]'.length + 32,
    );
    expect(tr?.content).toContain('[truncated,');
  });
});

describe('runAsk — propose_budgets', () => {
  test('accumulates accepted proposals and surfaces them on the done event', async () => {
    const { client } = scriptedClient([
      {
        id: 'm1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'propose_budgets',
            input: {
              budgets: [
                { category: 'Groceries', monthly_amount: 350, rationale: 'avg 320 last 3mo' },
                { category: 'Eating Out', monthly_amount: 200 },
              ],
            },
          },
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
      },
      {
        id: 'm2',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [{ type: 'text', text: 'I proposed two budgets.' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
      },
    ]);
    const events = await collect(
      runAsk({
        question: 'help me budget',
        claudeClient: client,
        tools: {
          propose_budgets: ({ budgets }) => ({
            accepted: budgets.map((b) => ({
              category: b.category,
              monthlyAmount: b.monthly_amount,
              currency: 'GBP',
              rationale: b.rationale,
            })),
            rejected: [],
          }),
        },
      }),
    );
    const done = events.find((e) => e.type === 'done');
    expect(done?.type).toBe('done');
    if (done?.type !== 'done') throw new Error('expected done event');
    expect(done.proposals?.length).toBe(2);
    expect(done.proposals?.[0]?.category).toBe('Groceries');
    expect(done.proposals?.[0]?.monthlyAmount).toBe(350);
    expect(done.proposals?.[0]?.rationale).toBe('avg 320 last 3mo');
    expect(done.proposals?.[1]?.category).toBe('Eating Out');
  });

  test('feeds rejected proposals back to Claude so it can adjust', async () => {
    const { client, calls } = scriptedClient([
      {
        id: 'm1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'propose_budgets',
            input: { budgets: [{ category: 'Vacations', monthly_amount: 500 }] },
          },
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
      },
      {
        id: 'm2',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [{ type: 'text', text: 'noted' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
      },
    ]);
    await collect(
      runAsk({
        question: 'budget for vacations',
        claudeClient: client,
        tools: {
          propose_budgets: () => ({
            accepted: [],
            rejected: [{ category: 'Vacations', reason: 'unknown category' }],
          }),
        },
      }),
    );
    // The second call's last user message should contain the tool_result with
    // the rejection payload so Claude can re-propose against a real category.
    const secondCall = calls[1];
    const lastMsg = secondCall?.messages[secondCall.messages.length - 1];
    expect(lastMsg?.role).toBe('user');
    const content = JSON.stringify(lastMsg?.content);
    expect(content).toContain('rejected');
    expect(content).toContain('unknown category');
  });
});

describe('buildToolDefs', () => {
  test('exposes the PRD §8.2 read tools plus propose_budgets', () => {
    const defs = buildToolDefs();
    expect(defs.map((d) => d.name).sort()).toEqual([
      'get_account_list',
      'get_category_summary',
      'get_recurring_payments',
      'propose_budgets',
      'query_transactions',
    ]);
    const sumDef = defs.find((d) => d.name === 'get_category_summary');
    expect(sumDef?.input_schema.required).toEqual(['from', 'to']);
    const queryDef = defs.find((d) => d.name === 'query_transactions');
    expect(queryDef?.input_schema.required).toEqual(['sql']);
    const proposeDef = defs.find((d) => d.name === 'propose_budgets');
    expect(proposeDef?.input_schema.required).toEqual(['budgets']);
  });
});
