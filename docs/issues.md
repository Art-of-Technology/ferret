# Ferret — Issue Tracker

PRD'den ([docs/prd.md](prd.md)) türetilen GitHub issue listesi. Repo: [Art-of-Technology/ferret](https://github.com/Art-of-Technology/ferret).

İş bittikçe `[ ]` → `[x]` yapıyoruz.

## Development Phases

- [ ] [#1 — Phase 0: Project scaffolding (Bun + TS + drizzle + citty)](https://github.com/Art-of-Technology/ferret/issues/1)
- [ ] [#2 — Phase 1: TrueLayer OAuth connection (`ferret link`)](https://github.com/Art-of-Technology/ferret/issues/2)
- [ ] [#3 — Phase 2: Transaction sync (`ferret sync`)](https://github.com/Art-of-Technology/ferret/issues/3)
- [ ] [#4 — Phase 3: Listing & filtering (`ferret ls`)](https://github.com/Art-of-Technology/ferret/issues/4)
- [ ] [#5 — Phase 4: Categorization pipeline (`ferret tag`, `ferret rules`)](https://github.com/Art-of-Technology/ferret/issues/5)
- [ ] [#6 — Phase 5: Natural language query (`ferret ask`)](https://github.com/Art-of-Technology/ferret/issues/6)
- [ ] [#7 — Phase 6: Budget tracking (`ferret budget`)](https://github.com/Art-of-Technology/ferret/issues/7)
- [ ] [#8 — Phase 7: CSV import (`ferret import`)](https://github.com/Art-of-Technology/ferret/issues/8)
- [ ] [#9 — Phase 8: Polish, packaging & release](https://github.com/Art-of-Technology/ferret/issues/9)

## Cross-cutting (Security, Reliability, Performance)

- [ ] [#10 — Security: secrets storage & log allowlist (no token leak)](https://github.com/Art-of-Technology/ferret/issues/10)
- [ ] [#11 — Performance NFRs: ls <200ms, sync <30s, ask <3s first token](https://github.com/Art-of-Technology/ferret/issues/11)
- [ ] [#12 — Reliability: atomic writes + crash-safe sync transactions](https://github.com/Art-of-Technology/ferret/issues/12)

## Open Decisions

- [ ] [#13 — Pending transactions: flag column vs separate table](https://github.com/Art-of-Technology/ferret/issues/13)
- [ ] [#14 — Foreign-currency on multi-currency accounts (Revolut)](https://github.com/Art-of-Technology/ferret/issues/14)
- [ ] [#15 — Rules storage: file (`rules.json`) vs DB](https://github.com/Art-of-Technology/ferret/issues/15)
- [ ] [#16 — Cron integration docs (launchd / systemd / cron)](https://github.com/Art-of-Technology/ferret/issues/16)

## Risks

- [ ] [#17 — TrueLayer live-tier cost cap](https://github.com/Art-of-Technology/ferret/issues/17)
- [ ] [#18 — Claude API spend ceiling (target <£5/mo)](https://github.com/Art-of-Technology/ferret/issues/18)
- [ ] [#19 — 90-day PSD2 reconsent friction](https://github.com/Art-of-Technology/ferret/issues/19)

## Future (V2+)

- [ ] [#20 — SQLCipher at-rest DB encryption](https://github.com/Art-of-Technology/ferret/issues/20)
