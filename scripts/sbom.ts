#!/usr/bin/env bun
// Emit a CycloneDX 1.5 JSON SBOM for Ferret by walking `bun.lock`.
//
// The emitter is hand-written so the project does not need to take on any
// new runtime or build-time dependencies (see PRD compliance hardening
// tickets #42/#43/#44 and the constraints on `@cyclonedx/*` packages). It
// only reaches for `bun:*` APIs, `node:fs`, `node:path`, and `node:crypto`.
//
// Schema reference: https://cyclonedx.org/docs/1.5/json
//
// Usage:
//   bun run scripts/sbom.ts            # writes to stdout
//   bun run scripts/sbom.ts --lockfile path/to/bun.lock
//   bun run scripts/sbom.ts --out sbom.json

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface CliArgs {
  lockfile: string;
  out?: string;
}

interface PackageManifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  description?: string;
  license?: string;
}

// `bun.lock` stores each package as a tuple whose first element is
// `name@version` and subsequent elements carry resolution metadata we do
// not need here.
type BunLockPackageTuple = [string, ...unknown[]];

interface BunLockfile {
  lockfileVersion: number;
  workspaces?: Record<string, { name?: string }>;
  packages?: Record<string, unknown>;
}

interface SbomComponent {
  type: 'library';
  'bom-ref': string;
  name: string;
  version: string;
  purl: string;
  scope?: 'required' | 'optional' | 'excluded';
}

interface SbomMetadataComponent {
  type: 'application';
  'bom-ref': string;
  name: string;
  version: string;
  purl: string;
  description?: string;
  licenses?: Array<{ license: { id: string } }>;
}

interface CycloneDxBom {
  bomFormat: 'CycloneDX';
  specVersion: '1.5';
  serialNumber: string;
  version: 1;
  metadata: {
    timestamp: string;
    tools: Array<{ vendor: string; name: string; version: string }>;
    component: SbomMetadataComponent;
  };
  components: SbomComponent[];
}

/**
 * Parse CLI flags. Kept tiny on purpose — we don't want a dep on commander
 * or citty here because this file runs in CI and release pipelines.
 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { lockfile: 'bun.lock' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--lockfile' && argv[i + 1]) {
      args.lockfile = argv[i + 1] as string;
      i++;
    } else if (arg === '--out' && argv[i + 1]) {
      args.out = argv[i + 1] as string;
      i++;
    }
  }
  return args;
}

/**
 * Split a `name@version` key (e.g. `@types/node@18.19.130`) into its two
 * parts. Scoped packages start with `@`, so we look for the *last* `@` that
 * isn't at position 0.
 */
export function splitNameVersion(key: string): { name: string; version: string } | null {
  const idx = key.lastIndexOf('@');
  if (idx <= 0) {
    return null;
  }
  const name = key.slice(0, idx);
  const version = key.slice(idx + 1);
  if (!name || !version) {
    return null;
  }
  return { name, version };
}

/**
 * Build the CycloneDX `purl` for an npm component. Package URL spec:
 * https://github.com/package-url/purl-spec/blob/master/PURL-TYPES.rst#npm
 */
export function toPurl(name: string, version: string): string {
  // Scoped packages: namespace is `@scope`, name is the rest. We URL-encode
  // the `/` so the purl is unambiguous.
  if (name.startsWith('@')) {
    const slash = name.indexOf('/');
    if (slash > 0) {
      const namespace = encodeURIComponent(name.slice(0, slash));
      const bare = encodeURIComponent(name.slice(slash + 1));
      return `pkg:npm/${namespace}/${bare}@${encodeURIComponent(version)}`;
    }
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

/**
 * Parse a `bun.lock` file. Bun's lockfile is JSONC-ish (it tolerates
 * trailing commas), so we normalise it to valid JSON before handing it to
 * `JSON.parse`. The alternative — shelling out to `bun pm ls --json` —
 * would drag us back to a runtime dependency on the Bun CLI being present
 * in the exact right version.
 */
export function parseBunLock(raw: string): BunLockfile {
  // bun.lock does not emit `//` or `/* */` comments — the only JSONC-ism
  // it uses is trailing commas before closing braces/brackets. A naive
  // comment strip would corrupt sha512 hashes (base64 padding can produce
  // `//` sequences inside strings), so we only scrub trailing commas.
  const normalised = raw.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(normalised) as BunLockfile;
}

/**
 * Pull every resolved package out of the lockfile and build CycloneDX
 * components. We dedupe on `name@version` because the same logical package
 * can appear multiple times under different resolution keys (transitives,
 * overrides, nested installs).
 */
export function buildComponents(lock: BunLockfile): SbomComponent[] {
  const out = new Map<string, SbomComponent>();
  const packages = lock.packages ?? {};
  for (const [key, entry] of Object.entries(packages)) {
    // The first element is always `"name@version"`. If the array is empty
    // or malformed (shouldn't happen with a real bun.lock), skip it.
    const tuple = Array.isArray(entry) ? (entry as BunLockPackageTuple) : undefined;
    const header = tuple && typeof tuple[0] === 'string' ? tuple[0] : key;
    const parsed = splitNameVersion(header);
    if (!parsed) {
      continue;
    }
    const dedupeKey = `${parsed.name}@${parsed.version}`;
    if (out.has(dedupeKey)) {
      continue;
    }
    const purl = toPurl(parsed.name, parsed.version);
    out.set(dedupeKey, {
      type: 'library',
      'bom-ref': purl,
      name: parsed.name,
      version: parsed.version,
      purl,
    });
  }
  return Array.from(out.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function buildBom(
  manifest: PackageManifest,
  components: SbomComponent[],
  now: Date = new Date(),
): CycloneDxBom {
  const rootPurl = toPurl(manifest.name, manifest.version);
  const metadataComponent: SbomMetadataComponent = {
    type: 'application',
    'bom-ref': rootPurl,
    name: manifest.name,
    version: manifest.version,
    purl: rootPurl,
  };
  if (manifest.description) {
    metadataComponent.description = manifest.description;
  }
  if (manifest.license) {
    metadataComponent.licenses = [{ license: { id: manifest.license } }];
  }
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: now.toISOString(),
      tools: [
        {
          vendor: 'ferret',
          name: 'ferret-sbom',
          version: manifest.version,
        },
      ],
      component: metadataComponent,
    },
    components,
  };
}

export function loadManifest(cwd: string): PackageManifest {
  const raw = readFileSync(join(cwd, 'package.json'), 'utf8');
  const parsed = JSON.parse(raw) as PackageManifest;
  if (!parsed.name || !parsed.version) {
    throw new Error('package.json must have a name and version');
  }
  return parsed;
}

export function emitSbom(cwd: string, lockfilePath: string): CycloneDxBom {
  const manifest = loadManifest(cwd);
  const lockRaw = readFileSync(resolve(cwd, lockfilePath), 'utf8');
  const lock = parseBunLock(lockRaw);
  const components = buildComponents(lock);
  return buildBom(manifest, components);
}

// Entry point: only run when invoked directly, so the test file can import
// the pure functions above without triggering I/O.
if (import.meta.main) {
  const args = parseArgs(Bun.argv.slice(2));
  const bom = emitSbom(process.cwd(), args.lockfile);
  const serialised = `${JSON.stringify(bom, null, 2)}\n`;
  if (args.out) {
    writeFileSync(args.out, serialised);
  } else {
    process.stdout.write(serialised);
  }
}
