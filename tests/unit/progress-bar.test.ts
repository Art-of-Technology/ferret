import { expect, test } from 'bun:test';
import { renderProgressBar } from '../../src/lib/progress-bar';

const FILLED = '\u2588';
const EMPTY = '\u2591';

test('0% renders as fully empty', () => {
  expect(renderProgressBar(0, 10)).toBe(EMPTY.repeat(10));
});

test('50% renders as half filled', () => {
  const bar = renderProgressBar(50, 10);
  expect(bar.length).toBe(10);
  expect(bar).toBe(`${FILLED.repeat(5)}${EMPTY.repeat(5)}`);
});

test('100% renders as fully filled', () => {
  expect(renderProgressBar(100, 10)).toBe(FILLED.repeat(10));
});

test('over 100% (124%) clamps the visual fill to width', () => {
  const bar = renderProgressBar(124, 10);
  expect(bar.length).toBe(10);
  expect(bar).toBe(FILLED.repeat(10));
});

test('default width is 12', () => {
  expect(renderProgressBar(0).length).toBe(12);
  expect(renderProgressBar(100).length).toBe(12);
});

test('tiny non-zero percent still shows at least one filled cell', () => {
  const bar = renderProgressBar(1, 10);
  expect(bar.startsWith(FILLED)).toBe(true);
});
