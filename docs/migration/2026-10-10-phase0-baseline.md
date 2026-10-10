# FUDRouter — Phase 0 Baseline Evidence

- **Date:** 2026-10-10 · **HEAD:** `32282a0` · **branch:** `main`
- Every command below was read-only, or wrote only to a **throwaway** database. No application process was restarted. No production configuration was touched.

---

## 1. What was run

| # | gate | command | environment |
|---|---|---|---|
| 1 | JS/TS typecheck | `npm run check` (root: `--workspaces` + `check:shared`) | no DB needed |
| 2 | Go static analysis | `go vet ./...` | `services/router` |
| 3 | Go build | `go build ./...` | `services/router` |
| 4 | Go unit only | `env -u DATABASE_URL go test ./... -count=1` | **DB unset → DB-backed tests skip** |
| 5 | Go full, pre-fix | `DATABASE_URL=…/fudrouter_test go test ./... -race -count=1 -v` | stale test DB (12/15 migrations) |
| 6 | Go full, post-fix | `DATABASE_URL=…/fudrouter_test go test ./... -race -count=1 -v` | test DB brought to parity |

---

## 2. Results

| gate | result |
|---|---|
| `npm run check` | **exit 0** — `tsc --noEmit` clean for `apps/react-web` and for `shared/control-lib` |
| `go vet ./...` | **exit 0** |
| `go build ./...` | **exit 0** |
| `go test ./...` (no DB) | **exit 0** — but see §3 |
| `go test ./... -race` (DB) | **exit 0 — PASS 272 · SKIP 5 · FAIL 0** |

Per-package, DB-backed, `-race` run:

```
ok  services/router                 1.043s
ok  internal/cost                   1.032s
ok  internal/crypt                  1.018s
ok  internal/freebuff               1.058s
ok  internal/ids                    1.029s
ok  internal/keys                   1.027s
ok  internal/limits                 1.028s
ok  internal/netguard               1.025s
ok  internal/proxy                 30.961s
ok  internal/routing                1.064s
ok  internal/store                  2.668s
ok  internal/vk                     1.097s
ok  tests                           1.071s
```

The 5 skips are all the same opt-in gate, not failures:

```
pool_budget_test.go:104: set FUDROUTER_SLOW_POOL_TESTS=1 — walks a 663-account pool, ~3s
pool_cost_test.go:39:    set FUDROUTER_SLOW_POOL_TESTS=1 — walks a 663-account pool, ~5s
pool_cost_test.go:86:    set FUDROUTER_SLOW_POOL_TESTS=1 — walks a 663-account pool, ~5s
… (TestPoolForReloadsAfterTrustWindow, TestPickFailureIsCooldownOnRetry,
   TestPickFailureCostAtRealPoolSize, TestDeadPoolProbesEveryAccountOnEveryRequest)
```

> To run them: `FUDROUTER_SLOW_POOL_TESTS=1 DATABASE_URL=…/fudrouter_test go test ./internal/proxy -race`

---

## 3. Why local green ≠ CI green (finding)

**Without a database, only 178 assertions run.**

| run | PASS | note |
|---|---|---|
| no `DATABASE_URL` | 178 | every DB-backed test **skips silently** |
| `DATABASE_URL=…/fudrouter_test` | **272** | the real figure |

`ci.yml` states the reason outright: *"The data plane's tests SKIP when DATABASE_URL is absent, so a CI without a database would report green while never exercising the code that actually serves traffic."* CI passes `-v` *"so that any remaining t.Skip is visible in the log rather than indistinguishable from a pass."*

**Consequence for the migration: any structural change must be validated against a DB-backed run, or it will look green while `internal/proxy` (8,880 LOC, the hot path) was never exercised.**

---

## 4. Test-database state (finding + fix)

`fudrouter_test` already existed on the shared Postgres instance (`proxypool_test` shows the naming convention is house practice). At inspection it was **stale**:

| database | migrations recorded | gated migration |
|---|---|---|
| `fudrouter` (production) | 14 | `0010` — held |
| `fudrouter_test` (before) | 12 | `0010` — held, **0013 + 0014 missing** |
| `fudrouter_test` (after) | **14** | `0010` — held |

Fixed through the sanctioned path only — `DATABASE_URL=…/fudrouter_test ./scripts/migrate.sh` — which applied `0013_job_retention` and `0014_request_log_env_spend_idx` and left everything else alone. The credential-split step self-skipped, exactly as `ci.yml` predicts for a job with no `npm ci`.

**`0010_platform_status_narrow` is intentionally absent from every database.** `scripts/migrate.sh:54-65` implements a `-- gated:` header convention: a migration whose header carries it is *staged in the tree but must not be applied* until its writer/predicate cutover lands in the same commit. Two tools confirm prod mirrors this:

- `tools/route-integrity/run.sh:66` — *"mirror prod, where 0010 is skipped."*
- `tools/prod-router-drill.sh:58-61` — *"Applying 0010 here narrows the status … which is exactly how this drill rotted when 0010 landed."*

Minor inconsistency worth recording: production records the newest migration as `0014_request_log_env_spend_idx.sql` (with the extension) while the runner writes `0014_request_log_env_spend_idx` (without). It is a bookkeeping cosmetic, not an applied/unapplied difference.

---

## 5. What this baseline does **not** cover

These are the holes the migration has to close (Phase 1), and they are the reason "backward compatible" is currently unverifiable:

| surface | covered today? |
|---|---|
| Inference HTTP routes (7) | partly — unit tests exercise handlers, no end-to-end HTTP contract test |
| SSE / streaming flush semantics | partly — no test asserts the first event arrives without buffering |
| Management API (`/api/admin/*`, 40+ routes) | **no** — zero tests |
| better-auth session + Discord OAuth callback | **no** |
| Billing/metering idempotency (`usage:<request id>`) | **partly** — `LedgerRows` exists in the Go helpers, no suite asserts exactly-once under retry |
| Rate/concurrency limits via Valkey (`rl:`, `conc:`) | **no** — the Valkey path is exercised with a fake client |
| Frontend (React) | **no** — only 5 Node test files for server-side helpers |
| Load / soak | **no** |
| Node worker fleet (`workers.mjs`, `scheduler.mjs`) | **no** |

---

## 6. Artifacts

Raw logs (not committed — scratch):
`~/.hermes/cache/scratch/p0-baseline/{npm-check.log, go.log, go-test-fresh.log, go-test-dbtest.log, go-test-final.log, migrate-test.log}`

Reproduce the full baseline:

```bash
cd /home/dwizzy/fudrouter
DSN=$(grep '^DATABASE_URL=' .env | cut -d= -f2-)
TEST="${DSN%/*}/fudrouter_test"

npm run check
(cd services/router && go vet ./... && go build ./...)
DATABASE_URL="$TEST" bash -c 'cd services/router && go test ./... -race -count=1 -v'
```

⚠️ **Never** run the suite with the unmodified `.env` DSN. It names the **production** database, and `tests/helpers.go` INSERTs and DELETEs rows in whatever `DATABASE_URL` names. The guard refuses the `fudrouter` database by name unless `FUDROUTER_ALLOW_PROD_TESTS=1` — leave that unset.
