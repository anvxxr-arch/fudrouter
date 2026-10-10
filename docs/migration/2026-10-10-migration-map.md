# FUDRouter — Migration Map (Phase 0)

- **Date:** 2026-10-10 · **HEAD:** `32282a0` when written · read-only analysis at the time.

## 0. Status — the plan has since been executed

Carried out the next day, in one line of commits. The plan below is left exactly as
written (a plan, not a record); this section is the record.

| step | state | evidence |
|---|---|---|
| Phase 2b-2 — the move to the role-first top level | done | `2d5793d`: 176 renames, 23 modified, **0 new files** |
| cutover — PM2 + crontab + the four systemd units | done | `d72e356`: `--apply` exit 0, `pm2-env-hygiene.sh` PASS |
| M1 — `packages/` is real | done | `node -e "import('@fudrouter/platform/server/ssrf.ts')"` resolves |
| M2 — real module resolution, `ts-hooks.mjs` deleted | done | `6a7c114`: the worker fleet and scheduler each processed a REAL job afterwards, which is the only proof the boot path works |
| M3 — `tools/` folded into `ops/verify/` | done | part of `2d5793d` |
| M4 — workers/scheduler as real dirs | done | part of `2d5793d` |
| M5 — Go module path | done | `go build ./...`, `go vet ./...`, `go test ./...` all clean |
| M6 — migrations → `db/migrations` | done | drizzle `out:` + `migrate.sh` follow |
| M7 — env consolidation | done, approved | `.env.console` is `PORT` alone; the 14-key effective env hashes **byte-identical** before and after |
| M8 — structure gate | done | `b2bec7f`: `ops/verify/structure.sh` wired into `npm run check` |
| naming leftovers — `fudrouter-react`, `react-web` log lines | done | `9748175` |

Deliberately still open: **V3** — fold the duplicated `control-lib` into the console.
That is a behavioural refactor of the control plane, not a layout change (§4).

---

## 1. Two candidate targets, and they conflict

The mission statement names a target root. The layout agreed in the preceding design session names a different one. They are **not** the same tree and must be reconciled before any file moves.

**Target A — as written in the mission brief (tech-first at the top):**

```
apps/web   backend/go/cmd/{api,gateway,migrate}   backend/go/internal/{identity,members,…}
backend/go/migrations   backend/rust/crates/{worker,workflow,contracts}
packages/{contracts,ui,config}   infra/{containers,deploy,scripts}
docs/{architecture,decisions,migration}   tests/{integration,e2e,load}
```

**Target B — role-first (agreed in the design session, 6 top-level dirs):**

```
apps/{console,router,workers,scheduler}   packages/<lib>   ops/ (+ops/verify/)   db/   docs/
```

Differences that must be decided, not assumed:

| question | Target A | Target B |
|---|---|---|
| backend language split | `backend/go` **and** `backend/rust` as top-level | `apps/router` (Go) only; no Rust |
| Go layout | `cmd/{api,gateway,migrate}` + 17 domain packages | `apps/router` keeps `main.go` + `internal/*` |
| shared JS/TS lib | `packages/{contracts,ui,config}` | single `packages/<lib>` |
| ops + infra | `infra/{containers,deploy,scripts}` | `ops/`, `apps/*/run.sh` |
| tests | top-level `tests/{integration,e2e,load}` | colocated |

**Recommendation:** adopt Target B's *top level* and Target A's *domain-first naming inside the Go module*. That is the only combination that satisfies both the brief's "domain-first" intent and the brief's own "no unnecessary empty scaffolding" rule — because Target A's top level implies `backend/rust/**` and 14 Go domain packages that have **no code to put in them** today (see the gap register).

---

## 2. Path map

| current | Target A | Target B (recommended) | notes |
|---|---|---|---|
| `apps/react-web` | `apps/web` | `apps/console` | SPA + Express management API |
| `services/router` | `backend/go` | `apps/router` | Go inference gateway; module path must change |
| `shared/control-lib` | `packages/…` | `packages/<lib>` | **must gain `package.json` + `exports`** or the move fixes nothing |
| `scripts/` | `infra/scripts` | `apps/{workers,scheduler}` + `ops/` | split: PM2 entrypoints vs ops |
| `tools/` | `infra/scripts` | `ops/verify/` | verification only |
| `infra/migrations` | `backend/go/migrations` | `db/migrations` | drizzle `out:` + `migrate.sh` must follow |
| `infra/docker-compose.yml` | `infra/containers` | *(delete or fold)* | currently a stub — `services: {}` |
| `ecosystem.config.cjs` | `infra/deploy` | **root** (unchanged) | moving it changes `ROOT=__dirname` and breaks all 4 cwds |
| `audit/` | `docs/…` | `docs/audit/` | sibling audit output |
| — | `backend/rust/crates/*` | *(not created)* | no Rust source exists |
| — | `packages/{contracts,ui,config}` | `packages/contracts` only, **when contracts exist** | no empty scaffolding |
| — | `tests/{integration,e2e,load}` | create when the suites exist | no empty scaffolding |

---

## 3. Ordered move plan (mechanical, reversible)

Each step is one `git mv` batch + the references it breaks, verified by the gate that already exists.

| # | step | files touched | verification | risk |
|---|---|---|---|---|
| M0 | Create a **throwaway test DB** and prove the Go suite runs green against it | none (new DB) | `go test ./... -race` | none — prerequisite |
| M1 | Make `packages/` real: `git mv shared/control-lib packages/<lib>` + write `package.json` (`private:true`, namespaced name, `exports`) | ~24 | `npm i`, then a bare `node -e "import('@fudrouter/<lib>/server/ssrf')"` | med — loader removal |
| M2 | Replace the `ts-hooks.mjs` loader with real module resolution; delete `ts-hooks.mjs` | `scripts/*.mjs`, `tools/*.mjs`, `apps/react-web/server/lib/shared-ts.mjs` | `npm run check`, worker/scheduler smoke | **high** — 3 PM2 apps boot through it |
| M3 | Merge `tools/` into the same ops surface; fix the two **absolute-path** imports | 2 | run both verifiers | low |
| M4 | Promote `workers` + `scheduler` to real dirs (entrypoint + driver) | 4 | `pm2 reload fudrouter-workers fudrouter-scheduler` | med — prod processes |
| M5 | `git mv services/router …`; update `go.mod` module path **and every internal import**; update PM2 cwd + `run.sh` | 138 Go files | `go build ./...`, `go vet ./...` | **high** — module path is in every file |
| M6 | `git mv infra/migrations …`; update drizzle `out:`, `migrate.sh`, CI apply-schema step | 3 | CI green on a fresh DB | med |
| M7 | Consolidate env: one root `.env` (shared) + one **per-app** `.env` for app-scoped values; delete `.env.react-web` + duplicate templates | 4 `run.sh` + templates | restart 4 apps, diff effective env | **high** — prod secrets |
| M8 | Fold `audit/` into docs; add the structure gate | — | gate script fails on a stray top-level dir | low |

**Ordering rule:** M0 before anything. M1+M2 together (a package with no loader change is worse than neither). M5 in its own PR. M7 last, because it touches production secrets and must be diffable in isolation.

---

## 4. Explicitly out of scope for the restructure itself

- **V3 (duplicated shared library).** The control plane re-implements `control-lib`. Converting the Express server onto the library is a *behavioural* refactor of 8,403 LOC, not a layout change. It must be its own project, gated by the contract tests from Phase 1.
- **V10 (dual schema ownership).** Giving Go a generated view of the schema is a Phase 2+ concern.
- **Any Rust work.** See ADR-0003.
- **Any new feature (Combo, Agent, Referrals).** See the gap register.

---

## 5. Rollback

Every step is a `git mv` plus text updates on one branch, so rollback is `git revert` of that step's commit — **except**:

- **M7 (env consolidation)** — the only step with an effect outside git. Rollback = restore `.env.react-web` and re-`pm2 restart fudrouter-react` from a shell that is not an agent shell (see inventory §4.2). Record the previous effective env before touching it.
- **M5 (Go module path)** — rollback is safe but re-requires a full `go build`; keep the binary at `services/router/bin/fudrouter-router` until the new path builds green.

No step in this plan drops, recreates, or rewrites a production table. No step changes a production config beyond M7 — which was approved and executed (§0).
