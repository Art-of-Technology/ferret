# Ferret — Issue Tracker

GitHub issues derived from the [PRD](prd.md). Repo: [Art-of-Technology/ferret](https://github.com/Art-of-Technology/ferret).

Tick `[ ]` → `[x]` as work lands.

## Development Phases

- [x] [#1 — Phase 0: Project scaffolding (Bun + TS + drizzle + citty)](https://github.com/Art-of-Technology/ferret/issues/1) — PR [#21](https://github.com/Art-of-Technology/ferret/pull/21)
- [x] [#2 — Phase 1: TrueLayer OAuth connection (`ferret link`)](https://github.com/Art-of-Technology/ferret/issues/2) — PR [#23](https://github.com/Art-of-Technology/ferret/pull/23)
- [x] [#3 — Phase 2: Transaction sync (`ferret sync`)](https://github.com/Art-of-Technology/ferret/issues/3) — PR [#28](https://github.com/Art-of-Technology/ferret/pull/28)
- [x] [#4 — Phase 3: Listing & filtering (`ferret ls`)](https://github.com/Art-of-Technology/ferret/issues/4) — PR [#24](https://github.com/Art-of-Technology/ferret/pull/24)
- [x] [#5 — Phase 4: Categorization pipeline (`ferret tag`, `ferret rules`)](https://github.com/Art-of-Technology/ferret/issues/5) — PR [#29](https://github.com/Art-of-Technology/ferret/pull/29)
- [x] [#6 — Phase 5: Natural language query (`ferret ask`)](https://github.com/Art-of-Technology/ferret/issues/6) — PR [#31](https://github.com/Art-of-Technology/ferret/pull/31)
- [x] [#7 — Phase 6: Budget tracking (`ferret budget`)](https://github.com/Art-of-Technology/ferret/issues/7) — PR [#22](https://github.com/Art-of-Technology/ferret/pull/22)
- [x] [#8 — Phase 7: CSV import (`ferret import`)](https://github.com/Art-of-Technology/ferret/issues/8) — PR [#25](https://github.com/Art-of-Technology/ferret/pull/25)
- [x] [#9 — Phase 8: Polish, packaging & release](https://github.com/Art-of-Technology/ferret/issues/9) — PR [#30](https://github.com/Art-of-Technology/ferret/pull/30)

## Cross-cutting (Security, Reliability, Performance)

- [ ] [#10 — Security: secrets storage & log allowlist (no token leak)](https://github.com/Art-of-Technology/ferret/issues/10) — partially addressed: keychain (#23), no-key-log (#29), SQL validator + double-quote bypass fix (#31). Integration test still needed.
- [x] [#11 — Performance NFRs: ls <200ms, sync <30s, ask <3s first token](https://github.com/Art-of-Technology/ferret/issues/11) — PR [#30](https://github.com/Art-of-Technology/ferret/pull/30) (bench script: ls 24ms vs 200ms budget)
- [x] [#12 — Reliability: atomic writes + crash-safe sync transactions](https://github.com/Art-of-Technology/ferret/issues/12) — PR [#28](https://github.com/Art-of-Technology/ferret/pull/28) (per-account `db.transaction`)

## Open Decisions

- [x] [#13 — Pending transactions: flag column vs separate table](https://github.com/Art-of-Technology/ferret/issues/13) — flag column (`is_pending` on `transactions`)
- [ ] [#14 — Foreign-currency on multi-currency accounts (Revolut)](https://github.com/Art-of-Technology/ferret/issues/14) — V1 ships PRD's single `amount`+`currency` schema; multi-currency deferred
- [x] [#15 — Rules storage: file (`rules.json`) vs DB](https://github.com/Art-of-Technology/ferret/issues/15) — DB (`rules` table)
- [ ] [#16 — Cron integration docs (launchd / systemd / cron)](https://github.com/Art-of-Technology/ferret/issues/16) — README-only for now; first-class command not implemented

## Risks

- [ ] [#17 — TrueLayer live-tier cost cap](https://github.com/Art-of-Technology/ferret/issues/17)
- [ ] [#18 — Claude API spend ceiling (target <£5/mo)](https://github.com/Art-of-Technology/ferret/issues/18) — `--no-claude` rule-only fallback added (#29); per-query token cap (#31). Local spend tracking still missing.
- [ ] [#19 — 90-day PSD2 reconsent friction](https://github.com/Art-of-Technology/ferret/issues/19) — `<7d` warning added (#23, #28); `--renew` shortcut not implemented

## Future (V2+)

- [ ] [#20 — SQLCipher at-rest DB encryption](https://github.com/Art-of-Technology/ferret/issues/20)

## V1 Follow-ups (opened during development)

- [ ] [#26 — Validate Barclays CSV importer against real export](https://github.com/Art-of-Technology/ferret/issues/26)
- [ ] [#27 — Validate HSBC CSV importer against real export](https://github.com/Art-of-Technology/ferret/issues/27)
- [ ] [#32 — ask-cmd integration tests skip in CI: `process.stdout.write` patch bypassed](https://github.com/Art-of-Technology/ferret/issues/32)

---

**V1 status:** 9/9 development phases merged (PRs #21–#31, gap = follow-up issues #26, #27). Cross-cutting performance (#11) and reliability (#12) closed. Decisions: 2/4 implemented, 2 deferred. Risks and V2 tracked.
