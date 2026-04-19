// ASCII progress bar renderer used by `ferret budget`. Style matches the
// PRD §14.A example (filled = U+2588 FULL BLOCK, empty = U+2591 LIGHT SHADE).
//
// Behaviour:
//   - percent is clamped to [0, 100] for the *visual* fill so a 124%
//     bar still fits in `width` cells (the over-budget state is signalled
//     elsewhere by the OVER BUDGET label).
//   - filled cells = round(width * percent/100), but never less than 1
//     when percent > 0 (so 1% renders as a single block, not empty).
//   - width is the total cell count.

const FILLED = '\u2588'; // full block
const EMPTY = '\u2591'; // light shade

export function renderProgressBar(percent: number, width = 12): string {
  if (!Number.isFinite(percent)) return EMPTY.repeat(width);
  if (width <= 0) return '';

  const visualPct = Math.max(0, Math.min(100, percent));
  let filled = Math.round((width * visualPct) / 100);
  if (visualPct > 0 && filled === 0) filled = 1;
  if (visualPct >= 100) filled = width;
  const empty = width - filled;
  return `${FILLED.repeat(filled)}${EMPTY.repeat(empty)}`;
}
