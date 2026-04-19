import { describe, expect, test } from 'bun:test';
import {
  buildBom,
  buildComponents,
  parseBunLock,
  splitNameVersion,
  toPurl,
} from '../../scripts/sbom';

// Small hand-rolled fixture that matches the structure bun emits for a
// text-format bun.lock (lockfileVersion 1). Kept inline so the test does
// not depend on the real project lockfile or its size.
const FIXTURE_LOCK = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "ferret-fixture",
      "dependencies": {
        "picocolors": "^1.1.1",
      },
    },
  },
  "packages": {
    "picocolors": ["picocolors@1.1.1", "", {}, "sha512-abcd"],
    "@types/node": ["@types/node@18.19.130", "", { "dependencies": { "undici-types": "~5.26.4" } }, "sha512-efgh"],
    "undici-types": ["undici-types@5.26.5", "", {}, "sha512-ijkl"],
  }
}`;

describe('splitNameVersion', () => {
  test('splits a simple package key', () => {
    expect(splitNameVersion('picocolors@1.1.1')).toEqual({
      name: 'picocolors',
      version: '1.1.1',
    });
  });

  test('splits a scoped package key', () => {
    expect(splitNameVersion('@types/node@18.19.130')).toEqual({
      name: '@types/node',
      version: '18.19.130',
    });
  });

  test('returns null on malformed input', () => {
    expect(splitNameVersion('nope')).toBeNull();
    expect(splitNameVersion('@scope-only')).toBeNull();
  });
});

describe('toPurl', () => {
  test('renders bare packages', () => {
    expect(toPurl('picocolors', '1.1.1')).toBe('pkg:npm/picocolors@1.1.1');
  });

  test('renders scoped packages with namespace segment', () => {
    expect(toPurl('@types/node', '18.19.130')).toBe('pkg:npm/%40types/node@18.19.130');
  });
});

describe('parseBunLock', () => {
  test('accepts the trailing-comma JSONC the real lockfile uses', () => {
    const parsed = parseBunLock(FIXTURE_LOCK);
    expect(parsed.lockfileVersion).toBe(1);
    expect(parsed.packages).toBeDefined();
    expect(Object.keys(parsed.packages ?? {}).sort()).toEqual([
      '@types/node',
      'picocolors',
      'undici-types',
    ]);
  });
});

describe('buildComponents', () => {
  test('emits a CycloneDX library component per resolved package', () => {
    const parsed = parseBunLock(FIXTURE_LOCK);
    const components = buildComponents(parsed);
    expect(components).toHaveLength(3);
    for (const c of components) {
      expect(c.type).toBe('library');
      expect(typeof c.name).toBe('string');
      expect(typeof c.version).toBe('string');
      expect(c.purl.startsWith('pkg:npm/')).toBe(true);
    }
    const names = components.map((c) => c.name);
    expect(names).toContain('picocolors');
    expect(names).toContain('@types/node');
    expect(names).toContain('undici-types');
  });
});

describe('buildBom', () => {
  test('produces a valid CycloneDX 1.5 document', () => {
    const parsed = parseBunLock(FIXTURE_LOCK);
    const components = buildComponents(parsed);
    const bom = buildBom(
      {
        name: 'ferret',
        version: '0.1.0',
        description: 'Personal finance CLI for UK banking via TrueLayer',
      },
      components,
      new Date('2026-04-19T00:00:00Z'),
    );

    // Top-level required fields per CycloneDX 1.5 JSON schema.
    expect(bom.bomFormat).toBe('CycloneDX');
    expect(bom.specVersion).toBe('1.5');
    expect(bom.serialNumber).toMatch(
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(Array.isArray(bom.components)).toBe(true);
    expect(bom.components.length).toBe(3);

    // metadata.component must describe Ferret itself.
    expect(bom.metadata.component.type).toBe('application');
    expect(bom.metadata.component.name).toBe('ferret');
    expect(bom.metadata.component.version).toBe('0.1.0');
    expect(bom.metadata.component.purl).toBe('pkg:npm/ferret@0.1.0');
    expect(bom.metadata.timestamp).toBe('2026-04-19T00:00:00.000Z');
  });
});
