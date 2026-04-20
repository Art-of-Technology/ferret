// Minimal markdown → ANSI renderer for `ferret ask`. Claude emits
// GitHub-flavored markdown (**bold**, `-` bullets, headings, inline
// code) which shows up as raw syntax if we pipe it straight to stdout.
// This module converts the handful of constructs Claude actually uses
// into ANSI escape codes via picocolors, so terminal output looks like
// the demo on the marketing site instead of unparsed markdown.
//
// Styling palette (mirrors the marketing-site mock):
//   • currency amounts (£/$/€...)    → yellow
//   • overspend warnings ("£47 over",
//     "overspent by £X", "(~18% over)",
//     bare "Overspent" / "Exceeded")  → red (takes precedence over yellow)
//   • parentheticals w/o currency
//     (e.g. "(2 visits)")             → dim
//   • **bold**, __bold__, headings   → bold
//   • `inline code`                  → cyan
//   • `-`/`*` bullets                → `•`
//
// Not a full markdown parser: links, images, tables, code fences, and
// block quotes are passed through unchanged because Claude rarely
// emits them in ask-mode answers. Warning spans are stashed behind
// placeholders before the other passes run so yellow currency styling
// doesn't leak inside the red warning segments (ANSI close codes don't
// restore a surrounding color, so naive nesting produces half-red
// spans).

import pc from 'picocolors';

// Sentinel character used to bracket placeholder tokens. The section
// sign is extremely rare in ordinary user-facing text and printable
// ASCII, so it avoids both the "control character in regex" lint rule
// and any realistic risk of colliding with legitimate content.
const SENTINEL = '\u00A7';

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

  // ATX headings on their own line. We only support H1-H3 because Claude
  // rarely goes deeper and treating deeper levels the same as H3 adds
  // noise. Render as bold — ANSI has no dedicated "heading" style.
  out = out.replace(/^\s*#{1,3}\s+(.+?)\s*$/gm, (_, inner: string) => pc.bold(inner));

  // Bold: **text** and __text__. Lazy match so adjacent bolds on one
  // line (`**a** and **b**`) render as two separate bolds rather than
  // one span covering everything between the first and last pair.
  out = out.replace(/\*\*(.+?)\*\*/gs, (_, inner: string) => pc.bold(inner));
  out = out.replace(/__(.+?)__/g, (_, inner: string) => pc.bold(inner));

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

  return out;
}
