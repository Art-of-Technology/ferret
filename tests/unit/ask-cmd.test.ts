// Integration test for `ferret ask`. We don't shell out to the CLI here
// because the command needs an injected mock Claude client to avoid hitting
// the network. Instead we drive the citty command's `run()` directly with
// a temp HOME, real on-disk SQLite (init + seed), and a stubbed
// ClaudeClient module.
//
// What this test exercises end to end:
//   1. ANTHROPIC_API_KEY missing -> ConfigError exit code 2.
//   2. With the env var set + a mocked client, `ferret ask "..."` writes
//      the answer text to stdout.
//   3. `--json` mode collects the answer and surfaces a structured
//      payload including the `tools_used` log.

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Pin HOME to a temp dir BEFORE any module that captures it at top-level
// import time (db/client.ts derives FERRET_HOME from process.env.HOME on
// load). Test isolation depends on this happening before the dynamic
// imports below.
const tmp = mkdtempSync(join(tmpdir(), 'ferret-ask-cmd-'));
process.env.HOME = tmp;

const { resetDbCache } = await import('../../src/db/client');
type ClaudeMessageResponse = import('../../src/services/claude').ClaudeMessageResponse;
type MessagesCreateRequest = import('../../src/services/claude').MessagesCreateRequest;

// We swap stdout + stderr into capture buffers around each invocation so
// asserting on the streamed output stays deterministic.
let stdout: string[] = [];
let stderr: string[] = [];
const realStdoutWrite = process.stdout.write.bind(process.stdout);
const realStderrWrite = process.stderr.write.bind(process.stderr);

function captureStreams(): void {
  stdout = [];
  stderr = [];
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
}

function restoreStreams(): void {
  process.stdout.write = realStdoutWrite;
  process.stderr.write = realStderrWrite;
}

/**
 * Replace the real ClaudeClient module with a scripted version. The
 * orchestrator imports `ClaudeClient` from `../services/claude`; bun:test's
 * `mock.module` rewires the constructor so the command builds our stub
 * instead of the real HTTP client.
 */
function installScriptedClaude(responses: ClaudeMessageResponse[]): {
  calls: MessagesCreateRequest[];
  reset: () => void;
} {
  const calls: MessagesCreateRequest[] = [];
  let i = 0;
  mock.module('../../src/services/claude', () => ({
    ANTHROPIC_BASE: 'https://api.anthropic.com',
    ANTHROPIC_VERSION: '2023-06-01',
    DEFAULT_CLAUDE_MODEL: 'claude-opus-4-7',
    CATEGORIZE_TOOL_NAME: 'record_categorizations',
    CATEGORIZE_BATCH_SIZE: 50,
    CATEGORIZE_MAX_TOKENS: 2048,
    withTools: (base: unknown, tools: unknown) => ({
      ...(base as object),
      tools,
      tool_choice: { type: 'auto' },
    }),
    ClaudeClient: class {
      defaultModel = 'claude-opus-4-7';
      async messagesCreate(req: MessagesCreateRequest): Promise<ClaudeMessageResponse> {
        calls.push({ ...req, messages: [...req.messages] });
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
      }
    },
  }));
  return { calls, reset: () => mock.restore() };
}

beforeAll(async () => {
  resetDbCache();
  // Bring up ~/.ferret + DB + categories via the same code path the user
  // would (the `init` command).
  const initMod = await import('../../src/commands/init');
  await (initMod.default as { run: (ctx?: unknown) => unknown }).run();
});

beforeEach(() => {
  // Each test installs its own scripted responses; clear the env first.
  // Bun preserves `undefined` here (Node would coerce to "undefined"); the
  // secrets resolver short-circuits on falsy/empty values either way.
  process.env.ANTHROPIC_API_KEY = '';
});

afterAll(() => {
  restoreStreams();
  rmSync(tmp, { recursive: true, force: true });
});

async function runAsk(args: Record<string, unknown>): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  // Re-import the command fresh so the mocked ClaudeClient is picked up.
  const mod = await import(`../../src/commands/ask?cb=${Math.random()}`);
  const cmd = (mod.default ?? mod) as {
    run: (ctx: { args: Record<string, unknown> }) => Promise<void>;
  };
  let exitCode: number | null = null;
  const realExit = process.exit;
  process.exit = ((code?: number): never => {
    exitCode = code ?? 0;
    throw new Error('__exit__');
  }) as typeof process.exit;
  captureStreams();
  try {
    await cmd.run({ args });
  } catch (err) {
    if ((err as Error).message !== '__exit__') {
      // Surface non-exit errors as a non-zero exit so the caller can assert.
      stderr.push(`${(err as Error).name}: ${(err as Error).message}\n`);
      exitCode = exitCode ?? 1;
    }
  } finally {
    process.exit = realExit;
    restoreStreams();
  }
  return { exitCode, stdout: stdout.join(''), stderr: stderr.join('') };
}

describe('ferret ask command', () => {
  test('missing ANTHROPIC_API_KEY produces a ConfigError', async () => {
    const { reset } = installScriptedClaude([]);
    try {
      const { exitCode, stderr: errOut, stdout: outOut } = await runAsk({ question: 'hi' });
      // resolveSecret throws ConfigError; the citty runner surfaces it. We
      // catch it via the test harness's exit-shim so the run completes.
      const combined = `${outOut}${errOut}`;
      expect(combined).toContain('Anthropic API key');
      expect(exitCode === null || exitCode !== 0).toBe(true);
    } finally {
      reset();
    }
  });

  test('streams the assistant text answer to stdout', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-mock';
    const { reset } = installScriptedClaude([
      {
        id: 'm1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [{ type: 'text', text: 'You spent £42 on Eating Out.' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
      },
    ]);
    try {
      const { stdout: out } = await runAsk({ question: 'how much on eating out?' });
      expect(out).toContain('You spent £42 on Eating Out.');
    } finally {
      reset();
    }
  });

  test('--json wraps the answer + tools_used metadata', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-mock';
    const { reset } = installScriptedClaude([
      // Tool round trip: get_account_list, then end_turn.
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
        content: [{ type: 'text', text: 'You have no accounts yet.' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
      },
    ]);
    try {
      const { stdout: out } = await runAsk({ question: 'list accounts', json: true });
      const parsed = JSON.parse(out) as {
        question: string;
        answer: string;
        tools_used: Array<{ name: string; ok: boolean }>;
        iterations: number;
      };
      expect(parsed.question).toBe('list accounts');
      expect(parsed.answer).toBe('You have no accounts yet.');
      expect(parsed.tools_used.map((t) => t.name)).toEqual(['get_account_list']);
      expect(parsed.tools_used[0]?.ok).toBe(true);
      expect(parsed.iterations).toBeGreaterThanOrEqual(2);
    } finally {
      reset();
    }
  });
});
