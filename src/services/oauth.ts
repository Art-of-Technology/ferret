// Ephemeral local OAuth callback server for `ferret link`.
//
// Per PRD §4.1 and §8.1:
//   - Random port in 8000-9999, retry up to 3 times on collision
//   - 5-minute auto-shutdown
//   - CSRF state validation
//   - Opens default browser via macOS `open` / linux `xdg-open`
//
// We expose `runOAuthFlow()` which returns the captured code+state,
// plus `generateState()` and `validateState()` as pure helpers (testable).

import { randomBytes } from 'node:crypto';
import { platform } from 'node:os';
import { AuthError, NetworkError } from '../lib/errors';

export const PORT_MIN = 8000;
export const PORT_MAX = 9999;
export const MAX_PORT_RETRIES = 3;
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Cryptographically-random CSRF state token (hex). */
export function generateState(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/** Constant-time-ish equality check for state validation. */
export function validateState(expected: string, actual: string | null | undefined): boolean {
  if (!actual || expected.length !== actual.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  }
  return mismatch === 0;
}

function pickPort(): number {
  return PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN + 1));
}

export interface OAuthCallbackResult {
  code: string;
  state: string;
}

export interface OAuthFlowOptions {
  /** Builds the auth URL given the chosen redirect URI. */
  buildAuthUrl: (redirectUri: string, state: string) => string;
  /** Override timeout (ms). */
  timeoutMs?: number;
  /** Override expected state (defaults to a freshly generated one). */
  state?: string;
  /** Inject browser opener (mainly for tests). Defaults to platform `open`. */
  openBrowser?: (url: string) => void;
  /** Callback invoked once the server is listening. */
  onListening?: (info: { port: number; redirectUri: string; authUrl: string }) => void;
}

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>ferret: connected</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0a0a0a;color:#eaeaea;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
.card{padding:32px 48px;border:1px solid #2a2a2a;border-radius:8px;text-align:center;}
h1{margin:0 0 8px;font-size:18px;font-weight:500;}p{margin:0;color:#888;font-size:14px;}</style></head>
<body><div class="card"><h1>ferret connected</h1><p>You can close this tab and return to your terminal.</p></div></body></html>`;

const ERROR_HTML = (msg: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>ferret: error</title></head>
<body style="font-family:sans-serif;padding:40px;background:#0a0a0a;color:#eaeaea;">
<h1 style="font-size:18px;">ferret: ${escapeHtml(msg)}</h1>
<p style="color:#888;">Return to the terminal for details.</p></body></html>`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>'"`]/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function defaultOpenBrowser(url: string): void {
  const cmd =
    platform() === 'darwin'
      ? ['open', url]
      : platform() === 'win32'
        ? ['cmd', '/c', 'start', '""', url]
        : ['xdg-open', url];
  try {
    Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' });
  } catch {
    // Browser open is best-effort; the URL is also printed to stdout by the caller.
  }
}

interface ServerHandle {
  port: number;
  stop: (closeActive?: boolean) => void;
}

function startCallbackServer(
  port: number,
  expectedState: string,
  resolve: (r: OAuthCallbackResult) => void,
  reject: (e: Error) => void,
): ServerHandle {
  // Bun.serve binds eagerly; if the port is busy, an exception is thrown synchronously.
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== '/callback') {
        return new Response('Not found', { status: 404 });
      }
      const error = url.searchParams.get('error');
      const errorDescription = url.searchParams.get('error_description');
      if (error) {
        const msg = errorDescription ? `${error}: ${errorDescription}` : error;
        reject(new AuthError(`TrueLayer authorization failed — ${msg}`));
        return new Response(ERROR_HTML(msg), {
          status: 400,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code) {
        reject(new AuthError('TrueLayer callback missing `code` parameter.'));
        return new Response(ERROR_HTML('missing code'), {
          status: 400,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      if (!validateState(expectedState, state)) {
        reject(new AuthError('OAuth state mismatch — possible CSRF. Aborting.'));
        return new Response(ERROR_HTML('state mismatch'), {
          status: 400,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      resolve({ code, state: state as string });
      return new Response(SUCCESS_HTML, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
  });
  return {
    port: server.port ?? port,
    stop: (closeActive = true) => server.stop(closeActive),
  };
}

export async function runOAuthFlow(
  opts: OAuthFlowOptions,
): Promise<OAuthCallbackResult & { redirectUri: string; port: number }> {
  const state = opts.state ?? generateState();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const opener = opts.openBrowser ?? defaultOpenBrowser;

  let server: ServerHandle | null = null;
  let port = 0;
  let bound = false;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_PORT_RETRIES; attempt++) {
    const candidate = pickPort();
    try {
      // Probe for binding success: a port collision throws synchronously here.
      const probe = Bun.serve({
        port: candidate,
        hostname: '127.0.0.1',
        fetch: () => new Response('ok'),
      });
      probe.stop(true);
      port = candidate;
      bound = true;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!bound) {
    throw new NetworkError(
      `Could not bind a localhost port in ${PORT_MIN}-${PORT_MAX} after ${MAX_PORT_RETRIES} attempts: ${(lastErr as Error)?.message ?? 'unknown'}`,
    );
  }

  const redirectUri = `http://localhost:${port}/callback`;
  const authUrl = opts.buildAuthUrl(redirectUri, state);

  const result = await new Promise<OAuthCallbackResult>((resolve, reject) => {
    let settled = false;
    const wrap =
      <T>(fn: (v: T) => void) =>
      (v: T) => {
        if (settled) return;
        settled = true;
        fn(v);
      };
    const wResolve = wrap(resolve);
    const wReject = wrap(reject);

    try {
      server = startCallbackServer(port, state, wResolve, wReject);
    } catch (err) {
      wReject(
        new NetworkError(`Failed to start callback server on :${port} — ${(err as Error).message}`),
      );
      return;
    }

    opts.onListening?.({ port, redirectUri, authUrl });
    opener(authUrl);

    const timer = setTimeout(() => {
      wReject(new AuthError(`OAuth flow timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    // Don't keep the event loop alive past resolution.
    if (typeof timer === 'object' && timer && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }
  }).finally(() => {
    server?.stop(true);
  });

  return { ...result, redirectUri, port };
}
