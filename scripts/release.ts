#!/usr/bin/env bun
// Semver bump + tag helper. Reads the current version from package.json,
// applies the requested bump, writes it back, commits, and tags `vX.Y.Z`.
// Does NOT push — pushing is a deliberate manual step (PRD §10 Phase 8 calls
// out semantic versioning + release workflow but not automated publish).
//
// Usage:
//   bun run scripts/release.ts --patch
//   bun run scripts/release.ts --minor
//   bun run scripts/release.ts --major
//   bun run scripts/release.ts --version 1.2.3   (explicit, skips bump)
//   bun run scripts/release.ts --dry-run --patch (prints what would happen)

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Bump = 'major' | 'minor' | 'patch';

interface Args {
  bump?: Bump;
  explicit?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--major':
        out.bump = 'major';
        break;
      case '--minor':
        out.bump = 'minor';
        break;
      case '--patch':
        out.bump = 'patch';
        break;
      case '--dry-run':
        out.dryRun = true;
        break;
      case '--version': {
        const next = argv[i + 1];
        if (!next) throw new Error('--version requires a value (e.g. --version 1.2.3)');
        out.explicit = next;
        i++;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!out.bump && !out.explicit) {
    throw new Error('Must pass one of --major, --minor, --patch, or --version <x.y.z>');
  }
  if (out.bump && out.explicit) {
    throw new Error('--version is mutually exclusive with --major/--minor/--patch');
  }
  return out;
}

function bumpVersion(current: string, bump: Bump): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) throw new Error(`Invalid current version "${current}" — expected MAJOR.MINOR.PATCH`);
  // After regex validation we know capture groups 1-3 are digit strings.
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  switch (bump) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
  }
}

function validateExplicit(version: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`--version "${version}" must be MAJOR.MINOR.PATCH (no prefix or suffix)`);
  }
  return version;
}

function ensureCleanTree(dryRun: boolean): void {
  const status = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  if (status.status !== 0) {
    throw new Error(`git status failed: ${status.stderr}`);
  }
  const dirty = status.stdout.trim();
  if (dirty.length > 0 && !dryRun) {
    throw new Error(
      `Working tree not clean. Commit or stash before releasing:\n${dirty}\n(re-run with --dry-run to preview without checking)`,
    );
  }
}

function run(cmd: string, args: string[], dryRun: boolean): void {
  const display = `${cmd} ${args.join(' ')}`;
  if (dryRun) {
    process.stdout.write(`[dry-run] ${display}\n`);
    return;
  }
  process.stdout.write(`$ ${display}\n`);
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`Command failed (${r.status}): ${display}`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  ensureCleanTree(args.dryRun);

  const pkgPath = join(import.meta.dir, '..', 'package.json');
  const pkgRaw = readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(pkgRaw) as { version: string };
  const current = pkg.version;
  let next: string;
  if (args.explicit) {
    next = validateExplicit(args.explicit);
  } else if (args.bump) {
    next = bumpVersion(current, args.bump);
  } else {
    // parseArgs guarantees one of bump/explicit is set, so this branch is
    // unreachable. The exhaustive check keeps biome happy without `!`.
    throw new Error('release: parseArgs allowed neither --version nor a bump flag');
  }

  process.stdout.write(`Bumping version: ${current} -> ${next}\n`);

  if (args.dryRun) {
    process.stdout.write(`[dry-run] would write package.json with version ${next}\n`);
  } else {
    pkg.version = next;
    // Preserve trailing newline + 2-space indent to match the existing file
    // style; this keeps the diff minimal and biome-clean.
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  const tag = `v${next}`;
  run('git', ['add', 'package.json'], args.dryRun);
  run('git', ['commit', '-m', `chore(release): ${tag}`], args.dryRun);
  run('git', ['tag', '-a', tag, '-m', `Release ${tag}`], args.dryRun);

  process.stdout.write(`\nDone. Push manually when ready:\n  git push && git push origin ${tag}\n`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`release: ${(err as Error).message}\n`);
  process.exit(1);
}
