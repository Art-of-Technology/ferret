# Ferret — Personal Finance CLI
## Product Requirements Document

**Version:** 0.1 (Draft)
**Owner:** S. Ferit Arslan
**Date:** April 2026
**Status:** Planning

---

## Table of Contents

1. Overview
2. Problem & Rationale
3. Scope
4. Feature Requirements
5. Technical Architecture
6. Data Model
7. CLI Surface
8. External Integrations
9. Security Model
10. Development Phases
11. Non-Functional Requirements
12. Open Questions & Risks
13. Success Metrics
14. Appendix

---

## 1. Overview

Ferret is a single-user command-line application for UK personal finance management. It connects to bank accounts via the TrueLayer Open Banking Data API, stores transactions in a local SQLite database, and enables natural-language spending analysis through the Anthropic Claude API.

The tool is intentionally CLI-first: no web UI, no mobile app, no hosted backend. All data lives on the user's machine.

**Name rationale:** "ferret out" is an English idiom meaning to uncover hidden information through persistent digging. Ferret digs through transaction data to surface spending insights.

**Primary user:** the developer who builds it. No multi-tenancy, no auth server, no shared storage.

---

## 2. Problem & Rationale

Snoop, a UK personal finance app that aggregated bank accounts and analyzed spending, was shut down in March 2025 by parent company Vanquis Banking Group. Existing users lost multi-bank spending visibility.

GoCardless Bank Account Data (formerly Nordigen), the only free aggregator accessible to non-licensed developers, closed new signups in July 2025.

Remaining aggregators (TrueLayer, Plaid, Tink) require commercial registration, FCA approval, or paid production tiers that do not suit personal use.

### Why CLI

- Lower cognitive cost for daily interaction (no context switch to browser or app)
- Trivially scriptable (cron-based sync, shell pipelines, git-backed config)
- Natural fit for LLM workflows (transactions as stdin into Claude)
- Data sovereignty: everything local, no cloud dependency, no account creation

### Why TrueLayer

The user has an existing TrueLayer live-environment access key, covering the main UK retail banks including Lloyds, NatWest, and Revolut. No additional regulatory burden for personal use of own-account data.

---

## 3. Scope

### 3.1 In-Scope (V1)

- OAuth2 connection to UK banks via TrueLayer Data API
- Transaction, balance, and account sync from connected banks
- Local SQLite storage of all financial data
- Natural-language querying via Anthropic Claude (tool-use enabled)
- Rule-based and AI-assisted transaction categorization
- Monthly budget tracking per category
- CSV import as fallback for banks not supported by TrueLayer
- Secure token storage via OS keychain
- Single-user, single-machine operation

### 3.2 Out-of-Scope (V1)

- Multi-user support
- Hosted or cloud-synced version
- Web or mobile UI
- Payment initiation (PIS scope)
- Investment tracking (stocks, crypto, ISAs)
- Tax reporting or HMRC integration
- Shared budgeting (partner or family)
- Historical market data enrichment
- Real-time notifications or webhooks

### 3.3 Future Considerations (V2+)

- Recurring subscription auto-detection
- Bill forecasting with confidence intervals
- Export to YNAB, Actual Budget, Firefly III formats
- Native MCP server exposing Ferret data to Claude Desktop / Cursor
- Multi-currency support with FX rates
- PDF bank statement parsing via OCR

---

## 4. Feature Requirements

### 4.1 Bank Connection (`ferret link`)

**User Story:** As the user, I want to connect a bank account via a one-time browser flow and have Ferret remember the connection.

**Acceptance Criteria:**

- CLI spawns an ephemeral HTTP server on a random available localhost port (8000–9999 range)
- User is redirected to TrueLayer auth dialog in the default browser
- After bank authentication, CLI captures the authorization code via the local callback
- CLI exchanges the code for access_token + refresh_token + connection metadata
- Tokens are stored in OS keychain, metadata in SQLite
- Connection expiry (90 days post-PSD2) is tracked and surfaced to user
- Command supports multiple concurrent connections (one per bank)
- State parameter is validated to prevent CSRF
- Local server auto-shuts after success or 5-minute timeout

**Edge Cases:**

- User cancels auth → CLI times out, cleans up server, returns error
- Port collision → retry with new random port up to 3 times
- TrueLayer returns error → surface error reason verbatim with context

**Provider Selection:**

- Default: `uk-oauth-all` (user picks on TrueLayer's UI)
- Optional flag: `--provider uk-ob-lloyds` for direct routing

---

### 4.2 Transaction Sync (`ferret sync`)

**User Story:** As the user, I want to fetch the latest transactions from all connected banks with one command.

**Acceptance Criteria:**

- Iterates every active connection
- For each account under each connection, fetches transactions since `last_synced_at`
- First sync pulls up to 24 months of history (or max available from bank)
- Deduplicates by `provider_transaction_id`
- Refreshes access token transparently if expired
- Updates balance on each account
- Reports summary at end: `N new, M updated, K accounts across L banks in Xs`
- Writes to `sync_log` table for audit trail
- Idempotent: re-running with no new data is a no-op
- Graceful failure: one bank failing does not abort the others

**Rate Limit Handling:**

- Respects TrueLayer rate limits (HTTP 429)
- Exponential backoff with jitter, max 3 retries per endpoint
- Per-bank retry isolation

**Flags:**

- `--connection <id>` sync only one connection
- `--since <duration>` override the automatic `last_synced_at`
- `--dry-run` fetch and report without writing

---

### 4.3 Listing & Filtering (`ferret ls`)

**User Story:** As the user, I want to view transactions with flexible filtering.

**Flags:**

- `--since <duration>` e.g., `2w`, `30d`, `2026-01-01`
- `--until <date>` upper bound
- `--category <name>` filter by category
- `--merchant <substring>` substring match on merchant name
- `--account <id|name>` specific account
- `--min <amount>` / `--max <amount>` amount bounds (absolute values)
- `--incoming` / `--outgoing` direction filter
- `--limit <n>` default 50
- `--json` machine-readable output (stable schema)
- `--csv` CSV output
- `--sort <field>` default `timestamp desc`

**Output Format:**

TTY-aware. Colored table when output is a terminal, plain text when piped, JSON/CSV when requested.

---

### 4.4 Categorization (`ferret tag`)

**User Story:** As the user, I want transactions automatically categorized by merchant and rule.

**Categorization Pipeline (in order of precedence):**

1. **Manual override** (transaction-specific assignment)
2. **Rule match** (user-defined regex → category)
3. **Merchant cache** (previously seen merchant → category)
4. **Claude classification** (new merchants, batched)
5. **Uncategorized** (fallback)

**Subcommands:**

- `ferret tag` process uncategorized transactions
- `ferret tag --retag` reclassify all (wipes `category_source='cache'|'claude'`, keeps manual)
- `ferret tag <txn_id> <category>` manual override (creates merchant cache entry)
- `ferret tag --dry-run` preview classifications without writing

**Claude Batching:**

- Max 50 transactions per API call
- Structured JSON output via Anthropic tool use
- Merchant → category map cached; subsequent identical merchants skip API

---

### 4.5 Natural Language Query (`ferret ask`)

**User Story:** As the user, I want to ask questions about my spending in plain English.

**Example Prompts:**

- `ferret ask "how much did I spend on eating out last month?"`
- `ferret ask "what were my top 5 subscriptions by cost?"`
- `ferret ask "did my grocery spending increase this quarter vs last?"`
- `ferret ask "find all refunds over £50 this year"`

**Flow:**

1. CLI starts a Claude message with a system prompt framing it as a financial analysis assistant
2. Claude is given a suite of tools (see 8.2) rather than raw data dump
3. Claude issues tool calls, CLI executes them against local DB, returns results
4. Loop until Claude produces final text response
5. Response is streamed to stdout

**Flags:**

- `--model <name>` override default model
- `--json` structured output (question, tools_used, answer)
- `--verbose` show tool calls and responses

**Safety:**

- SQL queries from Claude must be validated as SELECT-only before execution
- Max 10 tool iterations per ask to prevent runaway loops
- Per-query token cap in config

---

### 4.6 Budget Tracking (`ferret budget`)

**User Story:** As the user, I want to set monthly spending caps per category and see progress.

**Subcommands:**

- `ferret budget set <category> <amount>` define or update a budget
- `ferret budget rm <category>` remove budget
- `ferret budget` show current month progress (default view)
- `ferret budget history [--months <n>]` month-over-month view
- `ferret budget export` export budgets as JSON

**Output:**

Progress bars per category, percentage used, projected end-of-month based on days elapsed and current pace. Over-budget categories highlighted.

---

### 4.7 CSV Import (`ferret import`)

**User Story:** As the user, I want to import transaction history from CSV for banks not supported by TrueLayer.

**Acceptance Criteria:**

- Supports common UK bank CSV formats (Lloyds, NatWest, HSBC, Barclays, Santander, Revolut export)
- Format auto-detection via header signature matching
- Manual override: `--format lloyds`
- Deduplication against existing transactions via hash of (date, amount, description) when no provider ID exists
- Attaches to an existing account or creates a new "manual" account
- Preview mode: `--dry-run`

**Flags:**

- `--format <bank>` force format
- `--account <id>` attach to specific account (creates virtual "manual" account if omitted)
- `--dry-run` show what would import
- `--dedupe-strategy strict|loose` strict requires exact match, loose uses fuzzy match

---

### 4.8 Export (`ferret export`)

**User Story:** As the user, I want to export my data for backup or analysis in other tools.

**Acceptance Criteria:**

- Supports CSV and JSON output
- Date range filtering via `--since` / `--until`
- Optional category filtering
- Includes all transaction fields plus derived fields (category, source)

---

## 5. Technical Architecture

### 5.1 Stack

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | Bun 1.x | Native SQLite, fast startup, TS support, user's existing stack |
| Language | TypeScript (strict) | Type safety for financial data |
| CLI framework | citty | Modern, composable, UnJS ecosystem, bun-friendly |
| DB | SQLite (via `bun:sqlite`) | Zero-config, file-based, sufficient performance |
| ORM | drizzle-orm | Type-safe, SQL-first, small footprint |
| HTTP client | native fetch | Built into Bun, no dependency |
| Keychain | keytar | Cross-platform OS keychain |
| LLM SDK | @anthropic-ai/sdk | Official, supports tool use and streaming |
| Logging | consola | Structured, TTY-aware |
| Date | date-fns | Tree-shakeable, UTC-safe |
| Table rendering | cli-table3 | Battle-tested terminal tables |
| Color | picocolors | Lightweight, auto-disables on non-TTY |
| Testing | bun test | Zero-config, fast |
| Linter | biome | Single-tool for lint + format |

### 5.2 Component Overview

```
┌─────────────────────────────────────────────────────┐
│  CLI Entry (src/cli.ts)                             │
│  citty dispatches to command modules                │
└────────────────────┬────────────────────────────────┘
                     │
      ┌──────────────┼────────────────────────┐
      │              │                        │
┌─────▼──────┐ ┌─────▼──────┐ ┌───────────────▼─────┐
│ commands/  │ │ services/  │ │ db/                 │
│  link      │ │  truelayer │ │  schema.ts          │
│  sync      │ │  claude    │ │  client.ts          │
│  ls        │ │  keychain  │ │  migrations/        │
│  tag       │ │  oauth     │ │  queries/           │
│  ask       │ │  categorize│ │                     │
│  budget    │ │  importers/│ └─────────────────────┘
│  import    │ └──────┬─────┘            │
│  export    │        │                  │
└────────────┘        └──────────┬───────┘
                                 │
                      ┌──────────▼──────────┐
                      │ ~/.ferret/          │
                      │  ferret.db          │
                      │  config.json        │
                      │  rules.json         │
                      └─────────────────────┘
```

### 5.3 File Layout

```
ferret/
├── src/
│   ├── cli.ts                    # Entry point, citty root
│   ├── commands/
│   │   ├── init.ts
│   │   ├── link.ts
│   │   ├── unlink.ts
│   │   ├── connections.ts
│   │   ├── sync.ts
│   │   ├── ls.ts
│   │   ├── tag.ts
│   │   ├── rules.ts
│   │   ├── ask.ts
│   │   ├── budget.ts
│   │   ├── import.ts
│   │   ├── export.ts
│   │   └── config.ts
│   ├── services/
│   │   ├── truelayer.ts          # API client + token refresh
│   │   ├── oauth.ts              # Local callback server
│   │   ├── claude.ts             # Anthropic client + tool handlers
│   │   ├── keychain.ts           # Token storage
│   │   ├── categorize.ts         # Rule + cache + AI pipeline
│   │   └── importers/
│   │       ├── index.ts          # Format detection
│   │       ├── lloyds.ts
│   │       ├── natwest.ts
│   │       ├── revolut.ts
│   │       ├── hsbc.ts
│   │       ├── barclays.ts
│   │       └── santander.ts
│   ├── db/
│   │   ├── schema.ts
│   │   ├── client.ts
│   │   ├── migrations/
│   │   └── queries/
│   │       ├── transactions.ts
│   │       ├── budgets.ts
│   │       └── analytics.ts
│   ├── lib/
│   │   ├── config.ts             # ~/.ferret/config.json reader/writer
│   │   ├── dates.ts              # UTC-safe date utils, duration parsing
│   │   ├── format.ts             # Currency, table, progress bar
│   │   ├── sql-validator.ts      # SELECT-only validator for Claude tool
│   │   └── errors.ts             # Typed error classes
│   └── types/
│       ├── truelayer.ts          # API response types
│       └── domain.ts             # Internal domain types
├── tests/
│   ├── unit/
│   └── integration/
├── scripts/
│   ├── dev-seed.ts               # Populate DB with fake data for dev
│   └── bench-db.ts               # Perf testing
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── biome.json
├── README.md
└── .env.example
```

### 5.4 Configuration

**`~/.ferret/config.json`** (user-editable):

```json
{
  "currency": "GBP",
  "claude": {
    "model": "claude-opus-4-7",
    "max_context_transactions": 500,
    "max_tokens_per_ask": 4096
  },
  "sync": {
    "default_history_days": 730,
    "parallel_connections": 2
  },
  "display": {
    "date_format": "yyyy-MM-dd",
    "show_colors": true
  }
}
```

**`~/.ferret/.env`** (secrets, optional if using keychain):

```
TRUELAYER_CLIENT_ID=...
TRUELAYER_CLIENT_SECRET=...
ANTHROPIC_API_KEY=...
```

Loaded via Bun's native `.env` support. Both `TRUELAYER_CLIENT_SECRET` and `ANTHROPIC_API_KEY` can alternatively live in the keychain under service `ferret`, accounts `truelayer:client_secret` and `anthropic:api_key`.

---

## 6. Data Model

### 6.1 SQLite Schema (drizzle)

```typescript
// src/db/schema.ts
import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';

export const connections = sqliteTable('connections', {
  id: text('id').primaryKey(),                          // uuid
  providerId: text('provider_id').notNull(),            // 'uk-ob-lloyds'
  providerName: text('provider_name').notNull(),        // 'Lloyds'
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  status: text('status').notNull(),                     // active | expired | revoked
  lastSyncedAt: integer('last_synced_at', { mode: 'timestamp' }),
});

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),                          // TrueLayer account_id
  connectionId: text('connection_id').notNull().references(() => connections.id),
  accountType: text('account_type').notNull(),          // TRANSACTION | SAVINGS | CREDIT_CARD
  displayName: text('display_name').notNull(),
  iban: text('iban'),
  sortCode: text('sort_code'),
  accountNumber: text('account_number'),
  currency: text('currency').notNull(),
  balanceAvailable: real('balance_available'),
  balanceCurrent: real('balance_current'),
  balanceUpdatedAt: integer('balance_updated_at', { mode: 'timestamp' }),
  isManual: integer('is_manual', { mode: 'boolean' }).default(false),  // CSV-imported
});

export const transactions = sqliteTable('transactions', {
  id: text('id').primaryKey(),                          // provider_transaction_id or hash
  accountId: text('account_id').notNull().references(() => accounts.id),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
  amount: real('amount').notNull(),                     // negative = outflow
  currency: text('currency').notNull(),
  description: text('description').notNull(),          // raw from bank
  merchantName: text('merchant_name'),                  // normalized
  transactionType: text('transaction_type'),            // DEBIT | CREDIT | TRANSFER
  category: text('category'),
  categorySource: text('category_source'),              // manual | rule | cache | claude
  providerCategory: text('provider_category'),          // raw from bank if present
  runningBalance: real('running_balance'),
  isPending: integer('is_pending', { mode: 'boolean' }).default(false),
  metadata: text('metadata', { mode: 'json' }),         // raw provider response
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  accountTimestampIdx: index('txn_account_timestamp_idx').on(table.accountId, table.timestamp),
  categoryIdx: index('txn_category_idx').on(table.category, table.timestamp),
  merchantIdx: index('txn_merchant_idx').on(table.merchantName),
}));

export const categories = sqliteTable('categories', {
  name: text('name').primaryKey(),
  parent: text('parent'),                               // 'Food' parent of 'Groceries'
  color: text('color'),                                 // hex for terminal display
  icon: text('icon'),                                   // emoji
});

export const budgets = sqliteTable('budgets', {
  id: text('id').primaryKey(),
  category: text('category').notNull().references(() => categories.name),
  monthlyAmount: real('monthly_amount').notNull(),
  currency: text('currency').notNull(),
  startDate: integer('start_date', { mode: 'timestamp' }).notNull(),
  endDate: integer('end_date', { mode: 'timestamp' }),
});

export const rules = sqliteTable('rules', {
  id: text('id').primaryKey(),
  pattern: text('pattern').notNull(),                   // regex
  field: text('field').notNull(),                       // merchant | description
  category: text('category').notNull(),
  priority: integer('priority').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const merchantCache = sqliteTable('merchant_cache', {
  merchantNormalized: text('merchant_normalized').primaryKey(),
  category: text('category').notNull(),
  confidence: real('confidence'),
  source: text('source').notNull(),                     // claude | manual
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const syncLog = sqliteTable('sync_log', {
  id: text('id').primaryKey(),
  connectionId: text('connection_id').notNull(),
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
  status: text('status').notNull(),                     // success | failed | partial
  transactionsAdded: integer('transactions_added'),
  transactionsUpdated: integer('transactions_updated'),
  errorMessage: text('error_message'),
});
```

### 6.2 Default Category Taxonomy

Seeded on `ferret init`:

```
Housing
  ├─ Rent/Mortgage
  ├─ Utilities
  └─ Home Insurance
Food
  ├─ Groceries
  ├─ Eating Out
  └─ Takeaway
Transport
  ├─ Public Transport
  ├─ Fuel
  └─ Ride Share
Entertainment
  ├─ Subscriptions
  ├─ Events
  └─ Media
Shopping
  ├─ Clothing
  ├─ Electronics
  └─ General
Health
  ├─ Pharmacy
  ├─ Gym/Fitness
  └─ Medical
Financial
  ├─ Transfers
  ├─ Fees
  └─ Interest
Income
  ├─ Salary
  ├─ Freelance
  └─ Other
Uncategorized
```

Users can add, remove, or restructure via `ferret config` or by editing the DB directly.

---

## 7. CLI Surface

### 7.1 Command Reference

```
ferret
  init                           Initialize ~/.ferret, create DB, seed categories
  
  link [--provider <id>]         Connect a bank via OAuth
  unlink <connection-id>         Remove a connection and revoke tokens
  connections                    List active connections with expiry
  
  sync [--connection <id>]       Sync transactions
    [--since <duration>]
    [--dry-run]
  
  ls [filters]                   List transactions
    --since <duration>
    --until <date>
    --category <name>
    --merchant <pattern>
    --account <id|name>
    --min <amount> --max <amount>
    --incoming | --outgoing
    --limit <n>
    --json | --csv
    --sort <field>
  
  tag [options]                  Categorize transactions
    (no args)                    Tag uncategorized only
    --retag                      Reclassify all non-manual
    <txn_id> <category>          Manual override
    --dry-run                    Preview without writing
  
  rules
    list                         Show rules
    add <pattern> <category>     Add rule
    rm <id>                      Remove rule
  
  ask <question>                 Natural language query
    --model <name>
    --json
    --verbose
  
  budget
    set <category> <amount>      Set monthly budget
    rm <category>                Remove budget
    (no args)                    Current month view
    history [--months <n>]       Historical view
    export
  
  import <file>                  Import CSV
    --format <bank>
    --account <id>
    --dry-run
    --dedupe-strategy strict|loose
  
  export                         Export transactions
    --format csv|json
    --since <date> --until <date>
    --category <name>
  
  config                         Configuration
    get <key>
    set <key> <value>
    path                         Print config directory
  
  version
  help [command]
```

### 7.2 Exit Codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Generic error |
| 2 | Configuration error (missing keys, invalid config) |
| 3 | Authentication required (no connection, expired consent) |
| 4 | Network error |
| 5 | Rate limit hit |
| 6 | Validation error (bad user input) |
| 7 | Data integrity error (DB corruption) |

---

## 8. External Integrations

### 8.1 TrueLayer Data API

**Base URLs:**

- Auth: `https://auth.truelayer.com`
- Data: `https://api.truelayer.com/data/v1`

**OAuth Flow (`ferret link`):**

```
1. CLI picks a random available port in 8000-9999 (e.g., 8765)
2. CLI generates a 32-byte random state token, holds in memory
3. CLI starts local HTTP server listening on localhost:PORT/callback
4. CLI opens browser to:
   https://auth.truelayer.com/?
     response_type=code
     &client_id={CLIENT_ID}
     &redirect_uri=http://localhost:{PORT}/callback
     &scope=info accounts balance cards transactions offline_access
     &providers=uk-oauth-all
     &state={STATE}
5. User authenticates at bank, is redirected to localhost:PORT/callback?code=X&state=Y
6. CLI verifies state matches, exchanges code at POST /connect/token
7. Receives { access_token, refresh_token, expires_in, token_type }
8. CLI calls GET /data/v1/me to fetch provider metadata
9. Tokens → keychain, connection row → SQLite
10. CLI shuts down server, prints connection summary
```

**Token Lifecycle:**

- `access_token`: 1 hour (3600s)
- `refresh_token`: must be used within 30 days of last use to stay valid
- Overall connection: 90 days from creation (PSD2 limit)
- CLI checks `expires_at - 60s` before each request, refreshes proactively
- When `connection_expires_at` is within 7 days, `sync` prints a warning

**Endpoints Used:**

| Method | Path | Purpose |
|---|---|---|
| POST | `/connect/token` | Exchange code / refresh |
| GET | `/data/v1/me` | Provider metadata |
| GET | `/data/v1/accounts` | List accounts |
| GET | `/data/v1/accounts/{id}/balance` | Current balance |
| GET | `/data/v1/accounts/{id}/transactions?from=&to=` | Settled transactions |
| GET | `/data/v1/accounts/{id}/transactions/pending` | Pending (if supported) |
| GET | `/data/v1/cards` | Credit card accounts |
| GET | `/data/v1/cards/{id}/transactions` | Card transactions |
| GET | `/data/v1/cards/{id}/balance` | Card balance |

**Error Handling:**

- 401 Unauthorized → refresh token, retry once; on second 401 mark connection `expired`
- 429 Too Many Requests → read `Retry-After`, exponential backoff up to 3 retries
- 5xx → retry 3 times with jitter (250ms base), then fail this connection for current sync
- 403 Forbidden → mark connection needing re-consent, do not retry

### 8.2 Anthropic Claude API

**SDK:** `@anthropic-ai/sdk`

**Default Model:** `claude-opus-4-7` (overridable via config)

**Usage Patterns:**

**Categorization (batch of transactions):**

```typescript
const response = await client.messages.create({
  model: config.claude.model,
  max_tokens: 2048,
  system: `You are a financial transaction classifier.
    Given a list of bank transactions, classify each into exactly one of these categories:
    ${availableCategories.join(', ')}.
    Return only a JSON array of { transaction_id, category, confidence } objects.
    Use "Uncategorized" if unsure. Confidence is 0.0 to 1.0.`,
  messages: [{
    role: 'user',
    content: JSON.stringify(transactionsBatch),
  }],
});
```

**Natural Language Query with Tool Use:**

```typescript
const tools = [
  {
    name: 'query_transactions',
    description: 'Run a read-only SQL query against the transactions view. Must be a SELECT statement.',
    input_schema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'SELECT-only SQL query' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'get_category_summary',
    description: 'Total spending per category for a date range',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', format: 'date' },
        to: { type: 'string', format: 'date' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'get_recurring_payments',
    description: 'Detect subscriptions and recurring charges',
    input_schema: {
      type: 'object',
      properties: {
        min_occurrences: { type: 'integer', default: 3 },
      },
    },
  },
  {
    name: 'get_account_list',
    description: 'List all accounts with current balances',
    input_schema: { type: 'object', properties: {} },
  },
];
```

Claude issues tool calls, the CLI executes each against SQLite, feeds results back into the conversation. Loop continues until Claude produces a `stop_reason: 'end_turn'` response.

**Security Constraint:** `query_transactions` validates that the SQL begins with `SELECT` (case-insensitive), contains no semicolons except at the end, and does not contain `PRAGMA`, `ATTACH`, `INSERT`, `UPDATE`, `DELETE`, `DROP`, `CREATE`, `ALTER`. Use a lightweight SQL parser where feasible.

**Cost Estimate:**

- Categorization: ~$0.01 per 50 transactions at Opus pricing
- Ask query: ~$0.02–$0.05 per question depending on tool round trips
- Merchant cache means steady-state categorization cost trends to zero

---

## 9. Security Model

### 9.1 Secrets Storage

| Secret | Storage | Rationale |
|---|---|---|
| TrueLayer `access_token` | OS keychain | Short-lived but still sensitive |
| TrueLayer `refresh_token` | OS keychain | Long-lived, high value |
| TrueLayer `client_secret` | .env or keychain | User choice |
| Anthropic API key | .env or keychain | User choice |

Keychain access via `keytar`. Service name: `ferret`. Account names:

- `truelayer:{connection_id}:access`
- `truelayer:{connection_id}:refresh`
- `truelayer:client_secret`
- `anthropic:api_key`

### 9.2 Database Security

SQLite file at `~/.ferret/ferret.db`. File permissions set to `0600` (owner read/write only) on creation. No at-rest encryption by default (assumes macOS FileVault or Linux LUKS). SQLCipher support deferred to V2.

### 9.3 Logging Rules

- No tokens or secrets ever logged, even at debug level
- Account numbers displayed only as last 4 digits
- Merchant names, amounts, descriptions may be logged (user's own data, local only)
- Verbose mode only via explicit `--verbose` flag
- Logs never leave the user's machine

### 9.4 Claude API Data Handling

- Only data necessary for the specific query is sent
- `ferret ask` sends summary and lets Claude request specifics via tools, rather than dumping all transactions
- User can opt out of Claude per-command (categorization has rule-only mode)
- No persistent conversation state kept between `ask` invocations

---

## 10. Development Phases

### Phase 0: Scaffolding (Day 1)

**Deliverables:**

- `bun init` project with TypeScript strict config
- citty CLI scaffold with stub commands
- drizzle-orm setup, first migration
- `ferret init` creates `~/.ferret/`, runs migrations, seeds categories
- `ferret version` and `ferret --help`

**Exit Criteria:** `ferret init && ferret connections` runs without error, shows empty table.

---

### Phase 1: TrueLayer Connection (Day 2-3)

**Deliverables:**

- OAuth callback server (`services/oauth.ts`)
- TrueLayer API client with automatic token refresh (`services/truelayer.ts`)
- Keychain integration (`services/keychain.ts`)
- `ferret link` end-to-end
- `ferret connections` shows active connections with expiry countdown
- `ferret unlink` revokes and removes

**Exit Criteria:** User links a real bank account. Tokens persist across CLI invocations. `ferret connections` shows the connection with correct expiry.

---

### Phase 2: Transaction Sync (Day 4-5)

**Deliverables:**

- Account + transaction fetching from TrueLayer
- Deduplication logic
- `sync_log` entries
- `ferret sync` with progress output
- Balance updates on sync

**Exit Criteria:** After `ferret sync`, SQLite contains real transactions. Re-running is a no-op. Sync log shows history.

---

### Phase 3: Listing & Filtering (Day 5-6)

**Deliverables:**

- `ferret ls` with all flags
- TTY-aware table output
- `--json` and `--csv` modes
- Currency and date formatting utilities

**Exit Criteria:** `ferret ls --since 30d --outgoing --min 50` returns correct results.

---

### Phase 4: Categorization (Day 7-9)

**Deliverables:**

- Rule engine (regex matching)
- Merchant cache
- Claude batch categorization
- `ferret tag`, `ferret rules` commands
- Manual override flow

**Exit Criteria:** `ferret tag` on a fresh sync categorizes at least 70% of transactions without manual intervention.

---

### Phase 5: Natural Language Query (Day 10-11)

**Deliverables:**

- Claude tool use integration
- SQL validator (SELECT-only)
- `ferret ask` with streaming output
- Pre-aggregated summary tools

**Exit Criteria:** `ferret ask "what did I spend on groceries last month?"` returns an accurate number.

---

### Phase 6: Budgets (Day 12-13)

**Deliverables:**

- `ferret budget` subcommands
- ASCII progress bars
- Pace projection math

**Exit Criteria:** User sets budgets and sees current month progress.

---

### Phase 7: CSV Import (Day 14-15)

**Deliverables:**

- Format auto-detection
- Parsers for 3 banks initially: Lloyds, NatWest, Revolut export
- Dedupe against existing transactions
- Dry-run preview

**Exit Criteria:** User imports a Lloyds CSV without duplicating rows already in DB.

---

### Phase 8: Polish & Release (Day 16+)

**Deliverables:**

- Error messages reviewed for clarity
- README with demo GIF
- `bun install -g` works
- GitHub Actions CI (lint, test, typecheck)
- Semantic versioning + release workflow

**Exit Criteria:** Clean install on a fresh machine works without additional config.

---

## 11. Non-Functional Requirements

### 11.1 Performance

- `ferret ls` returns results in under 200ms for DBs up to 100k transactions
- `ferret sync` completes in under 30s for 3 connected banks with 90 days of new data
- `ferret ask` first token in under 3s (network-dependent)
- `ferret init` completes in under 2s

### 11.2 Reliability

- Crash during sync leaves DB consistent (per-account sync wrapped in transaction)
- Partial multi-bank failures do not invalidate already-synced banks
- CLI exits with non-zero on any error
- All file writes use atomic rename pattern

### 11.3 Offline Behavior

- `ls`, `budget`, `rules`, `config`, `export` work fully offline
- `sync`, `link`, `ask` require network; fail with clear error message mentioning the need
- No silent retries that hang the CLI

### 11.4 Portability

- macOS (primary target)
- Linux (supported)
- Windows via WSL (best effort)
- Minimum Bun version: 1.1.x

---

## 12. Open Questions & Risks

### 12.1 Open Questions

- Should pending transactions be stored with a flag, or in a separate table? (leaning toward flag column on main table)
- How to handle foreign-currency transactions on multi-currency accounts like Revolut? (store both original amount and GBP-converted amount)
- Should rules be file-based (`rules.json`) or DB-based? (leaning toward DB with import/export helpers)
- Should categorization confidence scores be surfaced in `ls`, or only in `tag`? (surface only on demand via flag)
- Cron integration documentation (launchd vs systemd vs plain cron) as first-class or as README-only?

### 12.2 Risks

| Risk | Impact | Mitigation |
|---|---|---|
| TrueLayer live tier cost exceeds personal budget | High | Monitor usage via TrueLayer console; implement monthly call cap in config |
| 90-day reconsent creates friction | Medium | Proactive 7-day warning; `ferret link --renew <connection_id>` shortcut |
| Claude API costs balloon on large DBs | Medium | Aggressive merchant caching; rule-only fallback mode |
| Bank API schema changes break parsing | Medium | Defensive parsing; store raw JSON in `metadata` for replay |
| Token leak via logs or error messages | High | Strict log allowlist; integration test ensuring no token in stderr |
| Bank CSV format changes | Low | Versioned parsers; `--format` override |
| SQLite corruption | Low | Daily backup via `ferret export`; WAL mode for durability |

---

## 13. Success Metrics

Measured against the user (self):

- Daily `ferret sync` via cron completes without intervention for 90 consecutive days
- `ferret ask` resolves at least 80% of financial questions without falling back to manual SQL
- Categorization accuracy (measured against manual corrections) stays above 85%
- Zero credentials leaked to logs, commits, or error output
- Monthly Claude API spend stays under £5 at steady state

---

## 14. Appendix

### A. Example Sessions

**First-time setup:**

```
$ ferret init
✓ Created ~/.ferret
✓ Initialized database at ~/.ferret/ferret.db
✓ Seeded 30 default categories

$ ferret link
Opening browser to TrueLayer auth...
Listening on http://localhost:8765/callback
✓ Connected: Lloyds (expires 2026-07-18)

$ ferret sync
Syncing Lloyds (1 account)...
✓ Lloyds Current Account: 847 new, 0 updated
Done in 4.2s
```

**Daily use:**

```
$ ferret ask "did I overspend on eating out this month?"
You've spent £247 on Eating Out so far this month, £47 over your £200 budget.
Your pace suggests you'll end the month at around £310 if trends continue.
Biggest contributors: Dishoom (£58), Pret (£42 across 7 visits), Franco Manca (£28).
```

**Budget view:**

```
$ ferret budget
April 2026 (day 19/30, 63% elapsed)

Groceries      ████████░░  £284 / £350   81%  projected £448 🚨
Eating Out     ███████████ £247 / £200  124%  OVER BUDGET 🚨
Transport      ███░░░░░░░  £52  / £180   29%  on pace
Entertainment  ████░░░░░░  £28  / £75    37%  on pace
Subscriptions  ██████████  £89  / £90    99%  on pace
```

### B. API Response Samples

Sanitized samples for `GET /accounts`, `GET /accounts/{id}/transactions`, `GET /accounts/{id}/balance` stored in `docs/api-samples/` in the repo. Used to drive TypeScript type generation for the service layer.

### C. Related Work & References

- TrueLayer Data API docs: https://docs.truelayer.com/docs/data-api-basics
- UK Open Banking standards: https://www.openbanking.org.uk
- Starling Bank API (reference for direct-API style): https://developer.starlingbank.com/docs
- Actual Budget (open-source reference): https://github.com/actualbudget/actual
- Firefly III (self-hosted PFM reference): https://github.com/firefly-iii/firefly-iii

---

**End of PRD**