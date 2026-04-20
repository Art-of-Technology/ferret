// `ferret setup` — interactive bootstrap for credentials + OAuth redirect.
//
// Collects the three secrets the rest of the CLI needs (TrueLayer client id
// & secret, Anthropic API key) and an optional OAuth callback port, then
// persists them in the two storage paths PRD §9.1 documents:
//   - secrets → OS keychain (service `ferret`) via `keytar`
//   - OAuth port → `~/.ferret/.env` so `ferret link` can bind a stable URI
//
// The command is idempotent: existing values show up as defaults in the
// prompt, so re-running `ferret setup` after rotating a credential is safe.
// After writing, it prints the fully-formed `http://localhost:<port>/callback`
// URL and a nudge toward TrueLayer's free developer console, which is where
// the redirect URI actually has to be registered before `ferret link` works.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { defineCommand } from 'citty';
import consola from 'consola';
import { ferretHome } from '../lib/config';
import { envFilePath, parseEnvFile } from '../lib/env-file';
import { ValidationError } from '../lib/errors';
import {
  ANTHROPIC_API_KEY,
  TRUELAYER_CLIENT_ID,
  TRUELAYER_CLIENT_SECRET,
  tryResolveSecret,
} from '../lib/secrets';
import { setToken } from '../services/keychain';

const TRUELAYER_CONSOLE_URL = 'https://console.truelayer.com/';

// Port range matches the random fallback used in services/oauth.ts so a
// suggested default will always be in the same band the live app may already
// have whitelisted.
const PORT_MIN = 8000;
const PORT_MAX = 9999;

function isValidPort(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

// Binds port 0 on loopback to let the kernel pick a free port, then closes.
// The returned number is free *at this instant* — a later binder could still
// race us for it, but for a setup-time default that's good enough; the user
// can always override if they hit a collision at `ferret link` time.
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object' && typeof addr.port === 'number') {
        const port = addr.port;
        server.close((err) => (err ? reject(err) : resolve(port)));
      } else {
        server.close();
        reject(new Error('Could not determine a free port from the OS.'));
      }
    });
  });
}

async function suggestedDefaultPort(): Promise<number> {
  try {
    const picked = await findFreePort();
    if (picked >= PORT_MIN && picked <= PORT_MAX) return picked;
    // Kernel handed us something outside our band (e.g. ephemeral range on
    // Linux starts at 32768). Fall back to a stable mid-band value so the
    // user sees a predictable suggestion.
  } catch {
    // ignore — fall through to stable default
  }
  return 8765;
}

async function promptRequired(label: string, currentlySet: boolean): Promise<string> {
  // Consola's text prompt has no mask option, so secrets echo to the terminal.
  // This is acceptable for a single-user local CLI; we mitigate by offering to
  // keep the existing value when one is already stored.
  while (true) {
    const hint = currentlySet ? ' (press enter to keep the existing value)' : '';
    const value = (await consola.prompt(`${label}${hint}`, {
      type: 'text',
      cancel: 'reject',
    })) as string;
    const trimmed = (value ?? '').trim();
    if (trimmed.length > 0) return trimmed;
    if (currentlySet) return '';
    consola.warn(`${label} is required.`);
  }
}

function upsertEnvLine(existing: string, key: string, value: string): string {
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
    if (out.length > 0 && out[out.length - 1]?.trim() !== '') out.push('');
    out.push(`${key}=${value}`);
  }
  // Ensure trailing newline for POSIX tools.
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

function writeOauthPort(port: number): string {
  const path = envFilePath();
  const dir = ferretHome();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const next = upsertEnvLine(existing, 'FERRET_OAUTH_PORT', String(port));
  writeFileSync(path, next, { mode: 0o600 });
  return path;
}

export default defineCommand({
  meta: {
    name: 'setup',
    description: 'Interactively capture TrueLayer + Anthropic credentials and OAuth port',
  },
  async run() {
    consola.info(
      "ferret setup — you'll need a free TrueLayer developer account (https://console.truelayer.com/) and an Anthropic API key.",
    );

    const existingClientId = await tryResolveSecret(TRUELAYER_CLIENT_ID);
    const existingClientSecret = await tryResolveSecret(TRUELAYER_CLIENT_SECRET);
    const existingAnthropicKey = await tryResolveSecret(ANTHROPIC_API_KEY);

    const clientId = await promptRequired('TRUELAYER_CLIENT_ID', existingClientId !== null);
    const clientSecret = await promptRequired(
      'TRUELAYER_CLIENT_SECRET',
      existingClientSecret !== null,
    );
    const anthropicKey = await promptRequired('ANTHROPIC_API_KEY', existingAnthropicKey !== null);

    // Determine a sensible port default: prefer what the user already has
    // configured (shell env, previously-written file), otherwise ask the OS
    // for a free one. Offering a specific number as the default makes the
    // prompt feel concrete instead of open-ended.
    const envFile = envFilePath();
    const existingPortEnv = process.env.FERRET_OAUTH_PORT;
    let portDefault: number;
    if (existingPortEnv && isValidPort(Number.parseInt(existingPortEnv, 10))) {
      portDefault = Number.parseInt(existingPortEnv, 10);
    } else if (existsSync(envFile)) {
      const parsed = parseEnvFile(readFileSync(envFile, 'utf-8'));
      const fromFile = Number.parseInt(parsed.FERRET_OAUTH_PORT ?? '', 10);
      portDefault = isValidPort(fromFile) ? fromFile : await suggestedDefaultPort();
    } else {
      portDefault = await suggestedDefaultPort();
    }

    const portRaw = (await consola.prompt(
      `OAuth callback port (press enter for default ${portDefault})`,
      {
        type: 'text',
        default: String(portDefault),
        cancel: 'reject',
      },
    )) as string;
    const portTrimmed = (portRaw ?? '').trim();
    const portNumber = portTrimmed.length === 0 ? portDefault : Number.parseInt(portTrimmed, 10);
    if (!isValidPort(portNumber)) {
      throw new ValidationError(
        `OAuth port must be an integer in 1–65535 (got "${portTrimmed || portRaw}").`,
      );
    }

    if (clientId !== '') {
      await setToken(TRUELAYER_CLIENT_ID.keychainAccount, clientId);
    }
    if (clientSecret !== '') {
      await setToken(TRUELAYER_CLIENT_SECRET.keychainAccount, clientSecret);
    }
    if (anthropicKey !== '') {
      await setToken(ANTHROPIC_API_KEY.keychainAccount, anthropicKey);
    }
    const writtenEnvPath = writeOauthPort(portNumber);

    const callbackUrl = `http://localhost:${portNumber}/callback`;
    consola.success('Credentials stored in the OS keychain.');
    consola.info(`OAuth port ${portNumber} saved to ${writtenEnvPath}.`);
    consola.box(
      [
        'Next step — register the redirect URI in TrueLayer:',
        '',
        `  1. Open ${TRUELAYER_CONSOLE_URL} (free developer account).`,
        '  2. In your app settings, add this as an Allowed Redirect URI:',
        '',
        `       ${callbackUrl}`,
        '',
        '  3. Save, then run `ferret link` to connect your bank.',
      ].join('\n'),
    );
  },
});
