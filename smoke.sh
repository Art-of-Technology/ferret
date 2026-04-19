#!/usr/bin/env bash
# Smoke-test every Ferret CLI command against a throwaway HOME.
# Exits non-zero on the first failure. Live integrations (TrueLayer
# OAuth, Claude API) are exercised via --help only.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

# Throwaway HOME so the test never touches the real ~/.ferret.
TMP_HOME="$(mktemp -d -t ferret-smoke-XXXXXX)"
export HOME="$TMP_HOME"

# Per-run output buffer — avoids collisions if two smokes run concurrently
# (e.g. CI matrix). Lives under $TMP_HOME so it's cleaned up with HOME.
SMOKE_OUT="$TMP_HOME/smoke.out"

# Cleanup on exit (success or failure).
trap 'rm -rf "$TMP_HOME"' EXIT

# Colors (skip if not a TTY).
if [[ -t 1 ]]; then
  GREEN="\033[32m"; RED="\033[31m"; CYAN="\033[36m"; DIM="\033[2m"; RESET="\033[0m"
else
  GREEN=""; RED=""; CYAN=""; DIM=""; RESET=""
fi

PASS=0
FAIL=0

run() {
  local name="$1"; shift
  printf "${CYAN}▶${RESET} %-50s " "$name"
  if "$@" > "$SMOKE_OUT" 2>&1; then
    printf "%bOK%b\n" "$GREEN" "$RESET"
    PASS=$((PASS + 1))
  else
    local rc=$?
    printf "%bFAIL%b (exit %d)\n" "$RED" "$RESET" "$rc"
    printf "%b--- output ---%b\n" "$DIM" "$RESET"
    cat "$SMOKE_OUT"
    printf "%b--------------%b\n" "$DIM" "$RESET"
    FAIL=$((FAIL + 1))
  fi
}

# Allow non-zero exit (some commands exit 1 on purpose, e.g. ask without API key).
run_expect_fail() {
  local name="$1"; shift
  printf "${CYAN}▶${RESET} %-50s " "$name"
  if ! "$@" > "$SMOKE_OUT" 2>&1; then
    printf "%bOK%b %b(expected non-zero)%b\n" "$GREEN" "$RESET" "$DIM" "$RESET"
    PASS=$((PASS + 1))
  else
    printf "%bFAIL%b %b(expected non-zero, got 0)%b\n" "$RED" "$RESET" "$DIM" "$RESET"
    cat "$SMOKE_OUT"
    FAIL=$((FAIL + 1))
  fi
}

CLI="bun run src/cli.ts"

echo "Smoke directory: $TMP_HOME"
echo

# ---------------------------------------------------------------- root help
run "ferret --help"                            $CLI --help
run "ferret version"                           $CLI version

# ---------------------------------------------------------------- init
run "ferret init"                              $CLI init

# ---------------------------------------------------------------- seed dev data
run "scripts/dev-seed.ts"                      bun run scripts/dev-seed.ts

# ---------------------------------------------------------------- config
run "ferret config path"                       $CLI config path
run "ferret config get currency"               $CLI config get currency
run "ferret config set display.show_colors false" $CLI config set display.show_colors false
run "ferret config get display.show_colors"    $CLI config get display.show_colors

# ---------------------------------------------------------------- connections (no live OAuth)
run "ferret link --help"                       $CLI link --help
run "ferret unlink --help"                     $CLI unlink --help
run "ferret connections"                       $CLI connections

# ---------------------------------------------------------------- sync
# dev-seed creates a fake "seed-conn-001" so sync iterates it and tries to
# resolve TRUELAYER_CLIENT_ID — without real creds it correctly errors.
run "ferret sync --help"                       $CLI sync --help
run_expect_fail "ferret sync --dry-run (no TrueLayer creds, expect ConfigError)" $CLI sync --dry-run

# ---------------------------------------------------------------- ls
run "ferret ls --help"                         $CLI ls --help
run "ferret ls --limit 5"                      $CLI ls --limit 5
run "ferret ls --since 30d --outgoing --json"  $CLI ls --since 30d --outgoing --json
run "ferret ls --csv"                          $CLI ls --csv

# ---------------------------------------------------------------- rules
run "ferret rules --help"                      $CLI rules --help
run "ferret rules list (empty)"                $CLI rules list
run "ferret rules add Tesco -> Groceries"      $CLI rules add "^Tesco" Groceries
run "ferret rules list (one)"                  $CLI rules list

# ---------------------------------------------------------------- tag (rule + cache only, no Claude)
run "ferret tag --help"                        $CLI tag --help
run "ferret tag --no-claude --dry-run"         $CLI tag --no-claude --dry-run
run "ferret tag --no-claude"                   $CLI tag --no-claude

# ---------------------------------------------------------------- budget
run "ferret budget --help"                     $CLI budget --help
run "ferret budget set Groceries 350"          $CLI budget set Groceries 350
run "ferret budget set Eating Out 200"         $CLI budget set "Eating Out" 200
run "ferret budget"                            $CLI budget
run "ferret budget history --months 3"         $CLI budget history --months 3
run "ferret budget export"                     $CLI budget export
run "ferret budget rm Eating Out"              $CLI budget rm "Eating Out"

# ---------------------------------------------------------------- import
run "ferret import --help"                     $CLI import --help
LLOYDS_CSV="$TMP_HOME/lloyds-test.csv"
cat > "$LLOYDS_CSV" <<'CSV'
Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance
15/04/2026,DEB,30-00-00,12345678,TESCO STORES,12.50,,1234.56
14/04/2026,DEB,30-00-00,12345678,TFL TRAVEL,8.40,,1247.06
CSV
run "ferret import (lloyds, dry-run)"          $CLI import "$LLOYDS_CSV" --format lloyds --dry-run
run "ferret import (lloyds, real)"             $CLI import "$LLOYDS_CSV" --format lloyds
run "ferret import (lloyds, dedupe re-run)"    $CLI import "$LLOYDS_CSV" --format lloyds

# ---------------------------------------------------------------- export
run "ferret export --help"                     $CLI export --help
run "ferret export --format csv"               $CLI export --format csv
SINCE_ISO="$(date -u -v-30d +%Y-%m-%d 2>/dev/null || date -u -d '30 days ago' +%Y-%m-%d)"
run "ferret export --format json --since $SINCE_ISO" $CLI export --format json --since "$SINCE_ISO"

# ---------------------------------------------------------------- rules cleanup
# Extract the first UUID-shaped id from the rules table output.
RULE_ID="$($CLI rules list 2>/dev/null | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)"
if [[ -n "${RULE_ID:-}" ]]; then
  run "ferret rules rm $RULE_ID"               $CLI rules rm "$RULE_ID"
else
  printf "${CYAN}▶${RESET} %-50s ${DIM}skip (no rule id parsed)${RESET}\n" "ferret rules rm"
fi

# ---------------------------------------------------------------- ask (needs API key)
run "ferret ask --help"                        $CLI ask --help
unset ANTHROPIC_API_KEY || true
run_expect_fail "ferret ask (no API key, expect ConfigError)" $CLI ask "test"

# ---------------------------------------------------------------- summary
echo
printf "${CYAN}═══${RESET} Summary ${CYAN}═══${RESET}\n"
printf "  ${GREEN}pass:${RESET} %d\n" "$PASS"
printf "  ${RED}fail:${RESET} %d\n" "$FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
