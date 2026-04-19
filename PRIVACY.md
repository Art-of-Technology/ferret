# Privacy Notice

Ferret is a single-user command-line tool. The person running it is both the
data subject and the data controller. This document describes what Ferret
stores, where, and what (if anything) leaves the machine.

Part of epic [#36](https://github.com/Art-of-Technology/ferret/issues/36)
(ISO 27001 A.18 / SOC 2 P/C).

## Data Ferret stores locally

All persistent data lives inside `~/.ferret/` on the machine where the CLI
runs. The directory is created with mode `0700` and the SQLite database
with mode `0600` on first use (see `src/db/client.ts`, `src/lib/config.ts`).

| Data                         | Location                                  | Source                              |
|------------------------------|-------------------------------------------|-------------------------------------|
| Transactions                 | `~/.ferret/ferret.db` (`transactions`)    | TrueLayer API or CSV import         |
| Accounts + balances          | `~/.ferret/ferret.db` (`accounts`)        | TrueLayer API or CSV import         |
| Bank connections + expiry    | `~/.ferret/ferret.db` (`connections`)     | `ferret link`                       |
| Category taxonomy            | `~/.ferret/ferret.db` (`categories`)      | `ferret init` seed + user edits     |
| Category rules               | `~/.ferret/ferret.db` (`rules`)           | `ferret rules add`                  |
| Merchant cache               | `~/.ferret/ferret.db` (`merchant_cache`)  | `ferret tag` pipeline               |
| Budgets                      | `~/.ferret/ferret.db` (`budgets`)         | `ferret budget set`                 |
| Sync audit log               | `~/.ferret/ferret.db` (`sync_log`)        | `ferret sync`                       |
| User configuration           | `~/.ferret/config.json`                   | `ferret config set` / manual edits  |
| Optional secrets file        | `~/.ferret/.env`                          | Written by the user                 |

The schema is defined in `src/db/schema.ts`.

## Secrets

Secrets are held outside the database so a copy of `ferret.db` does not
expose credentials:

| Secret                          | Primary storage                                  | Fallback             |
|---------------------------------|--------------------------------------------------|----------------------|
| TrueLayer `access_token`        | OS keychain (`truelayer:<conn_id>:access`)       | — (keychain only)    |
| TrueLayer `refresh_token`       | OS keychain (`truelayer:<conn_id>:refresh`)      | — (keychain only)    |
| TrueLayer `client_secret`       | OS keychain (`truelayer:client_secret`)          | `TRUELAYER_CLIENT_SECRET` env |
| TrueLayer `client_id`           | OS keychain (`truelayer:client_id`)              | `TRUELAYER_CLIENT_ID` env |
| Anthropic API key               | OS keychain (`anthropic:api_key`)                | `ANTHROPIC_API_KEY` env |

See `src/services/keychain.ts` and `src/lib/secrets.ts`. The service name
under which entries are stored is always `ferret`.

## Data sent to third parties

Ferret makes outbound network calls in exactly two places:
`src/services/truelayer.ts` and `src/services/claude.ts`. Nothing else
contacts the network.

### TrueLayer (Open Banking aggregator)

Sent:

- Your OAuth `client_id`, `client_secret`, `refresh_token`, and the
  authorization `code` captured by the local callback server, exchanged at
  `https://auth.truelayer.com/connect/token` for fresh tokens.
- `GET` requests to `https://api.truelayer.com/data/v1/...` with a bearer
  access token: `/me`, `/accounts`, `/accounts/{id}/balance`,
  `/accounts/{id}/transactions`, `/accounts/{id}/transactions/pending`,
  `/cards`, `/cards/{id}/balance`, `/cards/{id}/transactions`.

Received:

- Account, balance, and transaction payloads for the banks you authorised.
  These are stored verbatim in the `transactions.metadata` column (JSON)
  alongside the normalised columns so reprocessing does not need a second
  API call.

Privacy policy: https://truelayer.com/privacy/

### Anthropic (Claude API)

Sent, only when the matching command is invoked:

- `ferret tag` (unless `--no-claude` is passed): batches of up to 50
  merchant/description/amount tuples via `POST /v1/messages` so Claude can
  assign a category. Batch size and the tool-use coercion are defined in
  `src/services/claude.ts`.
- `ferret ask`: the question text you type plus a short system prompt and
  the results of any tool calls the model makes. The model can call
  `query_transactions` (validated SELECT-only SQL), `get_category_summary`,
  `get_recurring_payments`, `get_account_list`, and `propose_budgets`;
  each tool's output is JSON-serialised and truncated to 8000 characters
  before being fed back into the conversation
  (`src/services/ask.ts`, `TOOL_RESULT_MAX_CHARS`).

Not sent:

- Raw TrueLayer access or refresh tokens.
- Your Anthropic API key (only used as an `x-api-key` header to
  authenticate the call itself).
- Bulk dumps of `~/.ferret/ferret.db`. The ask loop deliberately exposes
  high-level helpers and SELECT-only SQL rather than shipping rows in
  bulk (PRD §9.4).

Privacy policy: https://www.anthropic.com/legal/privacy

### Operating system keychain

Ferret reads and writes secrets via `keytar`, which calls:

- macOS Keychain Services on Darwin
- libsecret (Secret Service API) on Linux
- Windows Credential Manager on Windows

These are local OS subsystems. No network call is made.

## Data Ferret never sends anywhere

- The SQLite database file itself is never uploaded.
- The `sync_log` audit trail stays local.
- `ferret ls`, `ferret export`, `ferret budget`, `ferret rules`,
  `ferret connections`, `ferret config`, and `ferret import` work entirely
  offline (PRD §11.3).
- Telemetry, analytics, crash reporting: none. There is no phone-home
  code path in `src/`.

## Retention and deletion

Retention is fully under the user's control. Ferret does not expire
transactions itself.

To remove data:

- `ferret unlink <connection_id>` soft-revokes a connection and its
  keychain tokens but keeps historical transactions.
- `ferret unlink --all` soft-revokes every connection.
- `ferret remove <connection_id>` or `ferret remove --all` **hard-deletes**
  the connection, its accounts, its transactions, its sync-log entries,
  and its keychain tokens (`src/commands/remove.ts`). Rules, budgets,
  categories, and the merchant cache are preserved because they are
  user-authored config, not provider data.
- `rm -rf ~/.ferret` removes everything Ferret has written, including the
  database, the config, and the optional `.env`. Keychain entries under
  service `ferret` are removed with `keytar` / `security delete-generic-password`
  — see [docs/third-parties.md](docs/third-parties.md) for the exact
  commands.

## Logging

Per PRD §9.3 and confirmed by the code:

- Tokens and API keys are never logged, even with `--verbose`.
- Merchant names, amounts, and descriptions can be displayed on stdout
  or piped via `--json` / `--csv` at the user's discretion; they are the
  user's own data.
- Logs are written to stdout/stderr only. Ferret does not ship a remote
  log sink.

## Your rights

Because the data lives on your own machine, the usual "exercising your
rights" process is:

- **Access / portability**: `ferret export --format csv|json` dumps the
  normalised transaction set. A direct SQLite dump is also available via
  any SQLite client.
- **Erasure**: `ferret remove --all` followed by `rm -rf ~/.ferret` and
  revocation of third-party tokens per
  [docs/incident-response.md](docs/incident-response.md).
- **Correction**: `ferret tag <txn_id> <category>` for category overrides;
  direct edits against the DB are supported — the schema is documented in
  `src/db/schema.ts`.

## Changes

Material changes to data handling are tracked in [CHANGELOG.md](CHANGELOG.md).
Behaviour-affecting PRs update this file in the same commit.
