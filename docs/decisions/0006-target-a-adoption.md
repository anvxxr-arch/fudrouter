# ADR-0006 — Adopt Target A literal (owner decision 2026-10-11)

- **Status:** APPROVED — owner selected "Adopt Target A literal" on 2026-10-11, superseding ADR-0001/0002/0003 for layout only.
- **Date:** 2026-10-11
- **Deciders:** Dwi (owner)

## Context

Mission brief names Target A:

```
apps/web backend/go/cmd/{api,gateway,migrate} backend/go/internal/{17 domains}
backend/go/migrations backend/rust/crates/{worker,workflow,contracts}
packages/{contracts,ui,config} infra/{containers,deploy,scripts}
docs/{architecture,decisions,migration} tests/{integration,e2e,load}
```

Repo shipped Target B (role-first `apps/{console,router,workers,scheduler} + packages/* + ops/ + db/ + docs/`) with gate `ops/verify/structure.sh` enforcing it. ADR-0001 PROPOSED required approval before moves; ADR-0002 kept one Go binary; ADR-0003 forbade Rust crates; gap register shows Combos/Agents/Referrals = 0 files.

Owner explicitly selected Target A literal. Brief also says: repo is source of truth, no empty scaffolding, no invented implementations, no prod deploy without approval, stop before destructive/incompatible ops.

## Decision

1. **Target A is the authorized end-state.** Structure gate and ADRs follow it, not reverse.
2. **Incremental, verifiable, no breakage.** Each move is `git mv` + reference updates, verified by `npm run check`, `node --test packages/contracts/test/surface.test.mjs` (8 pass), `go vet ./...`, DB-backed `go test ./... -race` vs `fudrouter_test` (never prod DSN), `prod-router-drill.sh`, `pm2-env-hygiene.sh`.
3. **No invention.** `cmd/api`, `cmd/migrate`, `backend/rust/**`, `internal/{combos,agents,referrals}` land only with real code or real schemas. Dir created only in same commit as first real file. Combos/Agents/Referrals without implementation = schema/boundary + BLOCKED note, never stub logic.
4. **No prod deploy without separate approval.** `ecosystem.config.cjs` cwd/port changes land as files only; `pm2 restart/reload`, `cutover-p2b.sh`, `goose down`, `DROP/TRUNCATE` never run without explicit approval.
5. **Contracts frozen.** `packages/contracts/routes.json` (7 inference + 187 management) + `openapi/{inference,management}.yaml` + 8-test gate remain the lock. No parallel `openapi.*.json`. New schemas only for implemented payloads; Combo/Agent/job schemas deferred per ADR-0005 §4-5 until implementations exist.
6. **Runtime stays Node22+npm.** ADR-0004 holds: Bun DEFER, TanStack EVALUATE in existing app (extend `src/lib/navigation.ts` caps + `server/lib/rbac.mjs SECTION_CAPS`), never `bun test`/`bunx` installs. Suites use `node --test`; CI runs npm on node22.

## Consequences

- Positive: single authorized target, gate enforces it, layout-agnostic safety work (integration suite, DB-backed Go suite, SSE first-flush, admin/auth checks) survives either way.
- Negative: `apps/console→apps/web`, `apps/router→backend/go`, `db/migrations→backend/go/migrations` churn ~200 files + module path + PM2 cwd; rollback = `git revert` per step (M7 env + M5 module path notes in migration-map §5 hold).
- Negative: `backend/rust/**` + 14 domain dirs stay unbuilt until real code; Target A tree is partially deferred by brief's own bans.

## Deliberate deviations from Target A

Two Target A paths are **not** taken, because they are production-bound rather than
layout choices:

1. **`ops/` stays at the repo root** (Target A names `infra/scripts`). The host
   crontab entry and the four systemd farm units were already rewritten to
   `/home/dwizzy/fudrouter/ops/{backup-db,onboard-*}` by
   `ops/cutover-p2b.sh`; moving the directory stops the nightly DB backup and
   provider onboarding silently, and only a crontab edit plus
   `systemctl --user daemon-reload` outside the repo can fix it. Both CI jobs
   also call `./ops/migrate.sh`.
2. **`ecosystem.config.cjs` stays at the repo root** (Target A names
   `infra/deploy`). It derives `ROOT = __dirname`, so moving it resolves all four
   PM2 `cwd`s to `infra/deploy/*` and every app fails to start. The migration map
   §1 already pinned it root for exactly this reason.

`infra/containers/` is free to move (no host binding) and is the only part of
Target A's `infra/{containers,deploy,scripts}` that is safe to take now.

## Evidence

- Owner selection 2026-10-11; `docs/migration/2026-10-10-migration-map.md` §1 A-vs-B table; `ops/verify/structure.sh`; ADR-0001:3, ADR-0002, ADR-0003, ADR-0004:42, gap register §C/E, baseline §5.
