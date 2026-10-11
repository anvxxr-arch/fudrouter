# Repository Guidelines

Operating guide for AI assistants working in this repo. It is deliberately short on
things the code already says and long on things that will bite you.

- **What this is**: a commercial AI router — one API key, many upstream model
  providers, with per-request metering, limits and an auditable ledger.
- **Human-facing overview**: `README.md`. **Design rationale**: `DESIGN.md`.
  **Authorized end-state layout**: `docs/decisions/0006-target-a-adoption.md`
  (the only APPROVED ADR; 0001–0005 are PROPOSED). Read those; this file does not
  repeat them.

## Architecture & data flow

Two stateless planes over one Postgres, plus Valkey for counters/caches only.

| Plane | Path | Port | Owns |
|---|---|---|---|
| Control | `apps/web` — React 19 SPA (Vite) + Express 5 server | 3002 | UI, auth, billing, admin |
| Data | `backend/go` — Go 1.25, `cmd/gateway` | 8100 | `/v1/*` hot path |
| Jobs | `apps/workers`, `apps/scheduler` (Node) | — | Postgres job queue (`FOR UPDATE SKIP LOCKED`) |

The control plane is **not** a security boundary for the hot path. Go
re-authenticates API keys, re-resolves limits and re-guards SSRF independently, so
a compromised console cannot mint traffic the router accepts
(`backend/go/internal/proxy/auth.go:14-21`).

**Inference request** (`/v1/chat/completions`): `proxy.ServeMux` → `lifecycle.begin`
(sets `x-fudrouter-request-id` on *every* response) → `authenticate` (Bearer wins,
else `x-api-key`; sha256 compare) → key-policy gates → `EffectiveLimits`
(platform→workspace→project→environment→api_key MIN, 60s cache) → `limiter.Check`
(Valkey `rl:`/`conc:`, in-process fallback, fail-open on cache error) →
`checkBudgets` (402 `INSUFFICIENT_CREDITS`) → `ResolveModel` → `Candidates`
(capability filter in SQL) → `routing.Filter`/`Select` → `routing.Execute` walks
candidates, rotating each connection's credential pool (round-robin,
`maxPickAttempts=20`, `failCooldown=5m`) → `streamSSE` (first-event TTFT) or
`serveBuffered` → `defer lc.finish()` writes `request_log` + `usage_charge` in one
tx with an idempotency key, then one `request_attempt` per attempt.

**Dashboard load**: Caddy → Express on `PORT` → SPA boot → `RequireAuth` →
`GET /api/auth/get-session` → page `useLoad` → `/api/pages/...` → `wrap()` runs the
handler inside an `AsyncLocalStorage` carrying the proxy-aware client IP, then
`mustAuth` → `mustWorkspace` → raw `sql` via `db.execute`. Mutations write an
`audit_log` row through `writeAudit` (secrets redacted).

**Playground** is the only path that crosses planes: Express mints a 5-minute
`sk-ar-` run key, POSTs `stream:true` to Go, relays SSE byte-for-byte, appends one
`event: metrics` frame read back from `request_log`, and always reclaims the key
(`apps/web/server/playground.mjs`).

## Key directories

| Path | Purpose |
|---|---|
| `apps/web/src/` | SPA: `routes/`, `components/`, `lib/`, `components/ui/` |
| `apps/web/server/` | Express: `index.mjs` (entry), `admin.mjs`, `pages.mjs`, `public.mjs`, `playground.mjs`, `lib/` |
| `packages/platform/` | Shared domain/persistence/jobs library, loaded at **runtime** as TS |
| `packages/contracts/` | The frozen public surface: `routes.json` + `openapi/*.yaml` + 8-test gate |
| `backend/go/internal/` | `proxy`, `store`, `routing`, `crypt`, `keys`, `limits`, `netguard`, `cost`, `vk`, `ids`, `freebuff` |
| `backend/go/migrations/` | The only migration path (`ops/migrate.sh`) |
| `ops/` | Operations scripts + `ops/verify/` gates. **Must stay at repo root** (crontab + 4 systemd units reference it) |
| `docs/decisions/` | ADRs. `docs/migration/` migration map + baseline. `docs/specs/` PRD |

## Development commands

```sh
# Install — prefix NODE_ENV=development, or npm silently empties node_modules
NODE_ENV=development npm ci

# The single gate CI runs (typecheck + contract staleness + layout gate)
npm run check

# Node tests (unit + integration; integration skips without DATABASE_URL)
npm test
npm test --workspace apps/web
node --test apps/web/server/lib/rbac.test.mjs   # one file

# Contracts
npm run check -w @fudrouter/contracts
npm test  -w @fudrouter/contracts

# Go (needs a throwaway DB)
cd backend/go && go vet ./... && go build ./... && go test ./... -race
env -u DATABASE_URL go test ./... -count=1        # unit-only, DB tests skip

# Migrations — the ONLY path. Never drizzle-kit.
DATABASE_URL=postgres://... ops/migrate.sh [status]

# Layout gate alone
bash ops/verify/structure.sh
```

Scratch DB (the `fudrouter` role has **no** createdb right — `createdb -T` fails):

```sh
docker exec postgres-hardened psql -U postgres -d postgres \
  -c "create database fudrouter_test owner fudrouter"
export DATABASE_URL=postgres://fudrouter:fudrouter@127.0.0.1:5432/fudrouter_test
./ops/migrate.sh
```

## Runtime & tooling constraints

- **npm only.** Never bun, never pnpm — a third lockfile "silently wins on some
  machines and installs a different tree than CI does" (`.gitignore:16-25`).
  Never `bun test` / `bunx` installs.
- **Node ≥ 22.18** functionally (`engines` says `>=22.5`, but the workers,
  scheduler and Express bridge load `packages/platform/**/*.ts` under plain
  `node`, which needs native type stripping).
- **Go toolchain must match CI**: `toolchain go1.26.9` in `go.mod` ↔
  `go-version: "1.26.9"` in `.github/workflows/ci.yml`. CI once pinned 1.23 and
  "built a different compiler than the one the binary ships".
- **`NODE_ENV=production` is exported in the homeserver shell** and npm reads it as
  `omit=dev`. Every `apps/web` dependency is a devDependency, so a bare
  `npm install`/`ci` silently empties `node_modules` while exiting 0. Always prefix
  `NODE_ENV=development`.
- **`--if-present` is banned in CI scripts** — an absent script would silently pass.
- Ports: web 3000 / console 3002, router 8100, Valkey 6379. Never bind
  `8011 8012 443 5432 5433 8080 8443 9177`.
- PM2 process names: `fudrouter-router`, `fudrouter-workers`,
  `fudrouter-scheduler`, `fudrouter-console`.

## Code conventions

**Naming.** Files lower-case and purpose-named (`index.mjs`, `pages.mjs`,
`rate-limit.mjs`); server helpers `lib/<topic>.mjs`; private helpers `_`-prefixed
(`_rowsOf`, `_vkSend`, `_sanitizeAudit`) — the prefix is what the platform bridge
re-exports under. React PascalCase per component. Go idiomatic lower-case packages,
one concern each. DB `snake_case` in SQL, `camelCase` in Drizzle. IDs are
`<prefix>_<uuidv7>` from one canonical table.

**Comments are justificatory, not descriptive.** This is the dominant convention and
it is unusual: a comment names the bug that was fixed, the alternative rejected, and
why the current shape is load-bearing. Match it. Examples to read first:
`apps/web/server/rate-limit.mjs:1-12`, `apps/web/server/lib/ip.mjs:1-14`,
`packages/platform/rbac.ts:1-21`, `backend/go/internal/netguard.go:1-22`,
`backend/go/internal/cost/cost.go:1-18`.

**Error handling — one idiom per plane.** Node: `HttpError(status, message)` thrown
from helpers, unwrapped by `wrap()`/`handler()`/`poster()` which map it to
`{error: message}` and everything else to a logged 500 with a generic body. Go: the
PRD §88 taxonomy — `errTable` maps each code to `{Code, Status, Type, Message}` and
one `writeErr` emits `{error:{message,type,code}}`. Raw upstream text goes to
`request_log.error` only, never to the client.

**DI is explicit constructor/parameter passing, no container.** Go:
`proxy.New(store, crypt, client, refresher, vk)`. Node: Express routers are
`register*(app, ctx)` functions receiving dependencies as a ctx object, all
registered from `index.mjs` — there is no `app.use('/api/admin', router)` mounting,
which is why the route extractor records mounts separately.

**Async.** Node `async`/`await` with `Promise.all` for independent reads; long-lived
loops are explicit `while (running)` with injectable sleep and a `stop()` that
drains in-flight work. Go uses context propagation and `sync.Map`/`sync.RWMutex`
for the pool registry and hard-limit cache.

**Pure rule vs env read are deliberately split** (`publish.ts` +
`server/publish-env.ts`) so the rule stays unit-testable. Keep that split.

**Navigation is one registry.** `apps/web/src/lib/navigation.ts` holds
`PUBLIC_NAV`/`CONSOLE_NAV`/`ADMIN_NAV` plus `filterNav`, which *hides* items and
never grants access. Guards live in `src/components/guards.tsx` and
`src/lib/caps.ts` (`ROUTE_CAPS`, longest-prefix `requiredCap`). Never duplicate nav
per page.

## Testing & QA

- **Node**: built-in `node:test` + `node:assert/strict`. No jest/vitest/mocha, no
  mocking framework. HTTP is exercised with real `fetch`/`node:http`, DB with real
  Postgres. Unit tests are co-located (`rbac.mjs` → `rbac.test.mjs`); integration
  lives in `apps/web/tests/integration/` with a shared `harness.mjs`.
- **Go**: stdlib `testing` only, table-driven with `t.Run` subtests, `t.Helper()` on
  every helper, external test packages (`package proxy_test`) plus `export_test.go`
  to expose unexported knobs without shipping them.
- **Test files open with a rationale header** explaining why the test exists and
  what bug it prevents, citing the incident/ADR/spec/line. Match this style.
- **A gate must be seen to fail.** `packages/contracts/README.md:74-77` records that
  removing one route turns 2 of 8 tests red; `surface_test.go:76` says "Verified by
  mutation." Do not add a test that cannot fail.
- **Never run the DB-backed suites against the production DSN.** Both
  `backend/go/tests/helpers.go` and `apps/web/tests/integration/harness.mjs` refuse
  a database named `fudrouter` unless `FUDROUTER_ALLOW_PROD_TESTS=1`, and **fail**
  (never skip) when `CI` is set and `DATABASE_URL` is absent. Never `source .env`
  before running the suite — its `DATABASE_URL` points at production.
- **The integration server is a subprocess, never an import** — `index.mjs` calls
  `app.listen` at import time, so importing it binds a port as a side effect. It
  always runs with `NODE_ENV=test`, because production sets `trustedOrigins: []`
  and rejects the test origin.
- **Skip gating is module-scope, never `test.before`** — a `t.Skip` in a before-hook
  throws in Node 22 and reports failures instead of skips.
- **`fetch` cannot send a `Host` header** (forbidden header name, silently dropped),
  so origin tests drop to `node:http.request`. A test written with `fetch` there
  would pass no matter what the server did.
- **Without `DATABASE_URL` only 178 assertions run** (vs 272 with a DB) — DB-backed
  tests skip silently, so a green local run proves less than it looks.
- `FUDROUTER_SLOW_POOL_TESTS=1` gates the pool-walk bounds tests; one walks a
  663-account pool and genuinely costs ~100s. Gated, not trimmed.
- No coverage tooling or threshold exists. Do not add one as a side effect.

## Load-bearing rules (violating these breaks production)

**Migrations**
- `ops/migrate.sh` is the ONLY path. Never `drizzle-kit push`/`migrate` — the
  journal only knew 0000–0003 and silently skipped 0004/0005.
- **`0010_platform_status_narrow.sql` is GATED — do not apply it.** It narrows the
  status CHECKs while writers still emit `active`/`dev`/`inactive`, so applying it
  alone makes every live insert die on `check_violation` and the public catalog go
  dark. It must land in the SAME commit that flips every writer +
  `publish.ts` `reachability()` + the mirrored SQL in `backend/go/internal/store`.
- Run migrations as the **app role**, not the superuser, or tables end up owned by
  `postgres` and the app gets "permission denied for table" on its first write.
- `schema_migration` baseline backfill: an empty `schema_migration` + an existing
  `api_key` table gets 0000–0005 recorded as applied, because the live DB was shaped
  by `drizzle-kit push` and has no bookkeeping.

**Secrets & environment**
- **Never hardcode the Valkey endpoint.** `VALKEY_URL` is configuration; the shared
  host-native instance is systemd `valkey-server` on `127.0.0.1:6379` DB 1.
  `valkey_dev` is the literal placeholder from `infra/.env.example` and once got
  copied into the live env — a *wrong* password degrades open and enforces nothing,
  which is strictly worse than *no* password.
- **`CREDENTIALS_MASTER_KEY` must be identical across router, workers and
  scheduler** — every `credentials_enc` blob is AES-256-GCM under it.
  `CREDENTIALS_MASTER_KEY_PREV` is rotation-window only.
- **Never `pm2 start` / `pm2 restart --update-env` from an agent shell.** PM2
  captures the creating client's environment into `~/.pm2/dump.pm2` and replays it
  on `pm2 resurrect` forever. `filter_env` must be an **ARRAY, never `true`** — PM2
  tests `app.filter_env.length`, and a boolean is `undefined`, so the filter branch
  is skipped and the full client env (provider keys included) is used. The specific
  casualty was `ROUTER_ALLOW_DEV_PROVIDERS` leaking into the router env and silently
  opening the dev-provider gate in production. Run
  `ops/verify/pm2-env-hygiene.sh` after any deploy.
- `dump.pm2` / `dump.pm2.bak` must be mode 600 — they legitimately hold
  `DATABASE_URL`, `VALKEY_URL`, `CREDENTIALS_MASTER_KEY`.
- **Do not add `PORT` to the PM2 `env` block for the console** — `.env.console` is
  sourced after PM2's env and would silently win, leaving two sources of truth.
- `ROUTER_TRUSTED_PROXIES` fails CLOSED when unset (XFF ignored, `client_ip` records
  `RemoteAddr`). Correct for a direct deployment, wrong behind the cloudflared
  tunnel. Loopback only, never a public/Cloudflare IP.
- `ROUTER_ALLOW_DEV_PROVIDERS` must stay unset in production, and must be set
  identically in BOTH the router and the console or the two disagree about which
  slugs are reachable.

**Layout**
- **No new top-level dirs/files without an ADR.** `ops/verify/structure.sh` is the
  allowlist and checks both directions — an allowlisted entry that no longer exists
  is also a failure. It is wired into `npm run check`.
- `ops/` and `ecosystem.config.cjs` must stay at the repo root. `ecosystem.config.cjs`
  derives `ROOT = __dirname`, so moving it resolves all four PM2 `cwd`s wrong and
  every app fails to start.
- `packages/ui` and `packages/config` were attempted and reverted — every
  `packages/<d>` must have a `package.json`.
- Contracts are frozen. A new inference route **fails the build** until added to
  `INFERENCE_PATH_MAP` in `packages/contracts/test/surface.test.mjs:37-45`. No
  parallel `openapi.*.json`.

**Runtime behaviour**
- Router graceful drain (20s) must stay under PM2 `kill_timeout` (25s) or PM2
  SIGKILLs mid-drain.
- **SSE must not be buffered** — anything that buffers breaks TTFT and the `ttft_ms`
  column.
- `/v1/*` has a catch-all, so an unimplemented path returns `401 invalid api key`,
  not `404` — auth is evaluated before path support. Never answer "is endpoint X
  supported?" from a status code; use a valid key.
- `/v1/models` and `/v1/models/{model}` are deliberately unauthenticated (the same
  catalog is public at `GET /models` and `GET /pricing`).
- Billing idempotency: `credit_ledger` rows keyed `usage:<request id>`;
  `usage_charge` must stay exactly-once.
- `trustedOrigins: []` when `NODE_ENV=production` (`apps/web/server/index.mjs` ~:404)
  — flag only; changing it is a production config change requiring approval.
- `publish.ts` and the router's SQL are the same rule implemented twice —
  `reachability()` must stay in step with `backend/go/internal/store`.
- A credential row is ONE account stored FLAT, not a pooled `{accounts:[...]}` blob.
- The router's usable-credential predicate is
  `status not in ('disabled','invalid') AND (cooldown_until IS NULL OR cooldown_until <= now())`
  — `auth_failed` is NOT an exclusion.
- A 2xx from a provider whose `/models` is public proves nothing.
- `model.name` and `model.slug` are equal on 238 of 243 models — never print the
  same string twice.

## Known gaps (do not "fix" silently)

- **Combos, Agents, Referrals have 0 files.** They are absent features, not test
  gaps. ADR-0006 forbids creating their directories without real code or schemas.
- **No Rust.** ADR-0003 refuses `backend/rust/**` until there is a measured
  bottleneck AND a versioned job/result/event contract.
- **No Go management API.** ADR-0002 keeps one binary; the 40+ Express
  `/api/admin/*` routes stay in Express.
- **No e2e/load harness** despite `tests/{e2e,integration,load}` existing as empty
  dirs at the repo root.
- **Stale docs** (known, not yet corrected): `README.md:8` says the control plane is
  on :3000 while `.env.console` pins `PORT=3002`; `docs/architecture/*` and
  `docs/audit/*` reference pre-rename paths (`apps/react-web`, `services/router`,
  `tools/`); `docs/specs/*` reference `infra/migrations` (now
  `backend/go/migrations`) and `shared/control-lib` (now `packages/platform`).
- `ops/onboard-farm.mjs:12` documents a `FARM_PROVIDER_STATUS` knob the code never
  reads.
- `apps/web/server/lib/ssrf.mjs:11` — `_fetchCatalog` untested by the author's own
  note.
