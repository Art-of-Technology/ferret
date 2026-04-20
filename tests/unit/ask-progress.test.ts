// Tests for the progress-spinner helpers in src/commands/ask.ts.
// These guard the behavior the marketing mock depends on:
//   - one updating line per tool-name burst (not one line per call)
//   - switching tools commits the current line with a newline and
//     starts a fresh one
//   - the lingering line is cleaned up at end-of-loop so the rendered
//     answer doesn't land on top of a stray hint

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { clearProgressLine, newProgressState, writeProgress } from '../../src/commands/ask';

// Capture stderr writes so we can assert on the escape sequences
// writeProgress / clearProgressLine emit without painting a real
// terminal. The helpers only ever write to stderr, so restoring the
// real writer in afterEach is sufficient cleanup.
const realStderrWrite = process.stderr.write.bind(process.stderr);
let chunks: string[];

function captureStderr(): void {
  chunks = [];
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
}

function restoreStderr(): void {
  process.stderr.write = realStderrWrite;
}

// ESC byte built from char code to satisfy biome's no-control-in-regex
// rule. `\r\x1b[K` is the line-clear sequence writeProgress emits.
const ESC = String.fromCharCode(0x1b);
const LINE_CLEAR = `\r${ESC}[K`;

describe('newProgressState', () => {
  test('starts with no active tool, zero count, and no open line', () => {
    expect(newProgressState()).toEqual({ lastTool: null, count: 0, lineOpen: false });
  });
});

describe('writeProgress', () => {
  beforeEach(captureStderr);
  afterEach(restoreStderr);

  test('first call of a burst renders the bare tool name, no count suffix', () => {
    const s = newProgressState();
    writeProgress(s, 'query_transactions');
    const out = chunks.join('');
    expect(out.startsWith(LINE_CLEAR)).toBe(true);
    expect(out).toContain('query_transactions');
    expect(out).not.toContain('(×');
    expect(s.lastTool).toBe('query_transactions');
    expect(s.count).toBe(1);
    expect(s.lineOpen).toBe(true);
  });

  test('repeated same-tool calls increment count and render (×N) in place', () => {
    const s = newProgressState();
    writeProgress(s, 'query_transactions');
    writeProgress(s, 'query_transactions');
    writeProgress(s, 'query_transactions');
    // Three calls, count=3, no newline committed between them.
    expect(s.count).toBe(3);
    const out = chunks.join('');
    // The third write should include the (×3) suffix.
    expect(out).toContain('(×3)');
    // Each render starts with a line-clear — that's how we overwrite
    // the previous label without emitting extra rows.
    const clearCount = out.split(LINE_CLEAR).length - 1;
    expect(clearCount).toBe(3);
    // No line-commit newline while the tool name stays the same.
    expect(out).not.toContain('\n');
  });

  test('switching tools commits the current line with \\n and resets count', () => {
    const s = newProgressState();
    writeProgress(s, 'query_transactions');
    writeProgress(s, 'query_transactions'); // count = 2
    writeProgress(s, 'get_category_summary');
    expect(s.lastTool).toBe('get_category_summary');
    expect(s.count).toBe(1);
    const out = chunks.join('');
    // A single committing newline between the two bursts.
    expect(out.split('\n')).toHaveLength(2);
    // The new line ends in a fresh label without a count suffix.
    const afterNewline = out.split('\n')[1] ?? '';
    expect(afterNewline).toContain('get_category_summary');
    expect(afterNewline).not.toContain('(×');
  });
});

describe('clearProgressLine', () => {
  beforeEach(captureStderr);
  afterEach(restoreStderr);

  test('is a no-op when no line is open', () => {
    const s = newProgressState();
    clearProgressLine(s);
    expect(chunks.join('')).toBe('');
    expect(s.lineOpen).toBe(false);
  });

  test('clears the open line with \\r\\x1b[K when stderr is a TTY', () => {
    const s = newProgressState();
    writeProgress(s, 'query_transactions');
    // Force the isTTY branch — test runners normally expose false here.
    const prevIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    try {
      chunks = [];
      clearProgressLine(s);
    } finally {
      Object.defineProperty(process.stderr, 'isTTY', { value: prevIsTTY, configurable: true });
    }
    expect(chunks.join('')).toBe(LINE_CLEAR);
    expect(s.lineOpen).toBe(false);
  });

  test('falls back to a plain \\n when stderr is not a TTY', () => {
    const s = newProgressState();
    writeProgress(s, 'query_transactions');
    // Force the non-TTY branch explicitly so the test is independent
    // of however bun:test initialises process.stderr.isTTY.
    const prevIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
    try {
      chunks = [];
      clearProgressLine(s);
    } finally {
      Object.defineProperty(process.stderr, 'isTTY', { value: prevIsTTY, configurable: true });
    }
    expect(chunks.join('')).toBe('\n');
    expect(s.lineOpen).toBe(false);
  });

  test('is idempotent — second call writes nothing', () => {
    const s = newProgressState();
    writeProgress(s, 'query_transactions');
    chunks = [];
    clearProgressLine(s);
    const firstCall = chunks.join('');
    chunks = [];
    clearProgressLine(s);
    expect(chunks.join('')).toBe('');
    // First call did emit something; the second is the no-op.
    expect(firstCall.length).toBeGreaterThan(0);
  });
});
