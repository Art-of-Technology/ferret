// Loads `~/.ferret/.env` into `process.env` at CLI startup.
//
// PRD §9.1 / THREAT_MODEL.md document `~/.ferret/.env` as an accepted location
// for TRUELAYER_CLIENT_*, ANTHROPIC_API_KEY and FERRET_OAUTH_PORT, but Bun's
// implicit `.env` loader only reads from cwd — not the per-user ferret dir.
// This helper bridges that gap so values written by `ferret setup` are visible
// to subsequent runs no matter where the user invokes ferret from.
//
// Values already present in `process.env` (shell export, CI secret, etc.) win
// over the file — the file is a fallback, not an override, so users can
// temporarily point at a different credential without editing the file.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function envFilePath(): string {
  return join(process.env.HOME ?? homedir(), '.ferret', '.env');
}

export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = value;
  }
  return out;
}

export function loadFerretEnv(path: string = envFilePath()): void {
  if (!existsSync(path)) return;
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    return;
  }
  const parsed = parseEnvFile(content);
  for (const [k, v] of Object.entries(parsed)) {
    if (v.length === 0) continue;
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
