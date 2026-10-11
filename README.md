# fudrouter

Commercial AI router — one API key, many model providers.

Two stateless processes over one Postgres (plus shared Valkey for runtime state):

```
client ──► apps/web (React, :3000)    control plane: UI, auth, billing, admin
           │  ▲
           │  └── reads/writes workspace · project · api_key · model · provider · user
           ▼
client ──► backend/go (Go, :8100)   data plane: /v1/* hot path
              ▲  │
              │  └── decrypts provider credentials, routes across
              │      connections/credentials, writes request_log + credit_ledger
              └── re-reads api_key · model · provider directly

both planes ──► Valkey (127.0.0.1:6379)   rate limits, counters, caches,
                                          circuit state — NEVER source of truth
```

The control plane is **not a security boundary** for the hot path. The data plane
authenticates, enforces limits and dials upstreams on its own, so a compromised
control plane cannot mint traffic that the router will accept, and the router does
not trust the console's URL validation (both planes carry their own SSRF guard —
see `internal/netguard`).

## Layout

| Path | What lives there |
|---|---|
| `apps/web/src/` | React control plane: routes, components, compat API client |
| `apps/web/server/` | Express compat server: admin, pages, public, playground APIs |
| `packages/platform/` | Shared server modules: jobs, workers, scheduler, credentials, SSRF, billing |
| `packages/platform/server/db/` | Drizzle schema + connection |
| `backend/go/internal/proxy/` | The hot path, split by concern: `proxy.go` handler, `auth.go` auth+failover policy, `billing.go` the cost funnel, `generic.go` the non-chat passthrough |
| `backend/go/internal/netguard/` | The SSRF dial guard, shared by every upstream client |
| `backend/go/internal/freebuff/` | The native Codebuff protocol (split into protocol/transport/classify) |
| `backend/go/migrations/` | SQL migrations, applied in order by `ops/migrate.sh` (both CI jobs and deploys use this runner — drizzle-kit's journal is retired) |
| `docs/specs/` | Design specs. The endpoint-surface spec is the source of truth for what the API actually supports |

## Conventions worth knowing before editing

- **Validation belongs next to the code that forwards the value.** Form-action
  bounds live in `packages/platform/server/admin-limits.ts`; a slug that is forwarded upstream
  must be cleaned before it reaches a fetch.
- **Pure rule, env read, separate files.** `packages/platform/publish.ts` holds the pure
  reachability rule and `packages/platform/server/publish-env.ts` holds the two env reads, so
  the rule stays unit-testable outside the worker runtime.
- **Money never touches a float.** Tokens are `int64`, prices are
  `numeric(18,6)`, and cost is computed through `math/big` in
  `backend/go/internal/cost`.
- **API keys are hash-only.** `sk-ar-<prefix>_<secret>`, only `sha256(secret)`
  is stored. The TS and Go sides must stay byte-compatible — both re-parse every
  key the other mints.

## Development

```sh
# both planes need this
docker compose -f infra/docker-compose.yml up -d     # stack (Postgres is consolidated)

npm ci --workspace apps/web          # installs react-web from the root lockfile
npm run build --workspace apps/web   # vite build (dist/ served by server/index.mjs)
npm run dev --workspace apps/web     # vite dev

cd backend/go
go test ./... -race    # the data-plane suite is DB-backed; see below
```

**The data-plane tests need a throwaway database.** They insert and delete rows,
so `tests/helpers.go` refuses to run against a database named `fudrouter` (the
application database) unless `FUDROUTER_ALLOW_PROD_TESTS=1` is set explicitly.
Point `DATABASE_URL` at anything else:

```sh
# 1. create a scratch DB. The `fudrouter` role has NO createdb right, so this
#    needs the container's superuser.
docker exec postgres-hardened psql -U postgres -d postgres \
  -c "create database fudrouter_test owner fudrouter"

# 2. apply the schema, then point the suite at it and run it.
export DATABASE_URL=postgres://fudrouter:fudrouter@127.0.0.1:5432/fudrouter_test
./ops/migrate.sh
go test ./... -race
```

## CI

`.github/workflows/ci.yml` runs both planes against a real Postgres 17 service.
Every step that can no-op has been closed: no `--if-present` scripts (an absent
script would silently pass), the DB-backed Go tests `FAIL` rather than skip when
`DATABASE_URL` is absent. Both jobs apply the schema
through `ops/migrate.sh`, the single migration path. The `react-web` job builds the React control plane; the `router` job vets, builds, scans and tests the Go data plane.
