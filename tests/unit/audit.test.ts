// Unit tests for the append-only audit log (issue #48).
//
// Each test isolates `$HOME` to a fresh tmpdir so the module's lazy
// `process.env.HOME` lookup (see `src/lib/audit.ts > getAuditLogPath`) reads
// a clean state. The module exposes no mutable singletons, so there's
// nothing to reset between tests beyond the env var.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REDACTED,
  ROTATE_BYTES,
  appendAuditEvent,
  getAuditLogPath,
  getAuditLogRotatedPath,
  redactSecrets,
  rotateIfNeeded,
  tailAuditLog,
} from '../../src/lib/audit';

describe('audit log', () => {
  let originalHome: string | undefined;
  let tmp: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tmp = mkdtempSync(join(tmpdir(), 'ferret-audit-'));
    process.env.HOME = tmp;
  });

  afterEach(() => {
    // `process.env.HOME = undefined` would coerce to the literal string
    // "undefined" (node's env object stringifies assignments), which is worse
    // than leaving the real original value alone. Use `Reflect.deleteProperty`
    // to *un-set* the key when HOME wasn't present before the test.
    if (originalHome === undefined) {
      Reflect.deleteProperty(process.env, 'HOME');
    } else {
      process.env.HOME = originalHome;
    }
  });

  test('appendAuditEvent writes a single JSONL line per event', () => {
    appendAuditEvent('connection.linked', { connection_id: 'abc', provider_id: 'uk-ob-lloyds' });
    appendAuditEvent('connection.unlinked', { connection_id: 'abc' });

    const raw = readFileSync(getAuditLogPath(), 'utf-8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);

    for (const line of lines) {
      // Every line must be valid JSON and must contain no embedded newline.
      expect(line.includes('\n')).toBe(false);
      const parsed = JSON.parse(line);
      expect(typeof parsed.ts).toBe('string');
      expect(new Date(parsed.ts).toString()).not.toBe('Invalid Date');
      expect(typeof parsed.type).toBe('string');
    }

    const first = JSON.parse(lines[0] ?? '');
    expect(first.type).toBe('connection.linked');
    expect(first.connection_id).toBe('abc');
    expect(first.provider_id).toBe('uk-ob-lloyds');
  });

  test('log file is created with 0600 mode', () => {
    appendAuditEvent('config.changed', { key: 'display.show_colors' });
    const st = statSync(getAuditLogPath());
    // Mask the permission bits out of the mode; file-type bits live above 0o777.
    expect(st.mode & 0o777).toBe(0o600);
  });

  test('0600 mode is preserved across subsequent appends', () => {
    appendAuditEvent('config.changed', { key: 'a' });
    const st1 = statSync(getAuditLogPath());
    expect(st1.mode & 0o777).toBe(0o600);

    appendAuditEvent('config.changed', { key: 'b' });
    const st2 = statSync(getAuditLogPath());
    expect(st2.mode & 0o777).toBe(0o600);
  });

  test('rotation moves log to audit.log.1 when it exceeds 5 MiB', () => {
    const path = getAuditLogPath();
    // Pre-seed the file with >ROTATE_BYTES bytes so the next append triggers
    // the rollover. We stuff the bytes directly — building the same size via
    // appendAuditEvent would take thousands of iterations and slow the suite.
    const dir = join(tmp, '.ferret');
    // Need to seed the parent dir first; appendAuditEvent would do this but
    // we're side-stepping it to avoid the appended line counting towards
    // size before the rotation check.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const big = 'x'.repeat(ROTATE_BYTES + 1024);
    writeFileSync(path, big, { mode: 0o600 });

    appendAuditEvent('connection.linked', { connection_id: 'post-rotate' });

    const rotated = getAuditLogRotatedPath();
    expect(existsSync(rotated)).toBe(true);

    // Rotated file keeps the pre-rotation seed; primary log has one fresh
    // event only.
    const primary = readFileSync(path, 'utf-8')
      .split('\n')
      .filter((l) => l.length > 0);
    expect(primary).toHaveLength(1);
    const evt = JSON.parse(primary[0] ?? '');
    expect(evt.connection_id).toBe('post-rotate');

    // Rotated file retains 0600.
    const st = statSync(rotated);
    expect(st.mode & 0o777).toBe(0o600);
  });

  test('rotateIfNeeded is a no-op below the threshold', () => {
    appendAuditEvent('config.changed', { key: 'small' });
    rotateIfNeeded();
    expect(existsSync(getAuditLogRotatedPath())).toBe(false);
  });

  test('redactSecrets strips fields whose keys match the secret pattern', () => {
    const input = {
      connection_id: 'keep-me',
      access_token: 'CANARY-ACCESS-TOKEN-VALUE',
      refresh_token: 'CANARY-REFRESH-TOKEN-VALUE',
      api_key: 'CANARY-API-KEY-VALUE',
      apiKey: 'CANARY-CAMEL-API-KEY',
      secret: 'CANARY-SECRET',
      password: 'CANARY-PASSWORD',
      Authorization: 'Bearer CANARY-AUTH',
      nested: {
        refresh: 'CANARY-NESTED-REFRESH',
        ok_field: 'visible',
      },
    };
    const out = redactSecrets(input);
    expect(out.connection_id).toBe('keep-me');
    expect(out.access_token).toBe(REDACTED);
    expect(out.refresh_token).toBe(REDACTED);
    expect(out.api_key).toBe(REDACTED);
    expect(out.apiKey).toBe(REDACTED);
    expect(out.secret).toBe(REDACTED);
    expect(out.password).toBe(REDACTED);
    expect(out.Authorization).toBe(REDACTED);
    const nested = out.nested as Record<string, unknown>;
    expect(nested.refresh).toBe(REDACTED);
    expect(nested.ok_field).toBe('visible');
  });

  test('appendAuditEvent redacts secret-shaped fields before write', () => {
    // Canary values must never appear in the on-disk log, even if callers
    // accidentally pass them in. The redactor is the defence-in-depth.
    const CANARY = 'CANARY-xyz-987';
    appendAuditEvent('connection.linked', {
      connection_id: 'visible-conn',
      token: CANARY,
      refresh_token: CANARY,
      api_key: CANARY,
      password: CANARY,
      Authorization: `Bearer ${CANARY}`,
    });

    const raw = readFileSync(getAuditLogPath(), 'utf-8');
    expect(raw).not.toContain(CANARY);
    expect(raw).toContain('visible-conn');
    expect(raw).toContain(REDACTED);
  });

  test('tailAuditLog returns the last N parsed events', () => {
    appendAuditEvent('config.changed', { key: 'one' });
    appendAuditEvent('config.changed', { key: 'two' });
    appendAuditEvent('config.changed', { key: 'three' });

    const tail = tailAuditLog(2);
    expect(tail).toHaveLength(2);
    expect(tail[0]?.key).toBe('two');
    expect(tail[1]?.key).toBe('three');
  });

  test('tailAuditLog returns [] when the log does not exist', () => {
    expect(tailAuditLog(10)).toEqual([]);
  });

  test('appendAuditEvent never throws on write errors', () => {
    // Clobber HOME with a non-writable path. The module must swallow the
    // failure silently — audit logging is best-effort by design.
    process.env.HOME = '/dev/null/definitely-not-a-dir';
    expect(() => appendAuditEvent('config.changed', { key: 'x' })).not.toThrow();
  });

  test('sync lifecycle events land with the expected shape', () => {
    // Direct call-site parity: the sync service emits exactly these three
    // event types with these field shapes. Keeping the test at the audit-
    // module boundary (rather than wiring a fake TrueLayer client) avoids
    // coupling the audit suite to DB fixtures while still guarding the
    // on-disk JSONL contract that dashboards and `ferret audit` will read.
    appendAuditEvent('sync.started', {
      connection_id: 'conn-1',
      dry_run: false,
    });
    appendAuditEvent('sync.completed', {
      connection_id: 'conn-1',
      status: 'success',
      accounts: 2,
      transactions_added: 14,
      transactions_updated: 0,
      duration_ms: 123,
    });
    appendAuditEvent('sync.failed', {
      connection_id: 'conn-2',
      error_class: 'AuthError',
    });

    const tail = tailAuditLog(3);
    expect(tail).toHaveLength(3);

    const [started, completed, failed] = tail;
    expect(started?.type).toBe('sync.started');
    expect(started?.connection_id).toBe('conn-1');
    expect(started?.dry_run).toBe(false);

    expect(completed?.type).toBe('sync.completed');
    expect(completed?.connection_id).toBe('conn-1');
    expect(completed?.status).toBe('success');
    expect(completed?.accounts).toBe(2);
    expect(completed?.transactions_added).toBe(14);
    expect(completed?.transactions_updated).toBe(0);
    expect(typeof completed?.duration_ms).toBe('number');

    expect(failed?.type).toBe('sync.failed');
    expect(failed?.connection_id).toBe('conn-2');
    expect(failed?.error_class).toBe('AuthError');
  });
});
