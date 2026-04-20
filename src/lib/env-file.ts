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

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function envFilePath(): string {
  return join(process.env.HOME ?? homedir(), '.ferret', '.env');
}

/**
 * Strip a matching leading/trailing quote pair from a value. Requires
 * at least two characters so a bare `"` or `'` isn't treated as both
 * the opening and closing quote (which would collapse to an empty
 * string and hide a genuinely malformed line). For double-quoted
 * values we expand the standard `\n` / `\t` / `\r` / `\\` / `\"`
 * escape sequences — this matches the behaviour of dotenv-style
 * parsers and lets users persist multi-line secrets as a single
 * line. Single-quoted values are literal per the same convention.
 */
function unquote(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if (first === '"' && last === '"') {
    const inner = value.slice(1, -1);
    return inner.replace(/\\([ntr\\"])/g, (_, ch: string) => {
      if (ch === 'n') return '\n';
      if (ch === 't') return '\t';
      if (ch === 'r') return '\r';
      return ch;
    });
  }
  if (first === "'" && last === "'") {
    return value.slice(1, -1);
  }
  return value;
}

export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = unquote(line.slice(eq + 1).trim());
  }
  return out;
}

/**
 * Read a file's contents, returning the empty string if the file does
 * not exist. Using a single readFileSync + ENOENT catch instead of an
 * existsSync/readFileSync pair closes the TOCTOU window CodeQL flags
 * as `js/file-system-race`: between the check and the open, an
 * attacker with write access to the containing directory could
 * replace the file with a symlink pointing at something sensitive.
 */
export function readFileOrEmpty(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * Upsert a `KEY=value` line into an existing `.env`-style file body,
 * preserving comments, blank lines, and the relative ordering of
 * unrelated entries. Duplicate assignments of the same key are
 * collapsed to a single (replaced) line — the first occurrence wins
 * its original position, and subsequent ones are dropped. Appending a
 * brand-new key inserts a separating blank line if the previous
 * content did not already end with one, and the result is guaranteed
 * to end in a single newline so POSIX tools read the final line
 * correctly.
 */
export function upsertEnvLine(existing: string, key: string, value: string): string {
  const lines = existing.split(/\r?\n/);
  let replaced = false;
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      out.push(line);
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq > 0 && trimmed.slice(0, eq).trim() === key) {
      if (!replaced) {
        out.push(`${key}=${value}`);
        replaced = true;
      }
      // Drop duplicate subsequent assignments.
      continue;
    }
    out.push(line);
  }
  if (!replaced) {
    // Drop trailing blank lines before deciding how much whitespace to
    // insert — without this, a file that already ends in `\n\n` would
    // accumulate an extra blank line each time a new key is appended.
    while (out.length > 0 && out[out.length - 1]?.trim() === '') out.pop();
    if (out.length > 0) out.push('');
    out.push(`${key}=${value}`);
  }
  // Ensure trailing newline for POSIX tools.
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

export function loadFerretEnv(path: string = envFilePath()): void {
  // Single syscall + ENOENT catch instead of existsSync + readFileSync —
  // closes the TOCTOU race (js/file-system-race, CWE-367) and also
  // handles any other transient read error (EACCES, EISDIR, etc.) by
  // silently treating the file as absent. This is a best-effort env
  // bootstrap and must not fail CLI startup.
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
