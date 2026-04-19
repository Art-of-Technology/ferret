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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * Return the most recent `vX.Y.Z` tag, or `null` if the repo has none
 * (e.g. the 0.1.0 release we are cutting right now).
 */
function lastReleaseTag(): string | null {
  const r = spawnSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*'], {
    encoding: 'utf8',
  });
  if (r.status !== 0) return null;
  const tag = r.stdout.trim();
  return tag.length > 0 ? tag : null;
}

/**
 * Collect `git log --oneline` entries since `sinceTag`. When `sinceTag` is
 * null we fall back to every commit on the current branch so the first
 * release can still populate a changelog section.
 */
function collectCommitsSince(sinceTag: string | null): string[] {
  const range = sinceTag ? `${sinceTag}..HEAD` : 'HEAD';
  const r = spawnSync('git', ['log', '--pretty=%s', range], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

interface GroupedCommits {
  added: string[];
  changed: string[];
  fixed: string[];
  security: string[];
  other: string[];
}

/**
 * Map Conventional Commit prefixes to Keep-a-Changelog sections. The
 * categorisation is intentionally best-effort — the human editing the
 * changelog still owns the final copy, this just gives them a starting
 * point. Commits that don't match a known prefix land in `other` so they
 * stay visible rather than getting dropped silently.
 */
function groupCommits(subjects: string[]): GroupedCommits {
  const out: GroupedCommits = { added: [], changed: [], fixed: [], security: [], other: [] };
  for (const subj of subjects) {
    // `fix(security): ...` takes precedence over the generic `fix:` bucket
    // so CVE-class changes don't hide under Fixed.
    if (/^fix\(security(?:\s|[:)])/i.test(subj)) {
      out.security.push(subj);
      continue;
    }
    if (/^feat(?:\(|:)/i.test(subj)) {
      out.added.push(subj);
      continue;
    }
    if (/^fix(?:\(|:)/i.test(subj)) {
      out.fixed.push(subj);
      continue;
    }
    if (/^(perf|refactor|revert)(?:\(|:)/i.test(subj)) {
      out.changed.push(subj);
      continue;
    }
    if (/^(docs|test|chore|style|build|ci)(?:\(|:)/i.test(subj)) {
      // These rarely belong in a user-facing changelog. Keep them in
      // `other` so they still render but below the headline sections.
      out.other.push(subj);
      continue;
    }
    out.other.push(subj);
  }
  return out;
}

/** Render a Keep-a-Changelog section for `version` from the grouped commits. */
function renderChangelogSection(version: string, grouped: GroupedCommits): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [`## [${version}] — ${today}`, ''];
  const write = (heading: string, items: string[]): void => {
    if (items.length === 0) return;
    lines.push(`### ${heading}`);
    lines.push('');
    for (const item of items) lines.push(`- ${item}`);
    lines.push('');
  };
  write('Added', grouped.added);
  write('Changed', grouped.changed);
  write('Fixed', grouped.fixed);
  write('Security', grouped.security);
  write('Other', grouped.other);
  if (lines.length === 2) {
    // No commits fell into any bucket — still emit a placeholder so the
    // section exists and the human can fill it in.
    lines.push('_No notable changes._');
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Prepend `section` to CHANGELOG.md, inserted immediately above the first
 * existing `## [` heading (typically `## [Unreleased]` or the previous
 * release). If the file is missing we skip silently — CHANGELOG.md is
 * optional from the release script's perspective, the authoritative
 * artefact is the tag.
 */
function updateChangelog(version: string, section: string, dryRun: boolean): void {
  const path = join(import.meta.dir, '..', 'CHANGELOG.md');
  if (!existsSync(path)) {
    process.stdout.write('No CHANGELOG.md found; skipping changelog update.\n');
    return;
  }
  const current = readFileSync(path, 'utf8');
  // Anchor the insertion above the first `## [` heading so the new
  // release lands above the previous one and the preamble (Keep a
  // Changelog header, release policy) stays intact.
  const anchor = current.match(/^## \[/m);
  let next: string;
  if (!anchor || anchor.index === undefined) {
    // No prior release section — append to the end.
    next = `${current.trimEnd()}\n\n${section}\n`;
  } else {
    const before = current.slice(0, anchor.index);
    const after = current.slice(anchor.index);
    next = `${before}${section}\n${after}`;
  }
  if (dryRun) {
    process.stdout.write(`[dry-run] would prepend CHANGELOG.md section for ${version}\n`);
    process.stdout.write(`${section}\n`);
    return;
  }
  writeFileSync(path, next);
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

  // Build a CHANGELOG section from commit history since the previous tag
  // (or from the root commit on a fresh repo). The file is updated before
  // we commit so the release commit captures both the version bump and
  // the changelog entry atomically.
  const sinceTag = lastReleaseTag();
  const subjects = collectCommitsSince(sinceTag);
  const grouped = groupCommits(subjects);
  const section = renderChangelogSection(next, grouped);
  updateChangelog(next, section, args.dryRun);

  const tag = `v${next}`;
  const toStage = ['package.json'];
  if (existsSync(join(import.meta.dir, '..', 'CHANGELOG.md'))) {
    toStage.push('CHANGELOG.md');
  }
  run('git', ['add', ...toStage], args.dryRun);
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
