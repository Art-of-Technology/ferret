# Security Policy

Ferret is a single-user, local-first personal-finance CLI. It has no hosted
service and no multi-tenant state. This policy covers how to report security
issues, which versions receive fixes, and what we treat as in or out of scope.

Part of epic [#36](https://github.com/Art-of-Technology/ferret/issues/36)
(ISO 27001 A.16 / SOC 2 CC7).

## Supported versions

Until a 1.0.0 release, only the latest published minor version receives
security fixes. Older minors are not patched — upgrade to the current version.

| Version      | Supported          |
|--------------|--------------------|
| 0.1.x        | Yes (latest patch) |
| < 0.1.0      | No                 |

See [CHANGELOG.md](CHANGELOG.md) for the full release history.

## Reporting a vulnerability

Please do **not** open a public GitHub issue for security reports.

Use GitHub Security Advisories for private disclosure:

- https://github.com/Art-of-Technology/ferret/security/advisories/new

Include, where possible:

- Affected version / commit SHA
- Reproduction steps or a proof-of-concept
- The threat you think it enables (token disclosure, arbitrary write to the
  user's SQLite file, SQL injection into the Claude tool path, etc.)
- Any suggested mitigation

### Response targets

These are best-effort for a personal project:

- Triage acknowledgement within **5 calendar days** of a valid report
- Fix, mitigation, or advisory for critical issues within **30 calendar days**
- Lower-severity issues: batched into the next minor release

## In scope

A report qualifies as a vulnerability when it demonstrates, against the code
in this repository:

- Disclosure or exfiltration of secrets (TrueLayer tokens, client secret,
  Anthropic API key) via logs, error messages, crash dumps, or the database
  file. Tokens are stored via `keytar` under service `ferret` and must never
  appear in plaintext anywhere else (see `src/services/keychain.ts`).
- Bypass of the SELECT-only SQL validator that fronts the Claude
  `query_transactions` tool (`src/lib/sql-validator.ts`). Any input that
  executes an `INSERT`, `UPDATE`, `DELETE`, `DROP`, `PRAGMA`, `ATTACH`,
  `DETACH`, `CREATE`, `ALTER`, `REPLACE`, `VACUUM`, `BEGIN`, `COMMIT`,
  `ROLLBACK`, `TRANSACTION`, or `SAVEPOINT` against `~/.ferret/ferret.db`
  is in scope.
- OAuth flow abuse: CSRF-state bypass against the local callback server
  (`src/services/oauth.ts`), callback responses that cause the CLI to accept
  a code obtained from a different authorization, or a path that binds the
  callback server outside `127.0.0.1`.
- Path traversal or arbitrary file write when Ferret resolves
  `~/.ferret/` via `process.env.HOME` (see `src/db/client.ts`,
  `src/lib/config.ts`).
- Prompt-injection payloads in bank transaction text that cause the Claude
  ask loop to call tools in a way the SQL validator or tool-input schema
  should have rejected.
- Supply-chain issues in the pinned dependency set (`bun.lock`) that Ferret
  actually imports at runtime.

## Out of scope

The following are not treated as vulnerabilities:

- Any attack that assumes the host is already root-compromised or that the
  user's OS keychain is already unlocked for a hostile process.
- Missing hardening features the PRD explicitly defers (e.g. at-rest
  encryption of `~/.ferret/ferret.db`; PRD §9.2 defers SQLCipher to V2 and
  assumes FileVault / LUKS).
- Cost-of-API-call issues (Anthropic or TrueLayer spend) — these are
  covered by per-query token caps and the `--no-claude` rule-only fallback,
  but running up a bill with a stolen API key is an incident, not a bug.
- Third-party-service bugs (TrueLayer, Anthropic, keytar native bindings,
  Bun, SQLite) — please report upstream.
- UI/formatting nits in terminal output.
- Issues against unreleased feature branches.

## Hardening already in place

These are implemented today and covered by tests under `tests/`:

- Tokens and the Anthropic key are resolved via `src/lib/secrets.ts`
  (keychain first, env fallback) and never written to the SQLite DB or
  logs.
- `~/.ferret/` is created with mode `0700`; `ferret.db` is `chmod 0600` on
  first creation (`src/db/client.ts`).
- `config.json` is written via atomic temp-rename with mode `0600`
  (`src/lib/config.ts`).
- The OAuth callback server binds `127.0.0.1` only, validates a
  cryptographically random `state` parameter with a constant-time
  comparison, and auto-stops after 5 minutes
  (`src/services/oauth.ts`).
- TrueLayer 401 responses trigger a single refresh attempt; a second 401
  marks the connection as needing re-consent rather than retrying
  indefinitely (`src/services/truelayer.ts`).
- The `query_transactions` SQL validator rejects multi-statement input,
  comment-smuggled forbidden tokens, and double-quoted-identifier tricks
  (see commit `2f7e900`, `src/lib/sql-validator.ts`).
- Claude tool results are truncated to 8000 characters before being fed
  back into the conversation to cap context-window growth
  (`src/services/ask.ts`).

See also:

- [PRIVACY.md](PRIVACY.md) — what data Ferret handles and where it goes.
- [THREAT_MODEL.md](THREAT_MODEL.md) — adversaries, assumptions, trust
  boundaries.
- [docs/incident-response.md](docs/incident-response.md) — what to do when
  something goes wrong.
- [docs/third-parties.md](docs/third-parties.md) — external services and
  credential rotation procedures.

## Bounty

None. Ferret is a personal open-source project with no funding.
