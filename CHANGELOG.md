# Changelog

All notable changes to Ferret are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Part of epic [#36](https://github.com/Art-of-Technology/ferret/issues/36)
(ISO 27001 A.12.1 / SOC 2 CC8 — change management).

## Release policy

- **SemVer**: `MAJOR.MINOR.PATCH`.
  - `MAJOR` — breaking changes to the CLI surface, config schema, or
    database schema (migrations that cannot be auto-applied).
  - `MINOR` — new commands, new flags, new providers, or additive schema
    changes with auto-migrations.
  - `PATCH` — bug fixes, performance improvements, and internal refactors
    that preserve behaviour.
  - Pre-1.0: breaking changes may land in `MINOR` releases and will be
    called out in the `Changed` section here. Expect churn.
- **Conventional Commits** (`feat:`, `fix:`, `perf:`, `refactor:`,
  `docs:`, `test:`, `chore:`) drive the changelog sections:
  - `feat:` → `Added`
  - `fix:` (or `perf:` / `refactor:` with user-visible effect) → `Fixed`
    or `Changed`
  - `fix(security):` → `Security`
  - Everything else is grouped under `Changed` or omitted if purely
    internal.
- **Releases** are cut by `bun run scripts/release.ts --patch|--minor|--major`
  which bumps `package.json`, prepends a new section to this file from
  `git log`, commits, and creates an annotated `vX.Y.Z` tag. Pushing to
  the remote is a deliberate manual step.

## [Unreleased]

No changes yet.

## [0.1.0] — 2026-04-19

Initial alpha covering PRD Phases 0–8 plus the `propose_budgets` ask-mode
tool. Single-user, UK-only, TrueLayer + Claude + local SQLite.

### Added

- **Phase 0 — Scaffolding**: Bun + TypeScript strict + drizzle-orm +
  biome + citty command auto-registry. `ferret init`, `ferret version`,
  `ferret config get|set|path`. Default category taxonomy seeded on init.
  (`2a890a1`, `9c2b876`, `cef11d5`, `f3ac3a3`)
- **Phase 6 — Budgets**: `ferret budget set|rm|history|export` and the
  default month view with ASCII progress bars and pace projection
  (`0727e0e`, `0144b32`, `5a7007c`). Budget query aggregates collapsed
  from N+1 to a single grouped query (`316fc7a`).
- **Phase 3 — List & filter**: UTC-safe date and duration helpers,
  table/JSON/CSV formatters, `ferret ls` with `--since`, `--until`,
  `--category`, `--merchant`, `--account`, `--min`/`--max`,
  `--incoming`/`--outgoing`, `--limit`, `--sort`, `--json`, `--csv`
  (`5ddec19`, `d091b84`, `ef8d1a8`, `03fad75`).
- **Phase 1 — TrueLayer OAuth link**: `services/truelayer.ts` API client
  with proactive 60s token-refresh skew and 401/403/429/5xx handling;
  `services/oauth.ts` local callback server on `127.0.0.1` with CSRF
  state validation and 5-minute auto-stop; keychain wrapper and secrets
  resolver (env fallback); `ferret link`, `ferret unlink`,
  `ferret connections` (`5cc4be5`, `2f512e4`, `b1f1a40`, `0b42205`).
- **Phase 7 — CSV import**: CSV parser + import orchestrator; Lloyds,
  NatWest, Revolut (spec-validated), HSBC, Barclays, Santander (best-
  effort) parsers; strict + loose dedupe with inline Levenshtein;
  `ferret import` and `ferret export` (`796fddc`, `7082515`, `27d40f1`,
  `a1dc0fc`, `2a9fc12`).
- **Phase 4 — Categorisation**: Claude API wrapper with batching (50/call),
  structured-output via tool use, 429/5xx retry with jitter; rule engine
  + merchant cache + AI fallback pipeline; `ferret tag` and `ferret rules`
  with manual-override precedence (`9c8dd49`, `8897a75`, `a111659`,
  `6b165d4`).
- **Phase 2 — Transaction sync**: sync orchestrator with per-bank partial
  failure isolation, rate-limit isolation, and per-account atomic
  transactions; `ferret sync` with `--connection`, `--since`, `--dry-run`
  flags and a closing summary (`d693462`, `d6271f2`, `f8c9cde`).
- **Phase 8 — Polish & release**: GitHub Actions CI (lint, typecheck,
  test, bench) on macOS + Linux; DB bench (`bun run bench`) enforcing
  PRD §11.1 targets; `scripts/release.ts` semver bump + tag helper
  (`00ef287`, `8a89ba0`, `d856879`, `324725d`).
- **Phase 5 — Natural-language query**: SELECT-only SQL validator
  (`lib/sql-validator.ts`); analytics helpers (`get_category_summary`,
  `get_recurring_payments`, `get_account_list`, read-only query meta);
  ask tool-use loop orchestrator with 10-iteration cap, per-call
  max-tokens from config, and 8000-char tool-result truncation;
  `ferret ask` with `--verbose`, `--json`, `--model` (`192b4ef`,
  `b77ddcc`, `2600d8b`, `b1b0850`).
- **`ferret ask` `propose_budgets` tool (#35)**: Claude can propose
  monthly budgets per category; the CLI collects accepted proposals and
  either prints paste-ready `ferret budget set` commands or applies them
  when the user passes `--apply`. Proposals are validated against the
  `categories` table before being shown. (`4ca4547`, `a147963`, `a7c331b`,
  `cb2fd49`.)
- **`ferret remove` and `ferret unlink --all`** for hard-delete flows
  that wipe connection, accounts, transactions, sync log entries, and
  keychain tokens (`7e4a8a2`).
- **TrueLayer `/cards` fallback** for card-only providers (e.g. Amex)
  that do not implement `/accounts` (`2e39108`).
- **`FERRET_OAUTH_PORT` override** so live TrueLayer apps can register a
  stable `http://localhost:<PORT>/callback` redirect URI; random-port
  fallback retained for dev/sandbox (`f930a3e`).
- Polished HTML callback success/error pages with the ferret mark
  (`f930a3e`).
- MIT `LICENSE` (`d856879`).
- `docs/prd.md` and `docs/issues.md` as the in-tree planning artefacts.

### Changed

- Config directory and DB path are computed lazily so tests that override
  `HOME` see the new value (`ec536bc`).
- Sync timestamp helper made unit-safe; account upsert now atomic
  (`58ff86f`).
- Sync logger typed as `Pick<typeof consola, ...>` and `expiresAt` field
  name anchored across the module (`82fab9b`).
- Categorisation: rule sorting cached once per pass; Claude confidence
  disambiguated from rule confidence (`933d9a6`).
- Clear-auto-categorisations collapsed into a single DB statement
  (`0d7c9ec`).
- Importers: shared UK date/amount helpers extracted; dedupe narrowed by
  date and bucket-indexed to O(parsed + window) average
  (`6ef49ad`, `457a826`, `20faa6a`, `39c5d56`).
- Recurring-payment detection pushes merchant + month grouping into SQL
  instead of materialising rows in JS (`9cc702c`).
- Ask loop: row cap pushed into SQLite so huge result sets are not
  materialised before truncation (`4af4b07`); `AbortSignal` propagated
  into `messagesCreate` so Ctrl-C cancels in-flight Claude calls
  (`7931af6`); error class, named constants, schema clarity, and result
  cap tightened (`cfd5dd0`).
- Pinned CI Bun version bumped from `1.1.42` to `1.3.10` (`a76f146`).
- README aligned with current implementation (`e14f7ac`).

### Fixed

- LIKE metacharacters in `ferret ls` filters are escaped; direction and
  limit semantics tightened (`40dd639`).
- `ferret ls` flag parsing and empty-set CSV output (`5e575a9`).
- `formatDate` kept UTC-consistent for custom formats (`4c33fb4`).
- OAuth callback server binds directly instead of probing first, closing
  a TOCTOU race against port collisions (`080d4b4`).
- Keychain retry allowed on transient load failures; real errors surfaced
  to the user instead of being swallowed (`fc3e27a`).
- Link error paths tightened; `connections` empty-state fixed; dead
  unlink guard removed (`2e82ebb`).
- Budget command hardened: `parseAmount`, padding, header, and export
  output (`d141ae2`).
- Tag override checks tightened; rules regex validation clarified
  (`0e77d17`).
- Octopus review feedback on PRs #21, #33, #35 (`f3ac3a3`, `6309102`,
  `a7c331b`).

### Security

- `fix(security)`: closed a SQL-validator bypass where a double-quoted
  identifier could smuggle comment tokens past the multi-statement check
  (`2f7e900`). The fix teaches `stripSqlComments` to treat double-quoted
  identifier contents as opaque (same escape rule as single-quote string
  literals), and teaches the top-level semicolon scan to respect
  double-quoted identifiers.
- Tokens resolved via `src/lib/secrets.ts` (keychain first, env fallback)
  and never persisted to the SQLite DB or logs (PRD §9.3).
- `~/.ferret/` created mode `0700`; `ferret.db` created mode `0600`;
  `config.json` written via atomic temp-rename with mode `0600`.
- OAuth callback binds `127.0.0.1` only and validates the CSRF `state`
  parameter in constant time.
- Ask loop enforces a 10-iteration cap and an 8000-char per-tool-result
  truncation to bound Claude context growth.
- CLI binary marked executable (`chmod +x src/cli.ts`) so `bun link`
  produces a directly runnable `ferret` (`324725d`).

[Unreleased]: https://github.com/Art-of-Technology/ferret/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Art-of-Technology/ferret/releases/tag/v0.1.0
