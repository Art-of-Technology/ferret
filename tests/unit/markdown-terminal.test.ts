import { describe, expect, test } from 'bun:test';
import pc from 'picocolors';
import { renderMarkdown } from '../../src/lib/markdown-terminal';

// Strip ANSI escape sequences so assertions on the transformed structure
// (bullets, headers, currency glyphs) don't depend on color mode. The
// ESC byte (0x1B) is built from char code to satisfy biome's
// no-control-characters rule. The pattern accepts multi-parameter SGR
// sequences (e.g. `ESC[1;33m`) as well as the single-parameter codes
// picocolors currently emits, so the helper stays robust if the
// color library ever switches encoding.
const ESC = String.fromCharCode(0x1b);
const ANSI_RE = new RegExp(`${ESC}\\[[\\d;]+m`, 'g');
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

// Whether the shared picocolors instance is emitting ANSI codes in
// this test process. bun:test runs with no TTY by default, so color
// assertions only run when something upstream (FORCE_COLOR, etc.) has
// flipped it on. Structural assertions work in both modes.
const COLORS_ON = pc.isColorSupported;

/**
 * Assert that `substring` appears in `out` and — when colors are
 * enabled — is preceded by `ansiOpen`. When colors are disabled, the
 * ANSI portion is implicitly absent, so we only verify the visible
 * text survived the transform. Keeps the suite portable across
 * color-on and color-off environments without leaning on env mutation.
 */
function expectStyled(out: string, ansiOpen: string, substring: string): void {
  expect(stripAnsi(out)).toContain(substring);
  if (COLORS_ON) {
    expect(out).toContain(`${ansiOpen}${substring}`);
  }
}

describe('renderMarkdown', () => {
  test('strips **bold** markers from the visible output', () => {
    const out = renderMarkdown('**Eating Out — March 2026:**');
    expect(stripAnsi(out)).toBe('Eating Out — March 2026:');
    expect(out).not.toContain('**');
  });

  test('strips __bold__ markers too', () => {
    const out = renderMarkdown('__bold word__');
    expect(stripAnsi(out)).toBe('bold word');
  });

  test('renders multiple bolds on one line independently', () => {
    const out = renderMarkdown('**one** and **two**');
    expect(stripAnsi(out)).toBe('one and two');
  });

  test('converts leading dash bullets to •', () => {
    const out = renderMarkdown('- Spent: £411.85\n- Budget: £350');
    const stripped = stripAnsi(out);
    expect(stripped).toContain('• Spent');
    expect(stripped).toContain('• Budget');
    expect(stripped).not.toMatch(/^-\s/m);
  });

  test('converts leading asterisk bullets to •', () => {
    const out = renderMarkdown('* first\n* second');
    const stripped = stripAnsi(out);
    expect(stripped).toContain('• first');
    expect(stripped).toContain('• second');
  });

  test('preserves indentation on indented bullets', () => {
    const out = renderMarkdown('  - nested item');
    expect(stripAnsi(out)).toBe('  • nested item');
  });

  test('renders ATX headings without the # prefix', () => {
    expect(stripAnsi(renderMarkdown('# heading'))).toBe('heading');
    expect(stripAnsi(renderMarkdown('## heading'))).toBe('heading');
    expect(stripAnsi(renderMarkdown('### heading'))).toBe('heading');
  });

  test('renders inline code without backticks', () => {
    const out = renderMarkdown('use `ferret init` to start');
    expect(stripAnsi(out)).toBe('use ferret init to start');
    expect(out).not.toContain('`');
  });

  test('preserves currency amounts verbatim in visible text', () => {
    const amounts = ['£411.85', '£350', '£1,234.56', '$99', '€7.50'];
    for (const amt of amounts) {
      expect(stripAnsi(renderMarkdown(amt))).toBe(amt);
    }
  });

  test('handles a full Claude-style answer end to end', () => {
    const input = [
      '**Eating Out — March 2026:**',
      '- Spent: **£411.85** across 3 transactions',
      '- Budget: **£350/month**',
      '- **Overspent by £61.85 (~18% over)**',
      '',
      'Driver: the £390.65 at 34 Mayfair on 14 Mar blew the budget.',
    ].join('\n');

    const out = stripAnsi(renderMarkdown(input));
    expect(out).not.toContain('**');
    expect(out).toContain('• Spent: £411.85 across 3 transactions');
    expect(out).toContain('• Budget: £350/month');
    expect(out).toContain('• Overspent by £61.85 (~18% over)');
    expect(out).toContain('Driver: the £390.65 at 34 Mayfair');
  });

  test('passes through plain text unchanged', () => {
    const plain = 'You have no accounts yet.';
    expect(stripAnsi(renderMarkdown(plain))).toBe(plain);
  });

  // Standard SGR open-codes emitted by picocolors. Tests that rely on
  // these only assert them when colors are enabled (see expectStyled).
  const RED_OPEN = `${ESC}[31m`;
  const YELLOW_OPEN = `${ESC}[33m`;
  const DIM_OPEN = `${ESC}[2m`;

  describe('warning styling (red)', () => {
    test('colors "£47 over" entirely red, suppressing currency yellow inside', () => {
      const out = renderMarkdown('£47 over your £200 budget.');
      // "£47 over" should be red; "£200" stays yellow.
      expectStyled(out, RED_OPEN, '£47 over');
      expectStyled(out, YELLOW_OPEN, '£200');
      // Stripped text preserves original content verbatim.
      expect(stripAnsi(out)).toBe('£47 over your £200 budget.');
    });

    test('colors "Overspent by £61.85" in red', () => {
      const out = renderMarkdown('Overspent by £61.85 this month');
      expectStyled(out, RED_OPEN, 'Overspent by £61.85');
      expect(stripAnsi(out)).toBe('Overspent by £61.85 this month');
    });

    test('colors "over by £47" in red', () => {
      const out = renderMarkdown('you went over by £47.');
      expectStyled(out, RED_OPEN, 'over by £47');
    });

    test('colors "(~18% over)" parenthetical in red', () => {
      const out = renderMarkdown('Result: (~18% over) of budget.');
      expectStyled(out, RED_OPEN, '(~18% over)');
    });

    test('colors bare "Overspent" keyword in red', () => {
      const out = renderMarkdown('Overspent this month.');
      expectStyled(out, RED_OPEN, 'Overspent');
    });
  });

  describe('dim parentheticals', () => {
    test('dims a "(N visits)" parenthetical', () => {
      const out = renderMarkdown('Dishoom £58 (2 visits)');
      expectStyled(out, DIM_OPEN, '(2 visits)');
    });

    test('leaves parentheticals containing currency un-dimmed', () => {
      const out = renderMarkdown('bought (a £10 coffee) today');
      // If colors are on, verify no dim wrap opened right at "(a" —
      // that would mean we incorrectly dimmed a span with currency.
      if (COLORS_ON) {
        expect(out).not.toContain(`${DIM_OPEN}(a`);
      }
      expectStyled(out, YELLOW_OPEN, '£10');
    });
  });

  describe('dim plain prose', () => {
    // picocolors emits `\x1b[90m…\x1b[39m` for pc.gray.
    const GRAY_OPEN = `${ESC}[90m`;

    test('wraps plain-text prose in gray', () => {
      const out = renderMarkdown('You have no accounts yet.');
      expectStyled(out, GRAY_OPEN, 'You have no accounts yet.');
    });

    test('keeps currency vivid (yellow) rather than wrapping it in gray', () => {
      // Currency spans open inside the surrounding gray run and
      // close back to gray — so `£247` appears with yellow open,
      // not gray.
      const out = renderMarkdown('You spent £247 on dining');
      if (COLORS_ON) {
        expect(out).toContain(`${YELLOW_OPEN}£247`);
        expect(out).toContain(`${GRAY_OPEN}You spent `);
      }
    });

    test('does not double-wrap content inside a bold span', () => {
      // Text inside `**…**` becomes a bold span; wrapping its inner
      // content in gray would fight the bold style. The check: no
      // literal `GRAY_OPEN + inner-bold-text` sequence appears.
      const out = renderMarkdown('lead text **Dishoom** trail text');
      if (COLORS_ON) {
        expect(out).not.toContain(`${GRAY_OPEN}Dishoom`);
        expect(out).toContain(`${ESC}[1mDishoom`);
        expect(out).toContain(`${GRAY_OPEN}lead text `);
      }
    });

    test('stripped output is byte-identical to the logical answer', () => {
      // Dim-pass adds ANSI codes but no visible characters, so
      // stripping ANSI recovers the original text for inputs without
      // markdown structural markers.
      const logical = 'You spent £42 on Eating Out. (2 visits)';
      expect(stripAnsi(renderMarkdown(logical))).toBe(logical);
    });
  });
});
