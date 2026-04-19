import { describe, expect, test } from 'bun:test';
import {
  CATEGORIZE_TOOL_NAME,
  ClaudeClient,
  type ClaudeMessageResponse,
  type FetchLike,
  buildCategorizeTool,
  parseCategorizeResponse,
  withTools,
} from '../../src/services/claude';

interface ScriptedResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function mockFetch(responses: ScriptedResponse[]): { fetch: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: input.toString(), init });
    const next = queue.shift();
    if (!next) throw new Error(`No scripted response for ${input.toString()}`);
    const status = next.status ?? 200;
    const body = typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {});
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
    });
  };
  return { fetch: fetchImpl, calls };
}

const goodCategorizeResponse: ClaudeMessageResponse = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-4-7',
  content: [
    {
      type: 'tool_use',
      id: 'tu_1',
      name: CATEGORIZE_TOOL_NAME,
      input: {
        assignments: [
          { transaction_id: 't1', category: 'Groceries', confidence: 0.9 },
          { transaction_id: 't2', category: 'Eating Out', confidence: 0.7 },
        ],
      },
    },
  ],
  stop_reason: 'tool_use',
  stop_sequence: null,
};

describe('ClaudeClient.messagesCreate', () => {
  test('posts the right shape and parses the response', async () => {
    const { fetch, calls } = mockFetch([{ body: goodCategorizeResponse }]);
    const client = new ClaudeClient({
      apiKey: 'sk-test',
      fetch,
      sleep: async () => {},
      random: () => 0,
    });
    const resp = await client.messagesCreate({
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(resp.stop_reason).toBe('tool_use');
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call?.init?.method).toBe('POST');
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBeTruthy();
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse((call?.init?.body as string) ?? '{}');
    expect(body.model).toBe('claude-opus-4-7');
    expect(body.max_tokens).toBe(1024);
    expect(body.messages[0].content).toBe('hi');
  });

  test('retries on 429 respecting Retry-After (seconds)', async () => {
    const sleeps: number[] = [];
    const { fetch, calls } = mockFetch([
      { status: 429, headers: { 'retry-after': '2' }, body: { error: 'slow down' } },
      { body: goodCategorizeResponse },
    ]);
    const client = new ClaudeClient({
      apiKey: 'sk-test',
      fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0,
    });
    await client.messagesCreate({
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(calls).toHaveLength(2);
    expect(sleeps[0]).toBe(2000);
  });

  test('retries on 5xx with exponential backoff (250ms base)', async () => {
    const sleeps: number[] = [];
    const { fetch, calls } = mockFetch([
      { status: 503, body: { error: 'down' } },
      { status: 503, body: { error: 'down' } },
      { body: goodCategorizeResponse },
    ]);
    const client = new ClaudeClient({
      apiKey: 'sk-test',
      fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0,
    });
    await client.messagesCreate({
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(calls).toHaveLength(3);
    // attempt 0: base * 2^0 = 250ms; attempt 1: base * 2^1 = 500ms (jitter=0)
    expect(sleeps).toEqual([250, 500]);
  });

  test('gives up with RateLimitError after maxRetries on persistent 429', async () => {
    const { fetch } = mockFetch([
      { status: 429, body: { error: 'slow' } },
      { status: 429, body: { error: 'slow' } },
      { status: 429, body: { error: 'slow' } },
      { status: 429, body: { error: 'slow' } },
    ]);
    const client = new ClaudeClient({
      apiKey: 'sk-test',
      fetch,
      sleep: async () => {},
      random: () => 0,
    });
    await expect(
      client.messagesCreate({ max_tokens: 1, messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow(/rate-limited/);
  });

  test('NetworkError on terminal 4xx', async () => {
    const { fetch } = mockFetch([
      { status: 400, body: { error: { type: 'invalid_request', message: 'bad' } } },
    ]);
    const client = new ClaudeClient({
      apiKey: 'sk-test',
      fetch,
      sleep: async () => {},
    });
    await expect(
      client.messagesCreate({ max_tokens: 1, messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow(/Anthropic \/v1\/messages failed \(400\)/);
  });
});

describe('ClaudeClient.categorize', () => {
  test('builds tool_use payload and parses assignments', async () => {
    const { fetch, calls } = mockFetch([{ body: goodCategorizeResponse }]);
    const client = new ClaudeClient({
      apiKey: 'sk-test',
      fetch,
      sleep: async () => {},
      random: () => 0,
    });
    const resp = await client.categorize(
      [
        { id: 't1', merchant: 'Tesco', description: 'TESCO', amount: -10, currency: 'GBP' },
        { id: 't2', merchant: 'Pret', description: 'PRET', amount: -5, currency: 'GBP' },
      ],
      ['Groceries', 'Eating Out', 'Uncategorized'],
    );
    expect(resp).toHaveLength(2);
    expect(resp.find((r) => r.transaction_id === 't1')?.category).toBe('Groceries');

    // Verify the request payload shape: tool with categories enum, tool_choice
    // pinning the tool name.
    const body = JSON.parse((calls[0]?.init?.body as string) ?? '{}');
    expect(body.tools).toBeDefined();
    expect(body.tools[0].name).toBe(CATEGORIZE_TOOL_NAME);
    expect(body.tool_choice).toEqual({ type: 'tool', name: CATEGORIZE_TOOL_NAME });
    // The categories are passed via the JSON-Schema enum.
    const enumVals = body.tools[0].input_schema.properties.assignments.items.properties.category
      .enum as string[];
    expect(enumVals).toEqual(['Groceries', 'Eating Out', 'Uncategorized']);
  });

  test('fills missing transaction_ids with Uncategorized', async () => {
    const partialResponse: ClaudeMessageResponse = {
      ...goodCategorizeResponse,
      content: [
        {
          type: 'tool_use',
          id: 'tu_1',
          name: CATEGORIZE_TOOL_NAME,
          input: {
            assignments: [{ transaction_id: 't1', category: 'Groceries', confidence: 0.9 }],
          },
        },
      ],
    };
    const { fetch } = mockFetch([{ body: partialResponse }]);
    const client = new ClaudeClient({ apiKey: 'sk-test', fetch });
    const resp = await client.categorize(
      [
        { id: 't1', merchant: 'Tesco', description: 'x', amount: -1, currency: 'GBP' },
        { id: 't2', merchant: 'Mystery', description: 'x', amount: -1, currency: 'GBP' },
      ],
      ['Groceries', 'Uncategorized'],
    );
    const t2 = resp.find((r) => r.transaction_id === 't2');
    expect(t2?.category).toBe('Uncategorized');
    expect(t2?.confidence).toBe(0);
  });

  test('batches at 50 transactions per call', async () => {
    const txns = Array.from({ length: 75 }, (_, i) => ({
      id: `t${i}`,
      merchant: 'm',
      description: 'd',
      amount: -1,
      currency: 'GBP',
    }));
    const buildResponse = (ids: string[]): ClaudeMessageResponse => ({
      id: 'msg',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [
        {
          type: 'tool_use',
          id: 'tu',
          name: CATEGORIZE_TOOL_NAME,
          input: {
            assignments: ids.map((id) => ({
              transaction_id: id,
              category: 'Groceries',
              confidence: 0.9,
            })),
          },
        },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
    });

    const first = txns.slice(0, 50).map((t) => t.id);
    const second = txns.slice(50).map((t) => t.id);
    const { fetch, calls } = mockFetch([
      { body: buildResponse(first) },
      { body: buildResponse(second) },
    ]);
    const client = new ClaudeClient({ apiKey: 'sk-test', fetch });
    const resp = await client.categorize(txns, ['Groceries', 'Uncategorized']);
    expect(calls).toHaveLength(2);
    expect(resp).toHaveLength(75);
  });
});

describe('parseCategorizeResponse', () => {
  test('clamps confidence to [0,1]', () => {
    const resp: ClaudeMessageResponse = {
      ...goodCategorizeResponse,
      content: [
        {
          type: 'tool_use',
          id: 'tu',
          name: CATEGORIZE_TOOL_NAME,
          input: {
            assignments: [
              { transaction_id: 't1', category: 'Groceries', confidence: 1.5 },
              { transaction_id: 't2', category: 'Groceries', confidence: -1 },
              { transaction_id: 't3', category: 'Groceries', confidence: Number.NaN },
            ],
          },
        },
      ],
    };
    const out = parseCategorizeResponse(resp);
    expect(out.find((r) => r.transaction_id === 't1')?.confidence).toBe(1);
    expect(out.find((r) => r.transaction_id === 't2')?.confidence).toBe(0);
    expect(out.find((r) => r.transaction_id === 't3')?.confidence).toBe(0);
  });

  test('throws NetworkError when tool_use block missing', () => {
    const resp: ClaudeMessageResponse = {
      ...goodCategorizeResponse,
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
    };
    expect(() => parseCategorizeResponse(resp)).toThrow(/missing/);
  });
});

describe('withTools builder', () => {
  test('appends tools and sets default tool_choice', () => {
    const t = buildCategorizeTool(['A', 'B']);
    const out = withTools({ max_tokens: 1, messages: [{ role: 'user', content: 'x' }] }, [t]);
    expect(out.tools).toHaveLength(1);
    expect(out.tool_choice).toEqual({ type: 'auto' });
  });

  test('respects an explicit tool_choice override', () => {
    const t = buildCategorizeTool(['A']);
    const out = withTools({ max_tokens: 1, messages: [{ role: 'user', content: 'x' }] }, [t], {
      type: 'tool',
      name: t.name,
    });
    expect(out.tool_choice).toEqual({ type: 'tool', name: t.name });
  });
});
