# Ferret

> Ferret out where your money goes.

Personal finance CLI for the UK. Connects to your bank accounts via Open Banking, stores transactions in a local SQLite database, and lets you query them in natural language through Claude. Nothing leaves your machine except the specific questions you ask.

![status](https://img.shields.io/badge/status-alpha-orange)
![runtime](https://img.shields.io/badge/runtime-Bun%201.x-black)
![typescript](https://img.shields.io/badge/language-TypeScript-3178c6)
![license](https://img.shields.io/badge/license-MIT-green)

---

## Why

Snoop closed in 2025. GoCardless shut down free Open Banking signups the same year. The remaining options are either enterprise-priced aggregators or manual CSV wrangling.

Ferret is what's left when you want your own data, locally, without building a SaaS or paying a subscription. Transactions go into SQLite. Analysis goes through Claude. Everything runs from your terminal.

## Features

- **Multi-bank aggregation** via TrueLayer Open Banking (Lloyds, NatWest, Revolut, Monzo, HSBC, Barclays, Santander, Starling, and most other UK retail banks)
- **Local-first storage** in SQLite at `~/.ferret/ferret.db`
- **Natural language queries** powered by Claude with tool use
- **Automatic categorization** with rule engine, merchant cache, and AI fallback
- **Budget tracking** with month-over-month pace projections
- **CSV import** for banks outside Open Banking coverage
- **Secure credential handling** via OS keychain
- **Zero cloud dependencies** other than the API calls you explicitly make

## Status

Alpha. Built for personal use. Breaking changes likely until V1.

## Requirements

- [Bun](https://bun.sh) 1.1 or higher
- TrueLayer live-tier account ([console.truelayer.com](https://console.truelayer.com))
- Anthropic API key ([console.anthropic.com](https://console.anthropic.com))
- macOS or Linux (Windows via WSL)

## Install

> Demo coming soon.

Ferret is alpha software and not yet published to a registry. Install from source:

```bash
git clone https://github.com/Art-of-Technology/ferret.git
cd ferret
bun install
bun link
```

`bun link` makes the `ferret` binary available on your `PATH` from the checkout.
To run without linking, prefix any command with `bun run src/cli.ts` (e.g. `bun run src/cli.ts init`).

A published `bun install -g ferret-cli` flow is planned once V1 stabilises.

## Quick Start

**1. Initialize**

```bash
ferret init
```

Creates `~/.ferret/`, sets up the database, seeds default categories.

**2. Add credentials**

Create `~/.ferret/.env`:

```
TRUELAYER_CLIENT_ID=your_client_id
TRUELAYER_CLIENT_SECRET=your_client_secret
ANTHROPIC_API_KEY=sk-ant-...
```

**3. Link a bank**

```bash
ferret link
```

Opens your browser to authenticate with your bank. Tokens are stored in your OS keychain.

**4. Sync and explore**

```bash
ferret sync
ferret ls --since 30d
ferret ask "how much did I spend on groceries last month?"
```

## Command Reference

```
ferret init                      Set up config directory and database
ferret link                      Connect a bank account
ferret unlink <id>               Remove a connection
ferret connections               List active connections
ferret sync                      Pull latest transactions
ferret ls                        List transactions with filters
ferret tag                       Categorize uncategorized transactions
ferret rules                     Manage categorization rules
ferret ask <question>            Natural language query via Claude
ferret budget                    View or set category budgets
ferret import <file>             Import CSV from a bank statement
ferret export                    Export transactions to CSV or JSON
ferret config                    View or edit configuration
ferret version                   Print Ferret version
```

Run `ferret <command> --help` for flags and options on any command.

## Examples

**Filter recent spending:**

```bash
ferret ls --since 7d --category "Eating Out" --outgoing
```

**Set a budget:**

```bash
ferret budget set "Eating Out" 200
ferret budget
```

**Ask Claude:**

```bash
ferret ask "which subscriptions am I paying for that I haven't used in 3 months?"
ferret ask "how does my spending this quarter compare to last?"
ferret ask "find all refunds over £50 this year"
```

**Pipe into other tools:**

```bash
ferret ls --since 1y --json | jq '.[] | select(.amount < -100)'
```

**Automate with cron:**

```cron
0 7 * * * /usr/local/bin/ferret sync >> ~/.ferret/sync.log 2>&1
```

## How It Works

```
┌──────────────────────────────────────────────────────┐
│  ferret (CLI)                                        │
└────────────────────┬─────────────────────────────────┘
                     │
         ┌───────────┼────────────────┐
         │           │                │
    ┌────▼────┐ ┌────▼────┐      ┌────▼─────┐
    │TrueLayer│ │SQLite   │      │ Claude   │
    │Data API │ │~/.ferret│      │   API    │
    └─────────┘ └─────────┘      └──────────┘
```

- **TrueLayer** handles Open Banking auth and transaction retrieval
- **SQLite** stores everything locally at `~/.ferret/ferret.db`
- **Claude** answers questions via tool use, querying SQLite directly rather than receiving bulk data
- **Keychain** holds tokens, never the database, never logs

See [docs/prd.md](docs/prd.md) for the full architecture and data model.

## Configuration

`~/.ferret/config.json`:

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
  }
}
```

Edit with `ferret config set <key> <value>` or directly in the file.

## Development

```bash
# Install deps
bun install

# Run in dev mode
bun run src/cli.ts --help

# Lint and format
bun run check

# Type check
bun run typecheck

# Generate migrations after schema changes
bun run db:generate
bun run db:migrate

# Seed dev database with fake data
bun run scripts/dev-seed.ts
```

### Project Layout

```
src/
├── cli.ts              # Entry point
├── commands/           # One file per CLI command
├── services/           # TrueLayer, Claude, keychain, OAuth
├── db/                 # Schema, migrations, queries
├── lib/                # Config, dates, formatting, SQL validator
└── types/              # Domain and API types
```

Read the [PRD](docs/prd.md) before making non-trivial changes.

## Tests

```bash
# Unit + integration tests (bun's built-in runner, zero config)
bun test

# Performance benchmark — seeds 100k transactions into a temp DB and
# asserts the targets in PRD section 11.1 (ls < 200ms, etc).
bun run bench
```

The bench exits non-zero if any target is missed and runs in CI on every push so
performance regressions block merge.

## Contributing

Issues and PRs welcome. Before opening a non-trivial PR:

1. Read [docs/prd.md](docs/prd.md) — the PRD is the source of truth for scope and design.
2. Run `bun run check && bun run typecheck && bun test && bun run bench` locally.
3. Keep commits small and use conventional commit messages (`feat:`, `fix:`, `chore:`, etc).

CI runs the same checks on every push and PR via GitHub Actions
(see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)) on macOS and Linux
with a pinned Bun version.

## Security

- Tokens live in your OS keychain (via `keytar`), never in the database or config files
- Database file is `chmod 0600` on creation
- Claude queries send only what's needed; sensitive bulk exports stay local
- SQL from Claude is validated as `SELECT`-only before execution
- No telemetry, no analytics, no phone-home

If you find a security issue, please open a private security advisory rather than a public issue.

## Limitations

- UK-only (TrueLayer coverage). Other regions require different Open Banking providers.
- 90-day consent renewal per bank is a PSD2 regulatory requirement, not bypassable
- TrueLayer live tier costs apply for production data access; check their current pricing
- Claude API costs apply to `ask` and initial categorization; merchant cache keeps steady-state costs near zero
- Not a substitute for proper accounting software if you run a business

## Roadmap

- [x] Scaffolding
- [ ] TrueLayer connection and sync
- [ ] Transaction listing and filtering
- [ ] Categorization pipeline
- [ ] Natural language query
- [ ] Budget tracking
- [ ] CSV import
- [ ] Recurring subscription detection
- [ ] MCP server for Claude Desktop integration

See [docs/prd.md](docs/prd.md) section 10 for the full phase plan.

## License

MIT

## Acknowledgements

Built on [TrueLayer](https://truelayer.com), [Anthropic Claude](https://anthropic.com), [Bun](https://bun.sh), and [Drizzle ORM](https://orm.drizzle.team).

Inspired by the gap left when Snoop closed. Named after the animal with a talent for uncovering what's hidden.