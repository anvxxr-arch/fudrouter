# FUDRouter — Architecture Inventory (Phase 0)

- **Date:** 2026-10-10
- **Subject:** the repository **as it exists**, `main` @ `32282a0`
- **Method:** read-only inspection — git, filesystem, process table, CI definitions, migrations, source reads. Nothing was moved, renamed, configured, built into production, or deployed to produce this document.

---

## 1. Live runtime state at inspection time

| item | value |
|---|---|
| branch / HEAD | `main` @ `32282a0` (2026-10-10 17:58:13 +0000) |
| working tree | **clean** (0 changes) |
| PM2 apps | 4/4 **online** — `fudrouter-router` (110223), `fudrouter-workers` (110322), `fudrouter-scheduler` (110240), `fudrouter-react` (110251) |
| Postgres | `postgre` @ 127.0.0.1:5432, application DB `fudrouter` |
| Ingress | Caddy on loopback → Cloudflare tunnel `ai.karepmuwes.my.id` |

---

## 2. Size by area

| area | language | files | LOC | role |
|---|---|---|---|---|
| `services/router` | Go 1.25 / toolchain 1.26.6 | 138 | 17,676 | inference data plane |
| `apps/react-web/server` | Node ESM | 19 | 8,403 | management API + SPA server |
| `shared/control-lib` | TypeScript | 22 | 4,977 | shared server library |
| `scripts/` | Node/bash | 13 | 1,337 | PM2 entrypoints + ops |
| `tools/` | Node/bash | 7 | 307 | verification |
| `apps/react-web/src` | React 19 + TS | 31 | — | SPA |

Go module path: `github.com/anvxxr-arch/fudrouter/services/router`.

---

## 3. Components

### 3.1 Inference data plane — `services/router` (Go)

`main.go` is **132 lines**: build mux, `http.Server`, graceful shutdown (`srv.Shutdown` 20s ⇒ PM2 `kill_timeout: 25s` is deliberately larger).

**Exact HTTP surface** (`internal/proxy/proxy.go` → `ServeMux`):

- `GET /health` — identity + DB readiness
- `GET /v1/models`, `GET /v1/models/`
- `POST /v1/chat/completions` — OpenAI shape
- `POST /v1/messages`, `POST /v1/messages/count_tokens` — Anthropic native shape
- `/v1/` catch-all → `ServeGeneric` — OpenAI-compatible passthrough

Streaming: SSE is real — `internal/proxy/anthropic.go:519` sets `Content-Type: text/event-stream` and uses `http.Flusher`.

Package sizes: `proxy` 8,880 · `store` 2,499 · `routing` 1,639 · `freebuff` 1,374 · `vk` 693 · `limits` 678 · `netguard` 256 · `crypt` 236 · `ids` 144 · `cost` 142 · `keys` 79.

> **Absent:** there is **no management/admin HTTP handler in Go**. The Go binary is **inference-only**. Identity, members, keys, billing and admin live in Express.

### 3.2 Management / control plane — `apps/react-web`

- **SPA:** React 19 + Vite 6, routing via **`react-router-dom` 7** (not TanStack Router). 11 route modules: `admin.tsx`, `Auth.tsx`, `Changelog.tsx`, `dashboard.tsx`, `Docs.tsx`, `Home.tsx`, `Models.tsx`, `Playground.tsx`, `Pricing.tsx`, `Providers.tsx`, `Status.tsx`.
- **Server:** Express **5**, `better-auth` for sessions. Auth config declares `emailAndPassword: { enabled: true }` **and `socialProviders.discord`** ⇒ **Discord OAuth 2.0 is already wired** (`/api/auth/callback/discord`).
- **Admin JSON API:** `server/admin.mjs` (2,742 lines) exposes ~40+ routes under `/api/admin/*`: overview, analytics, billing, connections, health, incidents, keys, models (+mappings/+pricing/+sync), projects, providers, requests, routing, security, settings, system, traffic, users, workspaces.
- Other surfaces: `pages.mjs` 1,746 · `public.mjs` 1,505 · `playground.mjs` 449 · `rate-limit.mjs` 34.
- Client lib: `src/lib/{api,caps,server,vitals}.ts`; route guards in `src/components/guards.tsx`; layouts `Layout.tsx`, `DashShell.tsx`.

### 3.3 Shared library — `shared/control-lib` (4,977 LOC, **no `package.json`**)

Root: `provider-catalog.ts`, `publish.ts`. `server/`: `admin-limits`, `alerts`, `audit`, `billing`, `credentials`, `id`, `jobs`, `provider-catalog-fetch`, `provider-credentials`, `publish-env`, `scheduler`, `settings`, `ssrf`, `vk`, `webhooks`, `workers`, and `db/{schema,auth.schema,index}.ts`.

Consumers: `scripts/*.mjs` and `tools/*.mjs` (through `scripts/ts-hooks.mjs` module hooks), plus `apps/react-web/server/lib/shared-ts.mjs`, a bridge that installs the same hooks for the Express process.

### 3.4 Database — 15 migrations, 42 tables

`infra/migrations/0000…0014` — drizzle-kit SQL, checked in. Spec forbids `drizzle-kit push` against any database that matters.

Tables (42): `account, alert, alert_event, api_key, audit_log, billing_account, budget, circuit_breaker, connection, credential, credit_ledger, environment, feature_flag, incident, incident_update, invoice, job, model, model_alias, model_alias_target, pricing_rule, profile, project, provider, provider_model, rate_limit, request_attempt, request_log, routing_policy, security_rule, session, system_event, system_setting, usage_daily, usage_hourly, user, verification, webhook, webhook_delivery, workspace, workspace_member, workspace_role`.

Two chains carry most of the semantics:

- **ownership:** `workspace → project → environment → api_key`
- **provider network:** `model → provider_model → connection → credential`

### 3.5 Cache / limits / coordination — Valkey

Node `ioredis ^6.0.0`; Go `internal/vk` + `internal/limits`.
Namespaces observed: `rl:{scope}:{id}:rpm`, `conc:api_key:*`, `spend:ws`, `circuit:*`, `disabled:*`, `ver:{table}`.
Fail-open by design: `vk.NewFromEnv()` reports *"disabled (VALKEY_URL not set)"* and falls back to the in-process S0 limiter.

### 3.6 Deployment

`ecosystem.config.cjs` at **repo root** declares 4 PM2 apps:

| app | cwd | script | notable env |
|---|---|---|---|
| `fudrouter-router` | `services/router` | `bash run.sh` | `ROUTER_ADDR=127.0.0.1:8100`, `ROUTER_TRUSTED_PROXIES=127.0.0.1` |
| `fudrouter-workers` | **repo root** | `bash scripts/run-workers.sh` | `WORKER_CONCURRENCY=4` |
| `fudrouter-scheduler` | **repo root** | `bash scripts/run-scheduler.sh` | — |
| `fudrouter-react` | `apps/react-web` | `bash run.sh` | `NODE_ENV=production` |

Two of four deployables have **no directory of their own** — they run from the repo root.

### 3.7 Configuration — two env files

- root `.env` → sourced by `services/router/run.sh`, `scripts/run-workers.sh`, `scripts/run-scheduler.sh`
- root `.env.react-web` → sourced by `apps/react-web/run.sh` (pins `PORT`)
- tracked templates: `.env.react-web.example` (root) and `infra/.env.example`
- the ecosystem comment explicitly forbids adding `PORT` to PM2 `env` because `.env.react-web` is sourced after PM2's env and would silently win — *"leaving two sources of truth"*

### 3.8 Tests and CI

- **Go:** 44 `*_test.go` files; DB-backed helpers in `services/router/tests/helpers.go`.
- **Node:** 5 test files (`shared-ts`, `ip`, `rbac`, `ssrf`, `rate-limit`) via `node --test`.
- **CI:** `ci.yml` — react-web job (`npm ci --workspace apps/react-web`, apply schema, build, test) and a Go job (`go vet ./...`, `go build ./...`, `govulncheck`, `go test ./... -race -v` against a CI Postgres). `typecheck.yml` — `npm ci` + `npm run check`.
- **Absent:** integration suite, E2E suite, load suite, contract tests.

### 3.9 Docs present

`docs/` holds only 12 files: `specs/`, `plans/`, `changelog/`, `decommission-log.md`. There is **no** `docs/architecture/`, `docs/decisions/`, `docs/migration/` yet; a sibling audit lives at root `audit/` (12 files).

---

## 4. Production-sensitive behavior — do not break

1. **The Go test suite writes to whatever `DATABASE_URL` names.** `tests/helpers.go` INSERTs and DELETEs, and it **refuses** the `fudrouter` database unless `FUDROUTER_ALLOW_PROD_TESTS=1`; it **fails** (never skips) when `CI` is set and `DATABASE_URL` is missing. `.env` points at the **production** database, so the documented workflow `set -a; source .env` is precisely the trap the guard closes. **Never source `.env` before running the suite; always use a throwaway DB.**
2. **PM2 env capture.** PM2 snapshots the creating client's environment into `dump.pm2` and replays it on every `resurrect`; an agent shell would leak provider API keys into every child env. Mitigated by the `filter_env` array in `ecosystem.config.cjs` and asserted by `tools/pm2-env-hygiene.sh`. Never `pm2 start` / `pm2 restart --update-env` from an agent shell.
3. **Streaming.** SSE with explicit flush; anything that buffers breaks TTFT and the `ttft_ms` column.
4. **Billing idempotency.** `credit_ledger` rows are keyed `usage:<request id>`; `request_log` is the usage ledger; `usage_charge` must stay exactly-once.
5. **Graceful drain.** Router `Shutdown` (20s) must stay under PM2 `kill_timeout: 25s`.
6. **`trustedOrigins: []` when `NODE_ENV=production`** (`server/index.mjs:404`) — flag only; changing it is a production config change requiring approval.
7. **Trusted proxy pinning.** `ROUTER_TRUSTED_PROXIES=127.0.0.1` — without it `clientIP` degrades to loopback and both the `ip_allowlist` gate and `request_log.client_ip` go blind.

---

## 5. Evidence

Read-only commands: `git log/status/rev-parse`, `find`, `grep -rn`, `wc -l`, `pm2 jlist`, plus reads of `ecosystem.config.cjs`, `package.json` (root + `apps/react-web`), `services/router/main.go`, `internal/proxy/proxy.go`, `tests/helpers.go`, `.gitignore`.

Baseline gate results: `docs/migration/2026-10-10-phase0-baseline.md`.
