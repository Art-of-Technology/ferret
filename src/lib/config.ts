import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConfigError } from './errors';

export interface FerretConfig {
  currency: string;
  claude: {
    model: string;
    max_context_transactions: number;
    max_tokens_per_ask: number;
  };
  sync: {
    default_history_days: number;
    parallel_connections: number;
  };
  display: {
    date_format: string;
    show_colors: boolean;
  };
}

export const DEFAULT_CONFIG: FerretConfig = {
  currency: 'GBP',
  claude: {
    model: 'claude-opus-4-7',
    max_context_transactions: 500,
    max_tokens_per_ask: 4096,
  },
  sync: {
    default_history_days: 730,
    parallel_connections: 2,
  },
  display: {
    date_format: 'yyyy-MM-dd',
    show_colors: true,
  },
};

export function ferretHome(): string {
  return join(process.env.HOME ?? homedir(), '.ferret');
}

export function configPath(): string {
  return join(ferretHome(), 'config.json');
}

export function loadConfig(): FerretConfig {
  const path = configPath();
  if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<FerretConfig>;
    return mergeConfig(DEFAULT_CONFIG, parsed);
  } catch (err) {
    throw new ConfigError(`Failed to read ${path}: ${(err as Error).message}`);
  }
}

export function writeConfig(cfg: FerretConfig): void {
  const path = configPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

// Dot-path getter, e.g. "claude.model".
export function getConfigValue(cfg: FerretConfig, key: string): unknown {
  return key.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object' && part in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, cfg);
}

export function setConfigValue(cfg: FerretConfig, key: string, value: string): FerretConfig {
  const parts = key.split('.');
  if (parts.length === 0) throw new ConfigError(`Invalid config key: ${key}`);
  const next = structuredClone(cfg) as unknown as Record<string, unknown>;
  let cursor: Record<string, unknown> = next;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    const existing = cursor[p];
    if (!existing || typeof existing !== 'object') {
      cursor[p] = {};
    }
    cursor = cursor[p] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = coerce(value);
  return next as unknown as FerretConfig;
}

function coerce(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?\d+$/.test(v)) return Number.parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return Number.parseFloat(v);
  return v;
}

function mergeConfig(base: FerretConfig, override: Partial<FerretConfig>): FerretConfig {
  const merged = structuredClone(base) as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(override)) {
    const existing = merged[k];
    if (
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      v &&
      typeof v === 'object' &&
      !Array.isArray(v)
    ) {
      merged[k] = { ...(existing as object), ...(v as object) };
    } else if (v !== undefined) {
      merged[k] = v;
    }
  }
  return merged as unknown as FerretConfig;
}
