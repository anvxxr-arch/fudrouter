# The ledger could not answer "how many 200s did we serve?"

Three defects shared one shape: the code wrote the right answer to the client and
then failed to record it, or recorded it on a context that could no longer reach
the database. Each was measured on the live box before it was touched.

## What shipped

### `request_log.http_status` was NULL on every success (data plane, Go)

Measured: **724/724 rows with `status='success'` had `http_status = NULL`**,
while `client_error` (1630), `rate_limited` (336) and `provider_error` (166)
rows were all populated. Only `reject()` and `fail()` ever set
`lc.httpStat`; the success paths (`serveBuffered`, `stream`, `anthropic`) wrote
200 straight to the client and left the field at zero.

Every per-status metric therefore undercounted the only outcome a customer
generates volume with. The fix derives the status at `finish()` — the single
funnel every outcome already passes — rather than at four separate
`WriteHeader` call sites, because the router answers success with 200 and
nothing else and a cancelled stream had already sent its headers.

`backend/go/internal/proxy/lifecycle.go`, gate
`backend/go/internal/proxy/http_status_test.go` (DB-backed: asserts a
successful buffered call lands `http_status = 200`, and a 500 upstream keeps
its own status rather than being flattened to 200).

### The ledger's recovery writes could never run (data plane, Go)

`finish()` writes the ledger after the 200 is already on the wire. When
`ChargeRequest` failed it fell back to `InsertRequestLogWithLedger(ctx)` — on
the *same* context. The only realistic reason the charge fails is that the
context expired, and an expired context never revives, so `Begin(ctx)` failed
instantly: the fallback was structurally dead for the one failure it exists to
repair. A load test reproduced it under DB contention (116/120, four rows
unbilled).

Both recovery writes now build their own bounded context
(`ledgerWriteBudget = 5s`, the same as the primary: one statement against a
lock the aborted transaction already released — a longer budget only pins the
goroutine, a shorter one gives the fallback less chance than the primary had).
The attempts insert gets its own too: it used to inherit the fallback's context,
already part-spent waiting behind the same saturated pool, and the
pool-saturation probe measured **18/144 attempt rows lost vs 3/144 ledger rows**
(6x) — the forensic trail a re-bill would follow died exactly when it was most
needed.

Gates: `lifecycle_fallback_test.go` (deterministic — a listener that accepts and
never answers; only a second dial proves a live context),
`pool_saturation_probe_test.go` (pool 3 at 8x and 16x oversubscription).

### `GET /v1/models` re-encoded 64.5 KB per request (data plane, Go)

Measured on the deployed box: **~3.08 ms/request (~1000-1140 req/s on 4
cores)**, against ~8300 req/s for `/health` on the same listener.
`json.Unmarshal` of the cached catalogue (884 µs) + `modelObject` maps (251 µs)
+ `json.Encoder.Encode` (1.38 ms).

The catalogue is public and identical for every caller, so the body is rendered
once per 45 s window — the same window the Valkey entry already uses, so
publish latency is unchanged. `dev` is stored beside the body because
`devProviders()` changes the model list; refresh is single-flight and a caller
holding a stale body is answered immediately instead of queueing behind a
failing DB read. A catalogue that has never rendered still returns
`INTERNAL_ERROR` — a 45 s-old list beats a 500, but a missing one does not.

## Gates

- `go build ./...`, `go vet ./...` → clean
- `go test ./...` → **13/13 packages**, `DATABASE_URL` → `fudrouter_test`
  (proxy 86.4 s, store 33.4 s)
- Deployed binary rebuilt and restarted; `/health`, `/v1/models`,
  `/v1/models/{slug}` answered 200 after the swap.
