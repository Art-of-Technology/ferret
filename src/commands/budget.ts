// `ferret budget` — set / list / track / export monthly budgets per
// PRD §4.6 and §14.A. Output style is intentionally close to the PRD
// example so the eyeballed view stays familiar.

import { defineCommand } from 'citty';
import pc from 'picocolors';
import {
  type BudgetWithProgress,
  type MonthlyBudgetView,
  defaultCurrency,
  exportBudgets,
  getCurrentMonthBudgets,
  getHistoricalBudgets,
  monthLabel,
  removeBudget,
  setBudget,
} from '../db/queries/budgets';
import { appendAuditEvent } from '../lib/audit';
import { ValidationError } from '../lib/errors';
import { renderProgressBar } from '../lib/progress-bar';

const BAR_WIDTH = 10;

const CURRENCY_SYMBOLS: Record<string, string> = {
  GBP: '\u00a3',
  USD: '$',
  EUR: '\u20ac',
};

function symbolFor(currency: string): string {
  return CURRENCY_SYMBOLS[currency.toUpperCase()] ?? `${currency} `;
}

function fmtMoney(amount: number, currency: string): string {
  return `${symbolFor(currency)}${Math.round(amount).toLocaleString('en-GB')}`;
}

// Width measured in Unicode code points rather than UTF-16 code units so
// surrogate-pair glyphs (e.g. emoji currency markers) don't throw the column
// alignment off. This is still not grapheme-cluster correct, but matches
// what a fixed-width terminal sees for the symbols we currently support
// (£/$/€ are all single code points).
function visualLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function pad(s: string, n: number): string {
  const len = visualLength(s);
  return len >= n ? s : s + ' '.repeat(n - len);
}

function parseAmount(raw: unknown): number {
  let n: number;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    n = raw;
  } else {
    n = Number.parseFloat(String(raw));
    if (!Number.isFinite(n)) {
      throw new ValidationError(`Amount must be a number, got: ${String(raw)}`);
    }
  }
  // Reject zero / negative early: budgets are always positive monthly limits.
  // The downstream setBudget check would also catch this, but the message
  // is more useful here at the input boundary.
  if (n <= 0) {
    throw new ValidationError(`Amount must be greater than 0, got: ${n}`);
  }
  return n;
}

function renderCurrentMonthHeader(view: BudgetWithProgress[], now: Date): string {
  // Use any of the rows for elapsed/total days, or compute from now if empty.
  let daysElapsed: number;
  let totalDays: number;
  const first = view[0];
  if (first) {
    daysElapsed = first.daysElapsed;
    totalDays = first.totalDaysInMonth;
  } else {
    totalDays = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    daysElapsed = Math.max(1, Math.min(totalDays, now.getUTCDate()));
  }
  const elapsedPct = Math.round((daysElapsed / totalDays) * 100);
  return `${monthLabel(now)} (day ${daysElapsed}/${totalDays}, ${elapsedPct}% elapsed)`;
}

function renderBudgetRow(b: BudgetWithProgress): string {
  const bar = renderProgressBar(Math.min(110, b.percent), BAR_WIDTH);
  const spentStr = fmtMoney(b.spent, b.currency);
  const limitStr = fmtMoney(b.monthlyAmount, b.currency);
  const pctStr = `${Math.round(b.percent)}%`;

  let status: string;
  if (b.percent >= 100) {
    status = `${pc.red('OVER BUDGET')} \uD83D\uDEA8`;
  } else if (b.projected > b.monthlyAmount) {
    status = `projected ${fmtMoney(b.projected, b.currency)} \uD83D\uDEA8`;
  } else {
    status = 'on pace';
  }

  const moneyCol = `${pad(spentStr, 5)} / ${pad(limitStr, 5)}`;
  return `${pad(b.category, 14)} ${bar}  ${moneyCol}  ${pad(pctStr, 4)} ${status}`;
}

function renderCurrentMonth(view: BudgetWithProgress[], now: Date): string {
  const header = renderCurrentMonthHeader(view, now);
  if (view.length === 0) {
    return `${header}\n\nNo budgets set. Use \`ferret budget set <category> <amount>\`.`;
  }
  const rows = view.map(renderBudgetRow).join('\n');
  return `${header}\n\n${rows}`;
}

function renderHistory(views: MonthlyBudgetView[]): string {
  if (views.length === 0) return 'No history.';
  const blocks: string[] = [];
  for (const v of views) {
    if (v.rows.length === 0) {
      blocks.push(`${v.label}\n  (no budgets)`);
      continue;
    }
    const lines: string[] = [v.label];
    for (const r of v.rows) {
      const bar = renderProgressBar(Math.min(110, r.percent), BAR_WIDTH);
      const spent = fmtMoney(r.spent, r.currency);
      const limit = fmtMoney(r.monthlyAmount, r.currency);
      const pct = `${Math.round(r.percent)}%`;
      const flag = r.percent >= 100 ? pc.red(' OVER') : '';
      lines.push(
        `  ${pad(r.category, 14)} ${bar}  ${pad(spent, 5)} / ${pad(limit, 5)}  ${pad(pct, 4)}${flag}`,
      );
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

export default defineCommand({
  meta: { name: 'budget', description: 'Manage and view monthly budgets' },
  subCommands: {
    set: defineCommand({
      meta: { name: 'set', description: 'Set or update a category budget' },
      args: {
        category: { type: 'positional', description: 'Category', required: true },
        amount: { type: 'positional', description: 'Monthly amount (must be > 0)', required: true },
      },
      run({ args }) {
        const category = String(args.category);
        const amount = parseAmount(args.amount);
        const currency = defaultCurrency();
        const saved = setBudget(category, amount, currency);
        // Per issue #48, budget events log the category only. The amount
        // is deliberately omitted — it is PII-adjacent spending detail.
        appendAuditEvent('budget.set', { category: saved.category });
        process.stdout.write(
          `set budget: ${saved.category} ${fmtMoney(saved.monthlyAmount, saved.currency)} / month\n`,
        );
      },
    }),
    rm: defineCommand({
      meta: { name: 'rm', description: 'Remove a budget' },
      args: {
        category: { type: 'positional', description: 'Category', required: true },
      },
      run({ args }) {
        const category = String(args.category);
        const removed = removeBudget(category);
        if (!removed) {
          throw new ValidationError(`No budget set for category: ${category}`);
        }
        appendAuditEvent('budget.removed', { category });
        process.stdout.write(`removed budget: ${category}\n`);
      },
    }),
    history: defineCommand({
      meta: { name: 'history', description: 'Month-over-month view' },
      args: {
        months: { type: 'string', description: 'Number of months back (default 6)' },
      },
      run({ args }) {
        const raw = args.months ? Number.parseInt(String(args.months), 10) : 6;
        if (!Number.isFinite(raw) || raw <= 0) {
          throw new ValidationError(`--months must be a positive integer, got: ${args.months}`);
        }
        const views = getHistoricalBudgets(raw);
        process.stdout.write(`${renderHistory(views)}\n`);
      },
    }),
    export: defineCommand({
      meta: { name: 'export', description: 'Export budgets as JSON' },
      run() {
        const rows = exportBudgets();
        // Always emit valid JSON, even when zero budgets are set. An empty
        // array serialises to "[]" which is what import-side consumers
        // expect (and is what JSON.stringify already produces for []), so
        // the explicit branch is just for clarity / future maintainers.
        const payload = rows.length === 0 ? '[]' : JSON.stringify(rows, null, 2);
        process.stdout.write(`${payload}\n`);
      },
    }),
  },
  // citty 0.1.6 invokes the parent `run` even after a subcommand has run, so
  // we have to detect that case and bail. The subcommand name (if any) shows
  // up as the first positional in `rawArgs`.
  run({ rawArgs }) {
    const SUBCOMMANDS = new Set(['set', 'rm', 'history', 'export']);
    const first = rawArgs.find((a) => !a.startsWith('-'));
    if (first && SUBCOMMANDS.has(first)) return;
    const now = new Date();
    const view = getCurrentMonthBudgets(now);
    process.stdout.write(`${renderCurrentMonth(view, now)}\n`);
  },
});
