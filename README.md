# fudrouter

Commercial AI router — one API key, many model providers.

Two stateless processes over one Postgres (plus shared Valkey for runtime state):

```
client ──► apps/web (SvelteKit, :3000)   control plane: UI, auth, billing, admin
           │  ▲
           │  └── reads/writes workspace · project · api_key · model · provider · user
           ▼
client ──► services/router (Go, :8100)   data plane: /v1/* hot path
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
| `apps/web/src/lib/ui/` | The design-system atoms. One `.svelte` per atom, all styling via `$lib/design/tokens.css` |
| `apps/web/src/lib/design/` | Design tokens + shared component CSS. `theme.tailwind.css` is **generated** — `tools/regen_theme.py` regenerates it and `--check` verifies it matches `DESIGN.md` |
| `apps/web/src/lib/guides/` | Explanatory page copy, split by audience (`public`/`member`/`admin`) |
| `apps/web/src/lib/server/` | Server-only code: auth, credentials, SSRF, roles, provider upstream calls |
| `apps/web/src/lib/server/db/` | Drizzle schema + connection |
| `apps/web/src/routes/(public)/` | Marketing: landing, pricing, models, docs, legal, login/signup |
| `apps/web/src/routes/(app)/` | Member surface: dashboard, keys, usage, account, billing |
| `apps/web/src/routes/admin/` | Staff console |
| `services/router/internal/proxy/` | The hot path, split by concern: `proxy.go` handler, `auth.go` auth+failover policy, `billing.go` the cost funnel, `generic.go` the non-chat passthrough |
| `services/router/internal/netguard/` | The SSRF dial guard, shared by every upstream client |
| `services/router/internal/freebuff/` | The native Codebuff protocol (split into protocol/transport/classify) |
| `infra/migrations/` | SQL migrations, applied in order by `scripts/migrate.sh` (both CI jobs and deploys use this runner — drizzle-kit's journal is retired) |
| `docs/specs/` | Design specs. The endpoint-surface spec is the source of truth for what the API actually supports |

## Conventions worth knowing before editing

- **Validation belongs next to the code that forwards the value.** Form-action
  bounds live in `$lib/server/admin-limits.ts`; a slug that is forwarded upstream
  must be cleaned before it reaches a fetch.
- **Pure rule, env read, separate files.** `$lib/publish.ts` holds the pure
  reachability rule and `$lib/server/publish-env.ts` holds the two env reads, so
  the rule stays unit-testable outside the SvelteKit runtime. Same shape for
  `$lib/guides-types.ts` vs the audience files.
- **Money never touches a float.** Tokens are `int64`, prices are
  `numeric(18,6)`, and cost is computed through `math/big` in
  `services/router/internal/cost`.
- **API keys are hash-only.** `sk-ar-<prefix>_<secret>`, only `sha256(secret)`
  is stored. The TS and Go sides must stay byte-compatible — both re-parse every
  key the other mints.

## Development

```sh
# both planes need this
docker compose -f infra/docker-compose.yml up -d     # stack (Postgres is consolidated)

cd apps/web && npm install
npm run check          # svelte-check, type errors
npm run lint           # prettier --check . && eslint .
npm test               # vitest
npm run dev            # vite dev (:3000)

cd services/router
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
./scripts/migrate.sh
go test ./... -race
```

## CI

`.github/workflows/ci.yml` runs both planes against a real Postgres 17 service.
Every step that can no-op has been closed: no `--if-present` scripts (an absent
script would silently pass), the DB-backed Go tests `FAIL` rather than skip when
`DATABASE_URL` is absent, and `tools/regen_theme.py --check` fails if
`theme.tailwind.css` has drifted from `DESIGN.md`. Both jobs apply the schema
through `scripts/migrate.sh`, the single migration path.
