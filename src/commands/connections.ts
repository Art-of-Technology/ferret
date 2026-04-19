// `ferret connections` — list every known connection with status, expiry,
// and last sync. Per PRD §4.1, expiry within 7 days is highlighted yellow.

import { defineCommand } from 'citty';
import Table from 'cli-table3';
import { desc } from 'drizzle-orm';
import pc from 'picocolors';
import { getDb } from '../db/client';
import { connections } from '../db/schema';

const DAY_MS = 24 * 60 * 60 * 1000;

function formatExpiryCountdown(expiresAt: Date | null, now: number): string {
  if (!expiresAt) return '-';
  const deltaMs = expiresAt.getTime() - now;
  const days = Math.round(deltaMs / DAY_MS);
  if (deltaMs <= 0) return pc.red(`expired ${Math.abs(days)}d ago`);
  const text = `${days}d (${expiresAt.toISOString().slice(0, 10)})`;
  if (days < 7) return pc.yellow(text);
  return text;
}

function formatLastSync(ts: Date | null, now: number): string {
  if (!ts) return pc.dim('never');
  const deltaMs = now - ts.getTime();
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatStatus(status: string): string {
  switch (status) {
    case 'active':
      return pc.green(status);
    case 'expired':
      return pc.red(status);
    case 'revoked':
      return pc.dim(status);
    case 'needs_reauth':
      return pc.yellow(status);
    default:
      return status;
  }
}

export default defineCommand({
  meta: { name: 'connections', description: 'List bank connections' },
  run() {
    const { db } = getDb();
    const rows = db.select().from(connections).orderBy(desc(connections.createdAt)).all();

    if (rows.length === 0) {
      process.stdout.write(pc.dim('No connections. Run `ferret link` to add one.\n'));
      return;
    }

    const table = new Table({
      head: ['ID', 'Provider', 'Status', 'Expires', 'Last sync'],
      style: { head: ['bold'], border: [] },
    });

    const now = Date.now();
    for (const r of rows) {
      table.push([
        r.id,
        r.providerName,
        formatStatus(r.status),
        formatExpiryCountdown(r.expiresAt, now),
        formatLastSync(r.lastSyncedAt, now),
      ]);
    }

    process.stdout.write(`${table.toString()}\n`);
  },
});
