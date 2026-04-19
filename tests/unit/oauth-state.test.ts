import { describe, expect, test } from 'bun:test';
import { generateState, validateState } from '../../src/services/oauth';

describe('oauth state', () => {
  test('generateState returns a hex string of 2*bytes length', () => {
    const s = generateState(32);
    expect(s).toMatch(/^[0-9a-f]{64}$/);
  });

  test('generateState returns unique values across calls', () => {
    const a = generateState();
    const b = generateState();
    expect(a).not.toBe(b);
  });

  test('validateState accepts the exact same token', () => {
    const s = generateState(16);
    expect(validateState(s, s)).toBe(true);
  });

  test('validateState rejects mismatched tokens', () => {
    const s = generateState(16);
    const wrong = generateState(16);
    expect(validateState(s, wrong)).toBe(false);
  });

  test('validateState rejects null / undefined / empty', () => {
    const s = generateState(16);
    expect(validateState(s, null)).toBe(false);
    expect(validateState(s, undefined)).toBe(false);
    expect(validateState(s, '')).toBe(false);
  });

  test('validateState rejects different-length tokens', () => {
    expect(validateState('aaaa', 'aaaab')).toBe(false);
    expect(validateState('aaaab', 'aaaa')).toBe(false);
  });

  test('validateState rejects tokens that differ by one bit (CSRF guard)', () => {
    expect(validateState('abcdef', 'abcdee')).toBe(false);
  });
});
