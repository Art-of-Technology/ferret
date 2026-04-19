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
import ferretSvgRaw from '../ferret.svg' with { type: 'text' };
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

// Inline the ferret mark so color inherits from the surrounding .logo container.
const LOGO_SVG = ferretSvgRaw.replace(/fill="black"/g, 'fill="currentColor"');

const SUCCESS_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ferret — connected</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:dark;}
*{box-sizing:border-box;}
body{font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;background:radial-gradient(ellipse at top,#161616 0%,#0a0a0a 60%);color:#eaeaea;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;}
.card{max-width:420px;width:100%;padding:40px 32px;background:#111;border:1px solid #222;border-radius:16px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.4);}
.logo{margin:0 auto 20px;display:flex;align-items:center;justify-content:center;color:#f97316;}
.logo svg{width:56px;height:auto;filter:drop-shadow(0 4px 12px rgba(249,115,22,.25));}
.check{display:inline-flex;align-items:center;gap:8px;padding:4px 12px;border-radius:999px;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);color:#4ade80;font-size:12px;font-weight:500;margin-bottom:16px;}
.check::before{content:'';width:6px;height:6px;border-radius:50%;background:#4ade80;box-shadow:0 0 8px #4ade80;}
h1{margin:0 0 10px;font-size:22px;font-weight:600;letter-spacing:-.01em;}
p{margin:0;color:#9a9a9a;font-size:14px;line-height:1.5;}
.hint{margin-top:20px;font-size:12px;color:#666;}
</style></head>
<body><div class="card">
<div class="logo">${LOGO_SVG}</div>
<div class="check">connection established</div>
<h1>Your bank is linked</h1>
<p>You can close this tab and return to the terminal.</p>
<div class="hint">ferret · personal finance CLI</div>
</div>
<script>setTimeout(()=>{try{window.close();}catch(e){}},2500);</script>
</body></html>`;

const ERROR_HTML = (msg: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ferret — error</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:dark;}
body{font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;background:radial-gradient(ellipse at top,#161616 0%,#0a0a0a 60%);color:#eaeaea;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;}
.card{max-width:420px;width:100%;padding:40px 32px;background:#111;border:1px solid #222;border-radius:16px;text-align:center;}
.logo{margin:0 auto 20px;display:flex;align-items:center;justify-content:center;color:#f97316;}
.logo svg{width:56px;height:auto;}
.badge{display:inline-flex;align-items:center;gap:8px;padding:4px 12px;border-radius:999px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:#f87171;font-size:12px;font-weight:500;margin-bottom:16px;}
h1{margin:0 0 10px;font-size:20px;font-weight:600;}
p{margin:0;color:#9a9a9a;font-size:14px;line-height:1.5;word-break:break-word;}
.hint{margin-top:20px;font-size:12px;color:#666;}
</style></head>
<body><div class="card">
<div class="logo">${LOGO_SVG}</div>
<div class="badge">connection failed</div>
<h1>Something went wrong</h1>
<p>${escapeHtml(msg)}</p>
<div class="hint">Return to the terminal for details.</div>
</div></body></html>`;

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
      // Defer so the success HTML finishes streaming before the caller's
      // `finally` tears the server down.
      queueMicrotask(() => resolve({ code, state: state as string }));
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

  // Build dedup wrappers up front so we can hand them to the server bind.
  let settled = false;
  let resolveResult!: (r: OAuthCallbackResult) => void;
  let rejectResult!: (e: Error) => void;
  const result = new Promise<OAuthCallbackResult>((resolve, reject) => {
    resolveResult = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    rejectResult = (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    };
  });

  // Bind the real callback server directly, retrying with a fresh port on
  // collision. We deliberately avoid a probe-then-bind two-step (which has a
  // TOCTOU race: another process can grab the port between probe.stop() and
  // the real bind).
  // A fixed port lets live TrueLayer apps register a single, stable
  // redirect URI. Random port fallback is kept for dev / sandbox where
  // any free port is fine.
  const fixedPort = process.env.FERRET_OAUTH_PORT
    ? Number.parseInt(process.env.FERRET_OAUTH_PORT, 10)
    : null;
  const maxAttempts = fixedPort ? 1 : MAX_PORT_RETRIES;
  let server: ServerHandle | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = fixedPort ?? pickPort();
    try {
      server = startCallbackServer(candidate, state, resolveResult, rejectResult);
      break;
    } catch (err) {
      // Bun surfaces port collisions as a synchronous throw; retry with a new
      // random port. Other errors (e.g. permission denied) will eventually
      // surface via lastErr if all attempts exhaust.
      lastErr = err;
    }
  }
  if (!server) {
    throw new NetworkError(
      `Could not bind a localhost port in ${PORT_MIN}-${PORT_MAX} after ${MAX_PORT_RETRIES} attempts: ${(lastErr as Error)?.message ?? 'unknown'}`,
    );
  }
  const port = server.port;
  const redirectUri = `http://localhost:${port}/callback`;
  const authUrl = opts.buildAuthUrl(redirectUri, state);

  try {
    opts.onListening?.({ port, redirectUri, authUrl });
    opener(authUrl);

    const timer = setTimeout(() => {
      rejectResult(new AuthError(`OAuth flow timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    if (typeof timer === 'object' && timer && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }

    const captured = await result;
    return { ...captured, redirectUri, port };
  } finally {
    // Graceful stop — lets the success/error response finish streaming so
    // the browser renders our page instead of ERR_CONNECTION_REFUSED.
    server.stop(false);
  }
}
