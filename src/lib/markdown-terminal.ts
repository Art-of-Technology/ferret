// Minimal markdown → ANSI renderer for `ferret ask`. Claude emits
// GitHub-flavored markdown (**bold**, `-` bullets, headings, inline
// code) which shows up as raw syntax if we pipe it straight to stdout.
// This module converts the handful of constructs Claude actually uses
// into ANSI escape codes via picocolors, so terminal output looks like
// the demo on the marketing site instead of unparsed markdown.
//
// Styling palette (mirrors the marketing-site mock):
//   • plain prose (not inside any markup)  → gray/dim
//   • currency amounts (£/$/€...)           → yellow (vivid)
//   • overspend warnings ("£47 over",
//     "overspent by £X", "(~18% over)",
//     bare "Overspent" / "Exceeded")        → red (takes precedence)
//   • parentheticals w/o currency
//     (e.g. "(2 visits)")                   → dim
//   • **bold**, __bold__, headings          → bold (vivid)
//   • `inline code`                         → cyan
//   • `-`/`*` bullets                       → `•`
//
// Dimming the prose is done in a final post-processing pass that
// walks the already-colored output, tracks SGR nesting depth, and
// wraps depth-0 plain runs in `pc.gray`. That way nested accent
// spans (yellow, red, bold) keep their vivid styling and the text
// surrounding them fades to dim without fighting ANSI nesting
// semantics — close codes don't restore an outer color, so naive
// `pc.gray(entire-string)` would lose gray inside every accent.
//
// Not a full markdown parser: links, images, tables, code fences, and
// block quotes are passed through unchanged because Claude rarely
// emits them in ask-mode answers. Warning spans are stashed behind
// placeholders before the other passes run so yellow currency styling
// doesn't leak inside the red warning segments.

import pc from 'picocolors';

// Sentinel character used to bracket placeholder tokens. U+E000 sits
// in the Unicode Private Use Area — it has no assigned meaning and
// will never appear in ordinary user-facing text (merchant names,
// currency-formatted amounts, etc.), so it avoids both the
// "control character in regex" lint rule and any realistic risk of
// colliding with legitimate content.
const SENTINEL = '\uE000';

/**
 * Transform markdown-flavored text into ANSI-colored output. Input is
 * expected to be the full assistant answer; rendering is done as a
 * batch of text-level regex passes rather than a streaming tokenizer,
 * because `ferret ask` buffers the whole answer before display.
 *
 * Order matters: earlier passes wrap matches in ANSI codes that later
 * passes must not accidentally re-match. Warning spans are extracted
 * first (before any coloring) so they can be re-injected atomically
 * at the end without their contents being re-styled.
 */
export function renderMarkdown(input: string): string {
  let out = input;
  const warnings: string[] = [];
  const stash = (match: string): string => {
    warnings.push(match);
    return `${SENTINEL}W${warnings.length - 1}${SENTINEL}`;
  };

  // Warning phrases — stash behind placeholders so later currency /
  // bold passes don't style the pieces inside. Patterns are ordered
  // longest-match-first so e.g. "overspent by £61.85" wins over the
  // bare "£61.85" currency pattern that would otherwise swallow the
  // amount first.
  const WARN_PATTERNS: RegExp[] = [
    // "overspent by £61.85", "exceeded by £61.85"
    /\b(?:overspent|exceeded)\s+by\s+[£$€]\d{1,3}(?:,\d{3})*(?:\.\d+)?/gi,
    // "£47 over"
    /[£$€]\d{1,3}(?:,\d{3})*(?:\.\d+)?\s+over\b/g,
    // "over £47" / "over by £47"
    /\bover\s+(?:by\s+)?[£$€]\d{1,3}(?:,\d{3})*(?:\.\d+)?/gi,
    // "(~18% over)" — parenthetical warning
    /\(~?\d+(?:\.\d+)?%\s+over\)/g,
    // bare "Overspent" / "Exceeded" as a standalone keyword
    /\b(?:Overspent|Exceeded)\b/g,
  ];
  for (const re of WARN_PATTERNS) {
    out = out.replace(re, stash);
  }

  // ATX headings on their own line. Support H1-H6 so deeper levels
  // (e.g. `#### subhead`) don't leak raw `#` prefixes when Claude
  // uses them. ANSI has no dedicated heading styles, so every level
  // renders as bold. The trailing whitespace class is restricted to
  // spaces/tabs — `\s` would also match the newline that separates
  // this line from the next, which would swallow the blank line
  // after a heading and collapse paragraph breaks.
  out = out.replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*$/gm, (_, inner: string) => pc.bold(inner));

  // Bold: **text** and __text__. Inner content excludes newlines and
  // asterisks — multi-line bold isn't something Claude emits, and the
  // explicit character class makes the match linear (no backtracking),
  // avoiding the ReDoS shape that `.+?` with the `s` flag would have.
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_, inner: string) => pc.bold(inner));
  out = out.replace(/__([^_\n]+)__/g, (_, inner: string) => pc.bold(inner));

  // Inline code: single backticks. Cyan so it doesn't fight the bold
  // style already used for emphasis.
  out = out.replace(/`([^`\n]+)`/g, (_, inner: string) => pc.cyan(inner));

  // Bullet lists: leading `- ` or `* ` (with optional indent) → `• `.
  out = out.replace(/^(\s*)[-*]\s+/gm, '$1• ');

  // Currency amounts: £, $, € followed by a number. Yellow so numbers
  // pop for quick scanning. Runs after bold so amounts inside bold
  // spans inherit both styles (ANSI codes nest harmlessly because
  // yellow's close — `\x1b[39m` — restores fg color only, leaving
  // bold attribute intact).
  out = out.replace(/([£$€])(\d{1,3}(?:,\d{3})*(?:\.\d+)?)/g, (_, sym: string, num: string) =>
    pc.yellow(`${sym}${num}`),
  );

  // Dim parentheticals that are purely secondary metadata like
  // "(2 visits)", "(3 transactions)", "(today)". Skip any parens that
  // still contain a currency glyph (kept vivid for numeric scanning)
  // or a placeholder marker (warnings already styled). This runs after
  // the currency pass, so we detect ANSI-wrapped £/€/$ spans by
  // inspecting for the raw glyph in the captured inner text.
  out = out.replace(/\(([^)\n]+)\)/g, (match, inner: string) => {
    if (/[£$€]/.test(inner) || inner.includes(SENTINEL)) return match;
    return pc.dim(match);
  });

  // Re-inject warnings in red LAST. Wrapping the full phrase (not the
  // amount only) matches the marketing mock, where "£47 over" is red
  // in its entirety rather than splitting into yellow+red.
  const warnRe = new RegExp(`${SENTINEL}W(\\d+)${SENTINEL}`, 'g');
  out = out.replace(warnRe, (_, i: string) => pc.red(warnings[Number.parseInt(i, 10)] ?? ''));

  // Final pass: dim any plain (non-styled) prose so the output
  // matches the marketing demo's gray-with-vivid-accents look.
  return dimPlainRuns(out);
}

// ANSI SGR close codes actually emitted by picocolors — `22` closes
// bold and dim together, `29` closes strikethrough, `39` resets the
// foreground color, `49` resets the background. Italic (`23`) and
// underline (`24`) are not emitted by picocolors in this codebase, so
// we deliberately don't list them here; if a future dependency starts
// emitting them we'll want explicit handling rather than silently
// decrementing depth.
const SGR_CLOSE_CODES = new Set(['22', '29', '39', '49']);

/**
 * Wrap depth-0 plain-text runs in `pc.gray` so that un-styled prose
 * renders dim while accent spans (yellow currency, red warnings,
 * bold headings) keep their vivid styling. Tracks ANSI SGR nesting
 * depth by scanning each `ESC[…m` escape and walking every
 * semicolon-separated parameter: each close parameter decrements
 * depth, each open parameter increments, and `0` (full reset) snaps
 * depth back to zero regardless of stack state. Plain text
 * encountered while depth > 0 is emitted verbatim because it
 * already inherits the surrounding style (e.g. the inside of a
 * bold span).
 */
function dimPlainRuns(s: string): string {
  const ansi = new RegExp(`${String.fromCharCode(0x1b)}\\[([\\d;]+)m`, 'g');
  let result = '';
  let lastIndex = 0;
  let depth = 0;
  const emitPlain = (text: string): void => {
    if (text.length === 0) return;
    result += depth === 0 ? pc.gray(text) : text;
  };
  let match: RegExpExecArray | null = ansi.exec(s);
  while (match !== null) {
    emitPlain(s.slice(lastIndex, match.index));
    result += match[0];
    // Walk every semicolon-separated parameter. picocolors only
    // emits single-parameter codes today, but compound sequences
    // like `ESC[1;33m` (bold + yellow) open TWO styles in one
    // escape — tracking only the leading parameter would under-count
    // depth and cause later close codes to leak styling.
    for (const param of (match[1] ?? '').split(';')) {
      if (param === '0') {
        depth = 0;
      } else if (SGR_CLOSE_CODES.has(param)) {
        depth = Math.max(0, depth - 1);
      } else if (param.length > 0) {
        depth += 1;
      }
    }
    lastIndex = match.index + match[0].length;
    match = ansi.exec(s);
  }
  emitPlain(s.slice(lastIndex));
  return result;
}
