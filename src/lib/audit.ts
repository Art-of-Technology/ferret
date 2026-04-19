// Append-only local audit log for security-significant events (PRD §9.3 +
// epic #36 — ISO 27001 A.12 / SOC 2 CC7).
//
// Contract:
//   - File lives at `${FERRET_HOME}/audit.log`, JSONL (one event per line).
//   - Permissions: 0600 (owner read/write only). Preserved across rotation.
//   - Atomic append: open fd with O_APPEND|O_CREAT|O_WRONLY, single writeSync
//     of `<json>\n`, close. No buffering, no partial lines on crash.
//   - Rotation: when the file reaches ROTATE_BYTES it is renamed to
//     `audit.log.1` (single rollover). A fresh 0600 file is created on the
//     next append.
//   - Redaction: every field whose key matches SECRET_KEY_PATTERN is replaced
//     with '[REDACTED]' before serialisation, recursively. This is the
//     last-line safety net — callers should still avoid passing raw secrets.
//
// The module MUST NOT pull in dependencies beyond node built-ins. No
// dynamic imports, no side-effect imports — tests rely on this file being
// cheap to import.

import {
  chmodSync,
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { getFerretHome } from '../db/client';

/** Event names emitted by Ferret. Keep in sync with issue #48. */
export type AuditEventType =
  | 'connection.linked'
  | 'connection.unlinked'
  | 'connection.reauth_marked'
  | 'config.changed'
  | 'rule.added'
  | 'rule.removed'
  | 'budget.set'
  | 'budget.removed'
  | 'sync.started'
  | 'sync.completed'
  | 'sync.failed'
  | 'import.completed'
  | 'ask.invoked';

/** 5 MiB rollover threshold per issue #48. */
export const ROTATE_BYTES = 5 * 1024 * 1024;

/**
 * Keys whose values are suppressed before serialisation. Match against the
 * key name only (case-insensitive) — we never inspect values, since a value
 * that *looks* like a token (long opaque string) may legitimately be e.g. a
 * connection id. Callers must label their secrets with one of these names.
 */
const SECRET_KEY_PATTERN = /(token|secret|api_?key|password|refresh|authorization)/i;

/** Sentinel the redactor substitutes in for suppressed values. */
export const REDACTED = '[REDACTED]';

/** Absolute path to the current audit log. */
export function getAuditLogPath(): string {
  return join(getFerretHome(), 'audit.log');
}

/** Absolute path to the rotated (previous) audit log, if any. */
export function getAuditLogRotatedPath(): string {
  return `${getAuditLogPath()}.1`;
}

/**
 * Walk an arbitrary object tree and replace any value whose key matches
 * {@link SECRET_KEY_PATTERN} with {@link REDACTED}. Returns a new object —
 * the input is not mutated. Non-plain-object values (arrays, Dates,
 * primitives) are passed through unchanged.
 *
 * Limited depth (16) to guarantee termination on self-referential inputs;
 * audit payloads are shallow in practice.
 */
export function redactSecrets(input: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 16) return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (SECRET_KEY_PATTERN.test(k)) {
      out[k] = REDACTED;
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      out[k] = redactSecrets(v as Record<string, unknown>, depth + 1);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Rotate `path` to `${path}.1`, overwriting any previous rotated file. Used
 * both by the inline "check size on the same fd" path in
 * {@link appendAuditEvent} and by the test-only {@link rotateIfNeeded} entry
 * point. Best-effort — errors swallowed so a rotation failure never blocks
 * a caller.
 */
function rotateNow(path: string): void {
  try {
    const rotated = `${path}.1`;
    renameSync(path, rotated);
    // chmod the rotated file explicitly in case the rename lands on a FS
    // that reset the mode bits. Swallow chmod errors — on Windows this
    // isn't meaningful.
    try {
      chmodSync(rotated, 0o600);
    } catch {
      /* best effort */
    }
  } catch {
    // rename fails if the file doesn't exist yet — that's the common
    // first-call case. Nothing to do.
  }
}

/**
 * Size check that closes the TOCTOU window: we inspect the file via the fd
 * we've just opened, rather than `statSync`ing the path a moment before
 * opening it. Returns `true` if the caller should rotate before writing.
 */
function shouldRotateFd(fd: number): boolean {
  try {
    return fstatSync(fd).size >= ROTATE_BYTES;
  } catch {
    return false;
  }
}

/** Ensure `${FERRET_HOME}` exists with 0700 before touching the log file. */
function ensureHome(): void {
  const home = getFerretHome();
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
  }
}

/**
 * Append a single audit event. The wire shape is:
 *
 *   {"ts":"<ISO>","type":"<event>", ...redactedFields}
 *
 * Fields named like secrets (see {@link SECRET_KEY_PATTERN}) are replaced
 * with {@link REDACTED} before the line is written.
 *
 * Never throws — audit logging must not interrupt the primary command
 * flow. Any failure is swallowed silently (by design; observability of
 * the audit pipeline itself is out of scope for v0.1).
 */
export function appendAuditEvent(type: AuditEventType, fields: Record<string, unknown> = {}): void {
  try {
    ensureHome();
    const path = getAuditLogPath();

    const payload = {
      ts: new Date().toISOString(),
      type,
      ...redactSecrets(fields),
    };

    // JSON.stringify collapses Date → ISO string naturally; the payload
    // cannot contain newlines in unescaped form because stringify escapes
    // them, so the `\n` terminator is unambiguous.
    const line = `${JSON.stringify(payload)}\n`;

    // Open first, then size-check via fstatSync on the fd — this closes the
    // TOCTOU window where another writer could grow the file between a
    // path-level statSync and the open that followed it. If we need to
    // rotate we close, rename, and reopen a fresh 0600 file.
    // eslint-disable-next-line no-bitwise -- standard POSIX flag combination
    const openFlags = fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY;
    let fd = openSync(path, openFlags, 0o600);
    if (shouldRotateFd(fd)) {
      closeSync(fd);
      rotateNow(path);
      fd = openSync(path, openFlags, 0o600);
    }
    try {
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }

    // On some filesystems O_CREAT honours the umask, so the file may end
    // up 0644. chmod explicitly to guarantee 0600. Ignore failures.
    try {
      chmodSync(path, 0o600);
    } catch {
      /* best effort — e.g. Windows */
    }
  } catch {
    // Swallow: audit logging must never break a command.
  }
}

/**
 * Read the last `n` lines of the audit log. Returns an empty array if the
 * file does not exist. Lines that fail to parse as JSON are skipped (they
 * shouldn't happen — we only ever append well-formed lines — but a partial
 * write from a crash shouldn't poison the tail reader).
 *
 * Exposed primarily for tests and a future `ferret audit` command.
 */
export function tailAuditLog(n: number): Array<Record<string, unknown>> {
  const path = getAuditLogPath();
  if (!existsSync(path)) return [];
  const raw = readTailBytes(path);
  const lines = raw.split('\n').filter((l) => l.length > 0);
  const tail = n >= lines.length ? lines : lines.slice(lines.length - n);
  const out: Array<Record<string, unknown>> = [];
  for (const l of tail) {
    try {
      out.push(JSON.parse(l) as Record<string, unknown>);
    } catch {
      // ignore malformed line
    }
  }
  return out;
}

/**
 * Read either the whole file (if under {@link TAIL_WHOLE_FILE_LIMIT}) or the
 * last {@link TAIL_WINDOW_BYTES} bytes. For the windowed path we drop the
 * first line of what we read in case we sliced mid-line — the caller only
 * cares about the tail, not the head of the window. This keeps memory and
 * wall-clock flat once the log is in the hundreds-of-KiB range (100k lines
 * is ~18 MiB at typical shape — reading the whole thing spikes ~50ms).
 */
function readTailBytes(path: string): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, fsConstants.O_RDONLY);
    const size = fstatSync(fd).size;
    if (size <= TAIL_WHOLE_FILE_LIMIT) {
      closeSync(fd);
      fd = null;
      return readFileSync(path, 'utf-8');
    }
    const window = Math.min(TAIL_WINDOW_BYTES, size);
    const buf = Buffer.alloc(window);
    readSync(fd, buf, 0, window, size - window);
    const text = buf.toString('utf-8');
    // If we didn't start at byte 0, the first line is almost certainly a
    // partial — drop it.
    const firstNewline = text.indexOf('\n');
    return firstNewline === -1 ? '' : text.slice(firstNewline + 1);
  } catch {
    return '';
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Threshold below which `tailAuditLog` just reads the whole file. */
const TAIL_WHOLE_FILE_LIMIT = 1 * 1024 * 1024;
/** Window size used when tailing a file larger than {@link TAIL_WHOLE_FILE_LIMIT}. */
const TAIL_WINDOW_BYTES = 64 * 1024;

/**
 * Manually invoke the rotation check. Exposed for tests; the normal path
 * rotates lazily inside {@link appendAuditEvent}. Uses the same fd-based
 * size check as the normal path so the TOCTOU semantics are identical.
 */
export function rotateIfNeeded(): void {
  const path = getAuditLogPath();
  if (!existsSync(path)) return;
  let fd: number | null = null;
  try {
    fd = openSync(path, fsConstants.O_RDONLY);
    if (!shouldRotateFd(fd)) return;
  } catch {
    return;
  } finally {
    if (fd !== null) closeSync(fd);
  }
  rotateNow(path);
}
