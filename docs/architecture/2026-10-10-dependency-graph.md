# FUDRouter — Dependency Graph and Violations (Phase 0)

- **Date:** 2026-10-10 · **HEAD:** `32282a0` · read-only inspection.

---

## 1. Workspace graph (npm)

`package.json` (root) declares:

```json
"workspaces": ["apps/*", "packages/*"]
```

Reality: `apps/*` contains exactly one member (`react-web`). **`packages/*` is declared and empty** — the second glob matches nothing.

Only workspace scripts that exist:

```
build        → npm run build --workspaces --if-present
check        → npm run check --workspaces --if-present && npm run check:shared
check:shared → tsc --noEmit -p shared/control-lib/tsconfig.json
test         → npm run test --workspaces --if-present
```

`check:shared` reaches `shared/control-lib` by **hard-coded path**, not by module resolution.

---

## 2. Node / TypeScript graph

```
apps/react-web ─┬─ better-auth, drizzle-orm, postgres, express, react, react-router-dom, uuidv7
                ├─ src/lib/server.ts, api.ts   (SPA → Express JSON API)
                └─ server/lib/shared-ts.mjs ──► ../../../../scripts/ts-hooks.mjs  (4-level relative)
                                                  └─► shared/control-lib/*  (raw TS, loaded by custom hooks)

scripts ─┬─ workers.mjs, scheduler.mjs, probe-credentials.mjs, onboard-*.mjs
         └─ ./ts-hooks.mjs ──► shared/control-lib/*
tools   ─┬─ verify-job-retention.mjs, verify-credential-cooldown.mjs
         └─ /home/dwizzy/fudrouter/scripts/ts-hooks.mjs   (ABSOLUTE path)
```

`shared/control-lib` is consumed **only through a runtime module-hook loader**, never through package resolution. There is no `package.json`, no `name`, no `exports` map.

---

## 3. Go graph

```
main.go
  └─ internal/proxy.ServeMux(p, health)
       proxy ─┬─ internal/store      (DB: pgx)
              ├─ internal/crypt      (AES-256-GCM credential envelope)
              ├─ internal/vk         (Valkey)
              ├─ internal/limits     (rate/concurrency limits)
              ├─ internal/routing    (candidate resolution)
              ├─ internal/netguard   (SSRF dial guard)
              ├─ internal/ids        (prefixed uuidv7)
              ├─ internal/cost       (micro-unit arithmetic)
              ├─ internal/keys       (api-key parse/hash)
              └─ internal/freebuff   (native Codebuff/Freebuff protocol)
```

Internal-only, no cycles observed in the import direction above. `internal/*` is compiler-enforced private to the module.

---

## 4. Infra graph

```
PM2 (ecosystem.config.cjs)
 ├─ fudrouter-router    → services/router/run.sh    → . ../../.env        → ./bin/fudrouter-router
 ├─ fudrouter-workers   → scripts/run-workers.sh    → . ./.env            → node scripts/workers.mjs
 ├─ fudrouter-scheduler → scripts/run-scheduler.sh  → . ./.env            → node scripts/scheduler.mjs
 └─ fudrouter-react     → apps/react-web/run.sh     → . ../../.env.react-web → node server/index.mjs

Postgres (127.0.0.1:5432 / fudrouter)  ← Go (pgx) and Node (drizzle/postgres)
Valkey                                  ← Go internal/vk, Node ioredis
Caddy (loopback) ─ HTTPS ─ Cloudflare tunnel ─ public host
```

---

## 5. Violations of the stated target rules

The mission statement's dependency rules are: *no circular dependencies · no direct cross-domain table access · no frontend direct database access · no secrets in frontend or worker payloads · Postgres authoritative for financial state · Valkey ephemeral only · billing/metering idempotent*.

| # | violation | evidence | severity |
|---|---|---|---|
| V1 | **Dead workspace contract.** `packages/*` declared but empty. | root `package.json:5-8` | med |
| V2 | **`shared/control-lib` is not a package.** No `package.json` / `name` / `exports`; consumed via custom loader. | `ls shared/control-lib` | high |
| V3 | **Duplicated implementation of the shared library.** The Express control plane re-implements `shared/control-lib` in four oversized `.mjs` files and imports nothing from it: duplicated SSRF guard, byte-identical AES credential envelope, validators, triplicated redaction regex, triplicated id prefixes, ~35 drizzle table copies vs the canonical schema. | `audit/findings.json:233` | high |
| V4 | **Absolute-path import.** `tools/verify-*.mjs` import `/home/dwizzy/fudrouter/scripts/ts-hooks.mjs`. Breaks on any clone, rename, or workspace root change. | `tools/verify-job-retention.mjs:12`, `tools/verify-credential-cooldown.mjs:13` | high |
| V5 | **4-level relative import** across workspace boundaries. | `apps/react-web/server/lib/shared-ts.mjs:16` | med |
| V6 | **Two deployables have no module home** — `workers` and `scheduler` run with `cwd = repo root`. | `ecosystem.config.cjs:68,95` | med |
| V7 | **Two env files, no single source of truth** (`.env`, `.env.react-web`) + two templates (`.env.react-web.example`, `infra/.env.example`). | `run.sh` files | med |
| V8 | **No contracts.** No OpenAPI document, no JSON Schema for any payload, no generated TypeScript client, no versioned job/result/event schema. | repo-wide | high |
| V9 | **No integration / E2E / load suites.** Only unit tests (Go 44 files, Node 5 files). | `.github/workflows/`, test inventory | high |
| V10 | **Cross-workspace DB schema ownership is implicit.** Both Go (`pgx`) and Node (drizzle) read the same 42 tables directly; there is no single schema module the Go side can consume. | `internal/store/*.go` vs `shared/control-lib/server/db/schema.ts` | med |
| — | No circular dependencies found in the Go import graph. | §3 | ok |
| — | No frontend direct database access found (SPA talks only to the Express JSON API). | `src/lib/*` | ok |
| — | Valkey is used for cache/limits/coord only; Postgres holds money. | §2 of inventory | ok |

---

## 6. Why this matters for the mission

V2 + V3 + V4 + V5 are the same root cause seen four ways: **there is no real package boundary**, so the shared library is simultaneously (a) not installable, (b) duplicated around, (c) reached by absolute and 4-level-relative paths. Any target layout that only *moves directories* without making `packages/*` a real, resolvable package will reproduce all four.

V8/V9 mean the "keep existing public API behavior backward compatible" requirement currently has **no executable guard** — compatibility today rests on 44 unit test files and human review.
