# fudrouter-router

The Go data plane. Serves the `/v1/*` hot path and is the only component that
talks to upstream model providers. See the [root README](../../README.md) for how
this fits with the SvelteKit control plane.

## Package map

```
main.go                 entrypoint; newMux() delegates the route table to
                        proxy.ServeMux so the tests pin the same one
health_test.go          /health pings the DB and reports 503 when it is down
internal/
  proxy/                the hot path, split by concern:
    proxy.go              handler + upstream client + pool cache + the mux
    auth.go               authenticate(), shouldFailover(), parksAccount()
    billing.go            clampTokens() + logRequest() — the single cost funnel
    generic.go            the /v1/* passthrough for non-chat endpoints
    limits.go             per-key rpm window + monthly cost cap
    pool.go               the account rotation pool and OAuth refresh
    guard.go              thin re-export of netguard (see below)
  netguard/           THE SSRF boundary: DialControl + RedirectPolicy,
                        shared by every upstream client in the binary
  store/              the only database access; every statement is parameterised
  crypt/              AES-256-GCM provider credentials (wire-identical to TS)
  keys/               sk-ar- key parsing/hashing (wire-identical to TS)
  cost/               integer micro-unit money; multiply/divide through big.Int
  freebuff/           the native Codebuff protocol, split into:
    protocol.go           constants + payload shapes
    transport.go          HTTP client (carries the netguard dial hook)
    classify.go           codebuff_metadata injection + the error taxonomy
    manager.go            the session/run state machine
    models.go             model resolution
tests/                the DB-backed seeder + the production-database guard
bin/                  the deployed binary (gitignored; run.sh execs it)
```

## The two rules this package exists to hold

**1. The SSRF boundary is a dial hook, not a URL check.**
`internal/netguard` installs a `net.Dialer.Control`, which runs *after* DNS
resolution and *before* the socket connects. That is what makes it catch a name
that resolves into private space (DNS rebinding) as well as a literal address —
and because every redirect dials through the same transport, redirects are
covered with no separate policy to keep in sync. Both the `[OI]` client and the
freebuff client use it; the freebuff client originally did not, which was a real
boundary hole (`guard.go` documents the threat).

**2. Cost is computed at exactly one funnel.**
The router never counts tokens itself — it bills what the upstream reports in
`usage`. Every path (chat buffered, chat streamed, generic buffered, and every
error outcome) funnels through `logRequest`, and that function is where token
counts are clamped into `[0, maxTokensPerRequest]` before the cost multiply. That
is the defence against a hostile upstream reporting a *negative* count, which
would make cost negative and lower a key's month-to-date spend past its
`monthly_cost_micro` cap.

## Running the tests

The suite is DB-backed on purpose: it seeds users, models and providers, and it
inserts and deletes rows.

```sh
# The `fudrouter` role has NO createdb right, so creating the scratch database
# needs the container's superuser.
docker exec postgres-hardened psql -U postgres -d postgres \
  -c "create database fudrouter_test owner fudrouter"

export DATABASE_URL=postgres://fudrouter:fudrouter@127.0.0.1:5432/fudrouter_test
for f in ../../infra/migrations/*.sql; do psql "$DATABASE_URL" -q -f "$f"; done

go test ./... -race
```

`tests/helpers.go` **refuses** to run against a database named `fudrouter` —
the application database — unless `FUDROUTER_ALLOW_PROD_TESTS=1` is set
explicitly. That guard exists because the documented local workflow sources
`apps/web/.env`, whose `DATABASE_URL` points at production; one run used to
churn the live `request_log` ledger.

Set `FUDROUTER_SLOW_POOL_TESTS=1` for the pool-walk bounds tests. One of them
walks a 663-account pool with ~150ms refreshes and genuinely costs ~100s; it is
the measured "before" evidence for the walk cap, so it is gated rather than
trimmed.

## Deployment

`run.sh` sources `../../apps/web/.env` and execs `./bin/fudrouter-router`. PM2
(`ecosystem.config.cjs`) is the supervisor. `tools/prod-router-drill.sh` is the
end-to-end drill: fresh database, migrations, build to a scratch path, boot twice
with and without `ROUTER_ALLOW_DEV_PROVIDERS`, and always drop the scratch
database via an exit trap.
