# FUDRouter — Brief Gap Register (Phase 0)

- **Date:** 2026-10-10 · **HEAD:** `32282a0`
- **Rule applied:** the brief's own instruction — *"Do not invent implementations for unavailable features"* and *"Use the existing repository as source of truth."* Every row below is graded against the code, not against the brief's prose.

Legend: **EXISTS** = in the repo and working · **PARTIAL** = present under another name/shape · **ABSENT** = no code · **CREATED** = produced by this Phase 0.

---

## A. Approved stack

| brief says | reality | grade |
|---|---|---|
| React + TypeScript | React 19.1 + TS 5.9 (`apps/react-web`) | **EXISTS** |
| Bun | **no** `bun.lock`/`bunfig` anywhere; runtime is Node `>=22.5` with npm workspaces | **ABSENT** |
| TanStack Router (file-based) | **not installed**; routing is `react-router-dom ^7.6.0`, 11 flat route modules | **ABSENT** |
| Go management API | **no management HTTP handler in Go.** Management = Express 5 (`server/admin.mjs`, ~40+ `/api/admin/*` routes) | **ABSENT** |
| Go inference gateway | `services/router` — 7 routes, SSE, 17,676 LOC | **EXISTS** |
| Rust async workflow/agent workers | **0** `Cargo.toml`, **0** `.rs` files. Workers are Node (`scripts/workers.mjs` + `scheduler.mjs`) | **ABSENT** |
| PostgreSQL | 15 migrations, 42 tables, `fudrouter` DB | **EXISTS** |
| Valkey | `ioredis` (Node) + `internal/vk`, `internal/limits` (Go) | **EXISTS** |
| Discord OAuth 2.0 | `better-auth` `socialProviders.discord` → `/api/auth/callback/discord` | **EXISTS** |

---

## B. Target root

| brief path | reality | grade |
|---|---|---|
| `apps/web` | `apps/react-web` | **PARTIAL** (rename) |
| `backend/go/cmd/api` | no Go management binary | **ABSENT** |
| `backend/go/cmd/gateway` | Go gateway exists but as `main.go` at module root, no `cmd/` | **PARTIAL** |
| `backend/go/cmd/migrate` | migrations applied by `scripts/migrate.sh` (bash + psql), not Go | **PARTIAL** |
| `backend/go/internal/{17 domains}` | **0 of 17** exist as named. 11 Go packages exist, all *technical*, not domain: `proxy, store, routing, freebuff, vk, limits, netguard, crypt, ids, cost, keys` | **ABSENT** |
| `backend/go/migrations` | `infra/migrations` | **PARTIAL** (move) |
| `backend/rust/crates/{worker,workflow,contracts}` | nothing | **ABSENT** |
| `packages/contracts` | no OpenAPI/JSON Schema source exists | **ABSENT** |
| `packages/ui` | UI is inline in `apps/react-web/src/components/{ui,reactbits}` | **PARTIAL** (not extracted) |
| `packages/config` | no shared config package | **ABSENT** |
| `infra/{containers,deploy,scripts}` | `infra/docker-compose.yml` is a stub (`services: {}`); deploy = root `ecosystem.config.cjs`; scripts = root `scripts/` + `tools/` | **PARTIAL** |
| `docs/{architecture,decisions,migration}` | did not exist | **CREATED** (this Phase 0) |
| `tests/{integration,e2e,load}` | colocated unit tests only (Go 44 files, Node 5 files) | **ABSENT** |

---

## C. Features named in the brief

| feature | evidence | grade |
|---|---|---|
| **Combos** (create/version/publish/share/execute, fallback chains, bundles, smart routing, workflow DAGs) | `grep -ril combo` → **0 files** | **ABSENT** |
| **Agents** (system + user-owned, versioned, async runs, cancellation, tool authz) | 13 `agent` hits are the **Freebuff upstream protocol** (`/api/v1/agent-runs`, `agentID: base2-free`) and PM2 env filtering — **not** a product feature | **ABSENT** |
| **Referrals** | `grep -ril referral` → **0 files** | **ABSENT** |
| **Smart routing / fallback** | Go `internal/routing` + `routing_policy` table + `request_attempt` rows | **EXISTS** (as routing, not as "Combos") |
| **Model bundles** | `model_alias` + `model_alias_target` tables | **PARTIAL** |
| **Quotas** | `rate_limit`, `budget` tables + `api_key.limits` jsonb + Go `internal/limits` + Valkey `rl:` — no dedicated quota module or API | **PARTIAL** |
| **Analytics** | `/api/admin/analytics`, `/api/admin/overview`, `usage_daily`, `usage_hourly` | **EXISTS** |
| **Metering & billing** | `request_log`, `request_attempt`, `credit_ledger` (`usage:<request id>`), `billing_account`, `invoice`, `usage_charge` | **EXISTS** |
| **Webhooks** | `webhook`, `webhook_delivery` tables + `control-lib/server/webhooks.ts` | **EXISTS** |
| **Streaming** | SSE with `http.Flusher` | **EXISTS** |
| **Chat / Playground** | `src/routes/Playground.tsx` + `server/playground.mjs` (449) + 15 `playground` refs | **EXISTS** |

---

## D. Frontend routes in the brief

| brief group | reality |
|---|---|
| Public `/, /pricing, /models, /models/:slug, /docs/*, /chat, /login, /status` | present in spirit: `Home`, `Pricing`, `Models`, `Docs`, `Playground`, `Auth`, `Status`, `Changelog` — **8 of 8 covered, different paths** |
| Member `/console/*` (api-keys, combos, billing, stats, quota, referrals, settings, chat, agents) | **no `/console/*` routes**. Exists: `dashboard.tsx`. Combos / referrals / agents have no feature to route to |
| Admin `/admin/*` (providers/:id, models, combos, agents, stats, members, api-keys, quota, cache, pricing, routing, health, audit) | `admin.tsx` + `Providers.tsx`; the rest of the admin surface exists as **Express JSON endpoints**, not as React routes |
| shared navigation registry | **ABSENT** — nav is inline in `Layout.tsx` / `DashShell.tsx` |
| `PublicLayout` / `ConsoleLayout` / `AdminLayout` | **PARTIAL** — `Layout.tsx` + `DashShell.tsx` only |
| permission-aware navigation | **PARTIAL** — `components/guards.tsx` + `lib/caps.ts` gate *routes*, not nav items |

---

## E. Contracts

| brief says | reality | grade |
|---|---|---|
| OpenAPI for management/inference HTTP APIs | none | **ABSENT** |
| JSON Schema for Combo/Agent definitions | no Combo/Agent definitions exist | **ABSENT** (blocked by §C) |
| Versioned job/result/event schemas for Go↔Rust | no Rust; `job` + `system_event` tables exist unversioned | **ABSENT** |
| Generated TypeScript API clients | hand-written `src/lib/api.ts` | **ABSENT** |
| Existing public API behavior backward compatible | no executable guard exists | **UNVERIFIED** — Phase 1 deliverable |

---

## F. What this means for sequencing

1. **Five of the brief's stack items are already true** (React+TS, Go gateway, Postgres, Valkey, Discord OAuth). More than the brief implied.
2. **Four are absent**: Bun, TanStack Router, the Go management API, Rust.
3. **Every one of `internal/{combos,agents,referrals}` and `backend/rust/**` would be an empty directory today.** The brief forbids creating them ("no unnecessary empty scaffolding") and forbids inventing the implementations ("no inventing implementations for unavailable features"). So those parts of the target root **cannot** be built in this migration; they become a prerequisite *product* workstream.
4. Therefore the migratable surface is: **layout + package boundaries + contracts + tests**, not new domains. Phase 1 must be contracts and baseline regression, exactly as the brief's own execution order says.
