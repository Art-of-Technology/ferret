# Incident Response Runbook

This runbook covers the scenarios a Ferret user is most likely to hit, with
concrete commands. Ferret is a single-user local CLI, so "incident response"
here means "what you (the operator) do at your own terminal" — there is no
on-call rotation.

Part of epic [#36](https://github.com/Art-of-Technology/ferret/issues/36)
(ISO 27001 A.16 / SOC 2 CC7).

Related documents:

- [SECURITY.md](../SECURITY.md) — how to report a vulnerability.
- [PRIVACY.md](../PRIVACY.md) — what data Ferret stores and sends.
- [THREAT_MODEL.md](../THREAT_MODEL.md) — adversaries and assumptions.
- [third-parties.md](third-parties.md) — credential rotation procedures.

## General pattern

For every incident:

1. **Contain**: revoke the compromised credential at the source
   (TrueLayer console / Anthropic console / OS keychain).
2. **Rotate**: replace the secret locally (keychain or `~/.ferret/.env`).
3. **Verify**: run a read-only Ferret command to confirm the new credential
   works.
4. **Note**: write a one-line note to your personal log (date, scenario,
   what you rotated). This is your poor-man's audit trail since Ferret has
   no org-level incident tracker.

## Scenario 1 — TrueLayer refresh/access token leaked

**Symptoms**: you found a refresh token in a shell history, a backup, a
shared dotfile repo, or an unintended clipboard paste.

**Steps**:

1. List the connections to find the affected id:

   ```bash
   ferret connections
   ```

2. Hard-delete the connection locally. This removes the connection row,
   all its accounts, its transactions, its `sync_log` entries, and its
   keychain tokens (`src/commands/remove.ts`):

   ```bash
   ferret remove <connection_id>
   ```

   If you want to preserve historical rows and only revoke tokens, use
   the soft form:

   ```bash
   ferret unlink <connection_id>
   ```

3. Revoke the underlying consent at TrueLayer's console so the leaked
   refresh token cannot obtain new access tokens even before the 90-day
   PSD2 cap expires:

   - https://console.truelayer.com

4. Re-link the bank when you are ready:

   ```bash
   ferret link
   ```

5. Sanity-check:

   ```bash
   ferret connections
   ferret sync --dry-run
   ```

## Scenario 2 — Anthropic API key leaked

**Symptoms**: key committed to a repo, pasted into a chat, or found in
a screenshot.

**Steps**:

1. Revoke the key at https://console.anthropic.com/account/keys (delete
   the affected key, not just disable it).

2. Create a new key in the same console.

3. Update Ferret's copy. Pick the storage you are using — Ferret reads
   keychain first, then the env var (`src/lib/secrets.ts`):

   - Keychain (recommended):
     ```bash
     # macOS
     security add-generic-password -s ferret -a anthropic:api_key -w 'sk-ant-...'
     # Linux (libsecret via secret-tool)
     secret-tool store --label='ferret anthropic key' service ferret account anthropic:api_key
     ```
   - Or edit `~/.ferret/.env` and replace the `ANTHROPIC_API_KEY=` line.

4. Verify with a low-cost call:

   ```bash
   ferret ask "what is 2 + 2?"
   ```

5. If the leaked key was used against a shared or public repo, force-push
   a sanitised history and check the Anthropic console's usage graph for
   a spend spike during the exposure window.

## Scenario 3 — SQLite database corrupted

**Symptoms**: `ferret ls` or `ferret sync` errors with
`SQLITE_CORRUPT` / `database disk image is malformed`, or the schema
check fails.

**Steps**:

1. Stop running commands against the DB immediately so you do not compound
   the damage. `ferret.db` runs in WAL mode (`src/db/client.ts`), so a
   `-wal` and `-shm` file may also exist next to it.

2. Copy the whole `~/.ferret/` directory somewhere safe:

   ```bash
   cp -a ~/.ferret ~/.ferret.corrupt-$(date +%F)
   ```

3. Attempt an export from the corrupt DB. If Ferret can still read most
   rows, this captures them in CSV/JSON:

   ```bash
   ferret export --format json > ~/.ferret.corrupt-backup.json || true
   ferret export --format csv  > ~/.ferret.corrupt-backup.csv  || true
   ```

4. Try to recover using SQLite's built-in dump (a corrupt page may still
   allow a logical dump):

   ```bash
   sqlite3 ~/.ferret/ferret.db ".recover" > ~/.ferret.recover.sql
   ```

5. Start fresh:

   ```bash
   rm ~/.ferret/ferret.db ~/.ferret/ferret.db-wal ~/.ferret/ferret.db-shm
   ferret init
   ```

6. Re-link each bank and `ferret sync` to pull the history back
   (TrueLayer will serve up to 24 months per PRD §4.2):

   ```bash
   ferret link
   ferret sync
   ```

7. If you had CSV imports or manual categorisations, replay them from the
   backup created in step 2.

## Scenario 4 — Claude returned a wrong number

**Symptoms**: `ferret ask` gave a figure that does not match your gut
check or what `ferret ls` shows.

**Steps**:

1. Re-run with tool-call visibility so you can see the exact SQL Claude
   used:

   ```bash
   ferret ask "..." --verbose
   ```

2. Compare Claude's reasoning to a direct `ferret ls`:

   ```bash
   ferret ls --since <range> --category <cat> --json | jq '[.[].amount] | add'
   ```

3. If the SQL looks fine but the answer is off, treat it as a model
   limitation — `ferret ask` is advisory. If the SQL was wrong (e.g.
   missed a date filter), re-phrase the question more narrowly.

4. If the SQL executed an operation that should not have been possible
   (anything other than a `SELECT`), that is a SECURITY issue — see
   [SECURITY.md](../SECURITY.md) and file a private advisory.

## Scenario 5 — Prompt-injection suspected

**Symptoms**: a transaction description or merchant name appears to have
steered Claude into calling tools with surprising input, or Claude's
response contains instructions that did not come from you.

**Steps**:

1. Re-run with `--verbose` to capture the tool-call transcript.

2. Inspect the suspect merchant row:

   ```bash
   ferret ls --merchant "<suspect substring>" --json | jq
   ```

3. Confirm the SQL validator still rejected the dangerous form by looking
   at the tool_result for an `is_error: true` block or a
   `ValidationError` message from `src/lib/sql-validator.ts`.

4. File a private security advisory per [SECURITY.md](../SECURITY.md) with
   the raw description, the question you asked, and the verbose transcript.

5. If you need to neutralise the row before a fix is available, overwrite
   the merchant via a direct DB edit or a manual categorisation
   (`ferret tag <txn_id> <category>`).

## Scenario 6 — Machine lost or stolen

**Steps**:

1. From another device, immediately:

   - Revoke every TrueLayer connection via
     https://console.truelayer.com (your consents are listed there under
     the user's app).
   - Rotate the TrueLayer `client_secret` in the same console so the
     attacker cannot re-use it even if they extract it from the lost
     device.
   - Revoke your Anthropic API key at
     https://console.anthropic.com/account/keys and mint a new one.

2. Rely on the full-disk encryption assumption (PRD §9.2):
   `~/.ferret/ferret.db` is mode `0600`, but a lost unlocked laptop is
   still a full box compromise. See
   [THREAT_MODEL.md](../THREAT_MODEL.md) § Assumptions.

3. When you provision the replacement machine:

   - Install Ferret (`bun install`, `bun link`).
   - Write new credentials into keychain or `~/.ferret/.env`.
   - `ferret init && ferret link && ferret sync`.

## Scenario 7 — Suspected secret in git history

**Symptoms**: you or a scanner found a token in a repo under your control
(Ferret's repo or your personal dotfiles).

**Steps**:

1. Immediately run the relevant rotation scenario above (1, 2, or both).

2. Rewrite history only if you can coordinate all clones — otherwise
   rotating the secret is sufficient (a leaked secret cannot be unleaked,
   but it can be made inert).

3. Re-scan with `git log -p -S<secret-snippet>` on every branch and tag.

## What to record

A minimal personal log entry per incident:

```
YYYY-MM-DD  Scenario N — <one-line summary>
            Containment: <what was revoked/removed>
            Rotation:    <what was replaced, where>
            Verification: <command run, result>
```

This is the compensating control for the "no audit log" nature of a
single-user tool.
