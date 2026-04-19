# Third Parties and Credential Rotation

Every external service Ferret touches, what data crosses the boundary, and
how to rotate the associated credentials. A single source of truth so the
information in [PRIVACY.md](../PRIVACY.md), [SECURITY.md](../SECURITY.md),
and [incident-response.md](incident-response.md) stays consistent.

Part of epic [#36](https://github.com/Art-of-Technology/ferret/issues/36)
(ISO 27001 A.15 / SOC 2 CC9).

## Register

| Service                           | Purpose                                     | Data sent                                                                 | Data received                           | Rotation                         | Privacy policy                          |
|-----------------------------------|---------------------------------------------|---------------------------------------------------------------------------|-----------------------------------------|----------------------------------|-----------------------------------------|
| TrueLayer (Open Banking)          | Bank account + transaction aggregation      | `client_id`, `client_secret`, OAuth `code`, refresh/access tokens         | Account metadata, balances, transactions| See §1                           | https://truelayer.com/privacy/          |
| Anthropic (Claude API)            | `ferret tag` categorisation, `ferret ask`   | `x-api-key` header, question + system prompt, truncated tool results      | Model response content                  | See §2                           | https://www.anthropic.com/legal/privacy |
| Apple Keychain / libsecret / WCM  | OS-level secret storage via `keytar`        | Secret names + values for service `ferret`                                | Stored secrets                          | Inherits OS login (no rotation)  | OS vendor                               |
| GitHub                            | Source hosting, CI, releases                | Git push, Actions workflow inputs                                         | Clones, Actions logs                    | See §4                           | https://docs.github.com/en/site-policy  |

The CLI's outbound HTTPS calls live in exactly two files:
`src/services/truelayer.ts` (TrueLayer) and `src/services/claude.ts`
(Anthropic). Any other service integration MUST be added here before it
ships.

## 1. TrueLayer

Ferret uses TrueLayer's Data API v1 under the user's own live-tier
credentials (PRD §2, §8.1). Scopes requested:
`info accounts balance cards transactions offline_access` (see
`DEFAULT_SCOPE` in `src/services/truelayer.ts`).

### Credentials held

- `client_id` — public-ish, not secret by itself but identifies the app.
  Resolved via `TRUELAYER_CLIENT_ID` env or keychain account
  `truelayer:client_id` (`src/lib/secrets.ts`).
- `client_secret` — secret. Resolved via `TRUELAYER_CLIENT_SECRET` env or
  keychain account `truelayer:client_secret`.
- Per-connection `access_token` + `refresh_token` — live only in the
  keychain under `truelayer:<connection_id>:access` and
  `truelayer:<connection_id>:refresh`.

### Rotation — `client_secret`

1. Sign in at https://console.truelayer.com and regenerate the secret for
   the Ferret app.
2. Update local storage. Pick the path you use:

   - Keychain:
     ```bash
     # macOS
     security add-generic-password -U -s ferret -a truelayer:client_secret -w 'new-secret'
     # Linux
     secret-tool store --label='ferret truelayer client_secret' service ferret account truelayer:client_secret
     ```
   - Or edit `~/.ferret/.env` and replace `TRUELAYER_CLIENT_SECRET=`.

3. Verify existing connections can still refresh tokens:

   ```bash
   ferret sync --dry-run
   ```

   A clean exit means the refresh path worked with the new secret. The
   TrueLayer client refreshes proactively 60s before expiry (see
   `TOKEN_REFRESH_SKEW_MS` in `src/services/truelayer.ts`).

### Rotation — per-connection refresh token

Refresh tokens cannot be renewed in place; they are reissued on a
successful refresh. If a specific token is suspected leaked:

1. `ferret remove <connection_id>` (hard delete, wipes the keychain
   entries and the transactions the token produced).
2. Revoke the underlying consent in the TrueLayer console for belt +
   braces.
3. `ferret link` to establish a new consent and a fresh refresh token.
4. `ferret sync` to re-populate transactions for that bank.

### Rotation — OAuth callback redirect URI

Only relevant if TrueLayer requires a pre-registered redirect URI. Ferret
supports a fixed port via `FERRET_OAUTH_PORT` (see `src/services/oauth.ts`
and `.env.example`). To change the registered port:

1. Set `FERRET_OAUTH_PORT=NNNN` in the shell or in `~/.ferret/.env`.
2. Register `http://localhost:NNNN/callback` in the TrueLayer app.
3. `ferret link` will bind exactly that port (and fail instead of falling
   back to a random one when the port is in use).

## 2. Anthropic

Ferret calls `POST https://api.anthropic.com/v1/messages` using the
`@anthropic-ai/sdk` header contract (`x-api-key`, `anthropic-version`
`2023-06-01`). See `src/services/claude.ts`.

### Credentials held

- `api_key` — secret. Resolved via `ANTHROPIC_API_KEY` env or keychain
  account `anthropic:api_key`.

### Rotation — API key

1. Sign in at https://console.anthropic.com/account/keys.
2. Delete the existing key (do not just disable it — deletion invalidates
   any cached copy immediately).
3. Create a new key. Copy it once; Anthropic will not show it again.
4. Update local storage:

   - Keychain:
     ```bash
     # macOS
     security add-generic-password -U -s ferret -a anthropic:api_key -w 'sk-ant-...'
     # Linux
     secret-tool store --label='ferret anthropic key' service ferret account anthropic:api_key
     ```
   - Or edit `~/.ferret/.env` and replace `ANTHROPIC_API_KEY=`.

5. Verify with a cheap round-trip:

   ```bash
   ferret ask "what is 1 + 1?"
   ```

6. Check the Anthropic usage dashboard for unexpected spend during the
   exposure window.

### Cost controls already in place

- `claude.max_tokens_per_ask` in `~/.ferret/config.json` (default 4096)
  caps tokens per call (`src/services/ask.ts::resolveMaxTokens`).
- `DEFAULT_MAX_ITERATIONS = 10` in `src/services/ask.ts` caps tool-use
  iterations per `ferret ask` invocation.
- `ferret tag --no-claude` runs the categorisation pipeline with rules
  and merchant cache only (no API calls).

## 3. OS keychain

Ferret uses `keytar`, which selects the correct backend at runtime:

- macOS: Keychain Services
- Linux: libsecret (via the Secret Service D-Bus API)
- Windows: Credential Manager

All Ferret entries live under service name `ferret` (see
`SERVICE` in `src/services/keychain.ts`). Accounts follow the convention
documented in [PRIVACY.md](../PRIVACY.md).

### Rotation

None; the keychain itself is unlocked by your OS login. To fully purge
Ferret's entries:

```bash
# macOS — delete every item under service "ferret"
security delete-generic-password -s ferret

# Linux — iterate and clear (secret-tool only clears by attributes)
for a in truelayer:client_id truelayer:client_secret anthropic:api_key; do
  secret-tool clear service ferret account "$a"
done
```

Per-connection token entries are removed automatically when you run
`ferret unlink <connection_id>` or `ferret remove <connection_id>`
(see `deleteAllForConnection` in `src/services/keychain.ts`).

## 4. GitHub

Used for source, issue tracking, and CI (`.github/workflows/ci.yml`).
Ferret itself does not call the GitHub API at runtime.

### Credentials

- Local `git` authentication — SSH key or HTTPS token, managed by you, not
  stored by Ferret.
- CI runners: none required today. The workflow runs tests and lints
  against public dependencies; if you add a signed-release step later
  (npm, GitHub Releases upload), the token should live as a GitHub
  Actions secret rather than in the repo.

### Rotation

1. Rotate the developer's personal SSH / HTTPS token in the GitHub UI
   under Settings → Developer settings.
2. Rotate any `ACTIONS_*` secrets under repo Settings → Secrets and
   variables → Actions.
3. `gh auth login` locally to refresh the CLI token.

## Adding a new third party

When you introduce a new outbound call:

1. Add a row to the register in §Register above, including the rotation
   path.
2. Update `src/services/*` with the new client and, where necessary,
   `src/lib/secrets.ts` with the new `SecretLookup` entry.
3. Update [PRIVACY.md](../PRIVACY.md) with what gets sent.
4. Update [THREAT_MODEL.md](../THREAT_MODEL.md) if the new service changes
   the set of adversaries (e.g. a new cloud service broadens the attack
   surface).
5. Add a corresponding scenario to
   [incident-response.md](incident-response.md).
