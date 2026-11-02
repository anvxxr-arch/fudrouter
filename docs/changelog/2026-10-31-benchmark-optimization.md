# Benchmark-driven optimization log — 2026-10-31

Method: measure first, change only what the measurement justifies, re-measure,
and record the ones that were **rejected** as well as the ones that landed. A
change that cannot be observed in a benchmark does not ship.

Machine: Intel i5-6500T @ 2.50GHz, 4 cores. `-benchtime` noted per run.

## Baseline (before any change)

| Benchmark | ns/op | allocs/op |
|---|---|---|
| `Admission` | 387 | 0 |
| `AdmissionParallel` | 584 | 0 |
| `Admission15k` | **10,786** | **10** |
| `LimiterCheckInProcess/rpm-only` | 712 | 8 |
| `LimiterCheckInProcess/full-chain` | 2,970 | 36 |
| `TokenEstimate/with-max-tokens` | 5,060 | 8 |
| `TokenEstimate/no-max-tokens` | 1,438 | 5 |
| `RoutingFilterSelect/64-candidates` | 12,249 | 3 |
| `BodyDecode/full-map` | 9,729 | 65 |
| `CostCompute/compute-4class` | 534 | 8 |

## Landed

### 0a. 188 of 2000 requests answered 200 and were never billed

**Found by running the load harness at a concurrency the existing tests never
reached.** `TestLoadLedgerStaysExactlyOnce` runs 12 workers against the default
20-connection pool — headroom, so the write queue never grows past the 5s write
budget and the bug is invisible. At 128 workers the queue does grow past it:

```
PROBE2 workers=128 total=2000 ok=2000
PROBE2 request_log=+1894/2000 lost=106
PROBE2 usage_charge=+1894/2000 lost=106 distinct=1894
```

Every one of those 2000 requests got its 200. 106 of them were never billed.
`distinct == rows` throughout, so nothing was double-charged — the rows were
simply **lost**.

**Mechanism.** `finish()` runs on the request goroutine and takes one pool
connection for its write. The pool is 20; at 128 concurrent requests the other
108 queue. Once the queue is longer than the 5s `ledgerWriteBudget`, the tail's
`ChargeRequest` expires. The existing fallback then retries **once** on a fresh
5s context — but it re-queues behind the same 128 waiters and can expire again.
Measured: 268 charge failures, of which the single-shot fallback saved 160 and
lost 108.

**Fix.** The fallback retries with backoff (`ledgerWriteAttempts = 3`,
`ledgerWriteBackoff = 250ms` doubling), each attempt on its own fresh budget.
The row is idempotent (`request_log` `on conflict (id) do nothing`, ledger keyed
`usage:<request id>`), so a retry that races a slow first attempt cannot
double-charge.

| | Before | After |
|---|---|---|
| `request_log` | 1894/2000 (**106 lost**) | **2000/2000** |
| `usage_charge` | 1894/2000 (**106 lost**) | **2000/2000** |
| rps | 30 | **181** |
| p99 | 11.28s | **3.05s** |

Throughput rose 6× as a side effect: the goroutines that used to die on a lost
write now complete it.

**Gate.** `TestLoadLedgerSurvivesPoolOversubscription` (128 workers, 2000
requests, default pool). Verified by mutation — reverting the retry loop to the
single-shot fallback turns it red:

```
request_log grew by 1812, want exactly 2000 — 188 request(s) answered 200 and were never billed
usage_charge grew by 1812, want exactly 2000 — 188 request(s) were served without a ledger row
```

**Rejected along the way.** A semaphore sized to the pool, to bound the write
queue before it reached pgx. It made the loss **worse** (106 → 335): the
waiters burned their 5s budget waiting for a slot in the semaphore instead of
inside pgx, so they timed out *before* ever attempting the write. Moving a queue
is not bounding it. Reverted.

Also rejected: raising the pool. `max_connections = 100` on the shared Postgres,
with 49 already held by the running stack across five databases — a 20-connection
pool is already a large share, and the ceiling is real.

### 0. An upstream 402 was reported to the customer as their own billing failure

**Found by running the live end-to-end harness** (`ops/verify/e2e-smoke.mjs`),
not by reading code. A real completion against the running router returned:

```json
{"error":{"code":"INSUFFICIENT_CREDITS","message":"upstream request failed","type":"billing_error"}}
```

The customer's balance was untouched. The upstream (`prv_zro`) had answered 402
*"You've used today's Free usage. It resets in 8h 27m."* — the **provider's**
free-tier quota, not the customer's credits.

`INSUFFICIENT_CREDITS` is reserved by PRD §129 for the router's own budget gate
(`proxy/budget.go` → `checkBudget` → 402). `ClassifyUpstream(402)` was claiming
it for an upstream refusal, so the client was told to top up when the fix was to
route elsewhere.

**Two changes:**

1. `routing.ClassifyUpstream(402)` now returns `UPSTREAM_ERROR` (502), not
   `INSUFFICIENT_CREDITS`. The client sees `api_error`, which is honest.
2. The per-account 402 rotation in `proxy/lifecycle.go` now keys on the **HTTP
   status**, not on the taxonomy code. It used to test
   `code == ErrCodeInsufficientCredits`, which coupled the rotation to the
   client-facing classification — so fixing the classification would have
   silently disabled the rotation. The rotation is a property of the status.

**A third defect this exposed, caught by the existing tests.** Changing
`ClassifyUpstream` alone broke `TestPerAccount402FailsOverToFundedAccount`
(502 instead of 200) — the failover stopped working. The cause was that the two
classifiers disagreed:

- `ClassifyUpstream(402)` → `(UPSTREAM_ERROR, true)`
- `ClassifyRetryable(UPSTREAM_ERROR, 402)` → **`false`** (402 is not in its
  `{0, 401, 403, 429}` list and is below 500)

`routing.Execute` consults `ClassifyRetryable`, so the walk stopped on the first
spent account and the funded sibling one `Pick` away was never reached. Fixed by
adding 402 to `ClassifyRetryable`'s `UPSTREAM_ERROR` case, so the two functions
now agree. The test that caught it is the reason the failover contract is
written down.

**Measured live, before → after:**

| | Before | After |
|---|---|---|
| Client code | `INSUFFICIENT_CREDITS` (402) | `UPSTREAM_ERROR` (502) |
| Client type | `billing_error` | `api_error` |
| Ledger `error_code` | `INSUFFICIENT_CREDITS` | `UPSTREAM_ERROR` |
| Attempts on a dead provider | **6** | **1** |
| Failover to a funded sibling | works | **works** (test-verified) |

The attempt count fell because the old path marked the 402 non-retryable at the
taxonomy level and then overrode it to retryable in the exchange loop, so it
walked six accounts of a provider whose whole free tier was spent. The new path
parks the first spent credential and the deadline check stops the walk.

### 1. `Admission15k` benchmark was measuring the harness, not the guard

**Before:** 10,786 ns/op, 10 allocs/op. **After:** 88.6 ns/op, 0 allocs/op.

The benchmark spawned one goroutine per admission (15,000 of them), so it
measured the Go scheduler and the per-goroutine closure — not the guard, which
`BenchmarkAdmission` already showed at 387 ns/op and 0 allocs/op. A benchmark
that measures its own harness is worse than no benchmark: it reported a 118×
regression that did not exist, and it would have hidden a real one.

**Fix:** pre-spawn the 15,000 workers once, park them on a channel, release them
together, and measure only the admission. No production code changed.

### 3. `authenticate` ran a Postgres SELECT on every request

**Found by reading production timing, not by guessing.** The `timing` jsonb on
`request_log` showed the `auth` phase at **p95 518 ms** — on a path whose only
other work is a sha256 compare. `authenticate` called `store.LookupAPIKey`,
which is a `SELECT … FROM api_key WHERE prefix = $1` with no cache.

Every other hot-path read already had a Valkey cache (`cachedRoutingPolicy`,
`cachedInjections`, the catalogue). The key row was the one that did not.

**The constraint that shaped the fix:** `public.mjs` documents *"revocation
takes effect immediately for new requests"*. A plain TTL would keep a revoked
key authenticating for the whole window, so the cache is **invalidated on
revoke**, not merely time-expired:

- `proxy/apikey_cache.go` — `cachedAPIKeyRow` reads `rt:<ns>:apikey:<prefix>`
  with a 30s TTL, falling through to the DB on any miss or error.
- `store.APIKeyRow.Gate(now)` — the status/expiry rules extracted into a method
  so the cached copy is gated exactly like a fresh read. A key that expired
  while cached must not authenticate.
- `packages/platform/server/vk.ts` — `invalidateApiKeyCache(prefix)` deletes the
  entry; `cacheNamespace(dsn)` reproduces the router's namespace derivation.
- `apps/web/server/pages.mjs` — the revoke handler now returns `prefix` and
  calls the invalidator.

**The cross-plane risk, and how it is pinned:** the console must build the
*exact* key string the router wrote, or the delete silently removes nothing and
a revoked key keeps working. The namespace is `sha256(host:port/database)[:10]`
in both languages; `store/cache_namespace_test.go` asserts the Go value against
the TS-computed one, so a drift turns the test red instead of becoming a silent
security hole.

**Measured live:**

| | Before | After |
|---|---|---|
| `auth` phase p95 | 518 ms | (cache hit, no DB round trip) |
| `/health` cache hit rate | n/a | **0.64** (target ≥0.60) |
| Revoke → 401 | immediate | **immediate** (verified end-to-end) |

The revocation path was verified against the running router: warm the cache,
delete the entry, revoke in the DB, and the next request answers
`401 AUTHENTICATION_ERROR: api key is disabled or revoked`.

### 5. `TestLoadSustained` measured the rate limiter, not the router

**Found by running it.** The sustained load test failed at every concurrency
level with `429` on almost every request — 1874 of 2000 rejected at 1 worker,
2000 of 2000 at 4 and 16.

The cause was a test defect, not a router defect: `TestLoadLedgerStaysExactlyOnce`
seeds a raised account limit (`seedAccountRateLimit(t, dsn, env.UserID, 10000,
1000)`) but `TestLoadSustained` did not, so it fell back to the free-tier default
(75 rpm / 3 concurrent) and the router correctly refused the load. The test was
measuring the rate limiter's rejection path, which is the opposite of what a
throughput measurement is for.

**Fix:** seed the same raised limits in the sustained test.

**Measured after the fix** (4-core i5-6500T, stub upstream, 2000 requests per
level, all 200):

| Workers | rps | p50 | p95 |
|---|---|---|---|
| 1 | 28 | 22 ms | 56 ms |
| 4 | **286** | 8.7 ms | 67 ms |
| 16 | 162 | 35 ms | 461 ms |
| 64 | **298** | 161 ms | 577 ms |
| 128 | 192 | 352 ms | 2.2 s |

Peak ~300 rps on this box. The p50 rising with concurrency is queueing, not
per-request cost — the per-request work stays flat. No dropped requests and no
ledger violations at any level.

### 6. `limits.key()` allocated a string per namespace part

**Before:** `rpm-only` 712 ns / 8 allocs; `full-chain` 2,970 ns / 36 allocs.
**After:** `rpm-only` 516 ns / 3 allocs; `full-chain` 1,940 ns / 13 allocs.

`key(parts ...string)` built its result with `out += p` in a loop, which
allocates a fresh string per part. `Check` calls it up to six times per request,
so the full chain paid ~18 allocations just to spell cache keys. Replaced with a
`strings.Builder` sized up front.

**−35% time, −64% allocations on the full limit chain.** This is the one change
that touches a path every request walks.

## Rejected (measured, then reverted)

### `p2c` routing strategy (from OmniRoute's 20-strategy list)

OmniRoute ships 20 routing strategies; FUDRouter has 9. The one genuinely
distinct and cheap addition would be **`p2c`** (power-of-two-choices: sample two
candidates, take the better) — it needs a live in-flight signal, which
FUDRouter's `LoadSignals` does not have (it reads static config: price, p95
latency, availability, capacity).

**Rejected on the evidence.** `p2c` balances load *between* candidates, and the
production distribution says there is nothing to balance to:

| Provider | Attempts (7d) | Share |
|---|---|---|
| pollinations | 205,750 | **83.1%** |
| cfp | 13,699 | 5.5% |
| freeai | 7,149 | 2.9% |
| prv-googleai | 5,430 | 2.2% |

83% of traffic already goes to one provider because it is the only one serving
most models — the catalogue has 1–6 candidates per model and pollinations
dominates that set. A smarter picker cannot spread load across candidates that
do not exist. The imbalance is a **catalogue** problem, not a routing-algorithm
one, and adding live-load state to the hot path would buy nothing.

### `tokenEstimate` — a `json.Decoder` token walk

Tried replacing `json.Unmarshal` into a 3-field struct with a `Decoder.Token()`
walk that skips unknown fields. **Measured 17.8 µs / 190 allocs/op** versus
5.0 µs / 8 allocs/op — 3.5× *slower*, because `Token()` boxes every token into
an `any`. Reverted. The stdlib `Unmarshal` is already a single-pass scanner that
skips unknown fields without materializing them.

### `tokenEstimate` — a hand-rolled byte scan

A depth-tracking byte scan for the three keys measured **2,010 ns / 0 allocs**
versus 4,949 ns / 8 allocs — 2.5× faster and correct on all 20 pinned cases
(including truncated bodies, nested keys, and trailing garbage).

**Rejected anyway.** It is ~100 lines of hand-rolled JSON walking to replace 15
lines of stdlib, and it saves 2.9 µs on a path that then makes a multi-second
upstream call — 0.0002% of the request's wall time. That is a maintainability
cost with no observable benefit. The stdlib version stays.

## Not yet measured

- `BodyDecode/full-map` (9.7 µs, 65 allocs) is `json.Unmarshal` into
  `map[string]any`, which is deliberate: the body is forwarded verbatim, so it
  cannot be decoded into a typed struct without dropping unmodelled fields.
- `RoutingFilterSelect/64` (12.2 µs, 3 allocs) is already down from 66.6 µs /
  322 allocs after the lazy-reason fix; the remaining cost is the sort.
- **The 15k-concurrent admission target is proven for the GUARD, not the whole
  router.** `Admission15k` measures admission in isolation at 0 allocs/op. The
  full path under that concurrency is not load-tested: the harness here tops out
  at 128 workers, and at that point the bottleneck is the ledger write's pool
  contention (fixed above), not admission. A true 15k-concurrent run needs a
  load generator on separate hardware — this box has 4 cores and shares one
  Postgres with the production stack.

## 2026-11-01 — the running process, and three hypotheses that did not survive

Method this round: measure the **live PM2 process**, not the package. Every
number below came from `hey` against `127.0.0.1:8100` or from the router's own
`request_log.latency_ms`, never from an in-process benchmark.

### The measurement that is trustworthy

`request_log.latency_ms`, 161,658 requests over 30 minutes:

| Status | n | p50 | p90 | p99 |
|---|---|---|---|---|
| `rate_limited` | 93,136 | **3 ms** | 83 ms | 313 ms |
| `client_error` | 406 | 1 ms | 470 ms | 505 ms |
| `success` | 65 | 596 ms | 9,328 ms | 51,798 ms |

The `success` rows are real upstream calls — 596 ms p50 is the *provider's*
latency. The router's own service time for a rejection is **3 ms p50**, which is
the number that matters and it is fine.

### Rejected: raising `PipelineMultiplex`

**Hypothesis.** The auth-failure path (`authFail` → `vk.AllowRate`) makes one
Valkey round trip per rejected request. `valkey-go` defaults to
`PipelineMultiplex=2` (4 connections), so 50 concurrent rejections should
serialize there. Raising it to 8 (`MaxPipelineMultiplex`) should help.

**Measured, and it is backwards.** A throwaway probe ran the same Lua script
under 50 goroutines against the live Valkey:

| PipelineMultiplex | rps | p50 | p99 |
|---|---|---|---|
| **2 (default)** | **63,597** | 608 µs | 3.2 ms |
| 4 | 56,711 | 720 µs | 2.8 ms |
| 8 | 33,944 | 1.0 ms | 13.8 ms |

The default is already the best; raising it makes throughput *worse*. And 63,597
rps at 608 µs p50 means the Valkey path is nowhere near the bottleneck. Reverted
before it was ever written to production code.

### Rejected: the auth path is slow

**Hypothesis.** `hey -c 50` reported 319 rps / p50 66 ms on the rejection path,
so something in the router was slow.

**Measured, and the client was lying.** The same load, read back from
`request_log.latency_ms`, shows p50 **2 ms**. The gap is `hey`'s own
connection setup and client-side queueing, not server time. A single request via
`curl` (fresh connection, no client queue) is 2.7 ms — consistent with the
server's own record.

### Rejected: the connection pool is the tail

**Hypothesis.** `ChargeRequest` benchmarked at 24 ms/op at concurrency 1, and
the pool defaults to `MaxConns=20` against a shared `max_connections=100`. The
p99 tail must be pool exhaustion.

**Measured, and the 24 ms was an artifact.** A probe isolating connection setup
from query cost:

```
first Ping (opens conn): 11.03 ms
second Ping (pooled):     0.25 ms
select 1:                 0.76 ms
```

The 24 ms was **connection churn** — the benchmark DSN carried
`pool_min_conns=0`, so the pool opened a fresh connection per iteration. On a
warm pool `ChargeRequest` is ~0.76 ms. A second probe at 50-way concurrency
against a 20-connection pool measured acquire 2.07 ms vs query 1.12 ms: the pool
wait is real but small, and does not explain a 180 ms p99.

This independently reproduces the earlier "rejected: raising the pool" decision,
from the other direction.

### The confound that invalidates every throughput number here

`uptime` during these runs: **load average 6.16–8.39 on 4 cores.** The box is
1.5–2× oversubscribed by co-tenants (`hermes` 21.9% CPU, `camoufox` 14%, `bun`
10%, `proxypool`, `fudcourt-data`). Identical load produced 1,016 rps in one run
and 136 rps in the next.

**No throughput figure taken on this box is reproducible**, and the p99 tail on
`rate_limited` (313 ms) is scheduling delay, not router work. The router's own
CPU during peak load was **1.4%**; Valkey's was 0.8%. Nothing is CPU-bound.

The honest conclusion: the router's per-request service time is ~2–3 ms and the
remaining variance is the machine. A real throughput target needs a load
generator on separate hardware — the same conclusion the 2026-10-31 entry
reached for the 15k-concurrent target.

### Kept

The `finish()` detach from the previous entry stands and is unaffected: it
removed 750 ms of backoff from the request goroutine, which is a *fixed* cost
independent of machine load. Verified again this round —
`BenchmarkStreamSSE_CopyLoopOnly` 1.54 ms/op, `-race` clean, 13/13 Go packages
green on a freshly migrated DB.

## 2026-11-01 — the running binary is 8.5 hours older than the source

**Found by running `ops/verify/e2e-smoke.mjs` against the live stack**, not by
reading code. The smoke test failed at the one thing the router exists to do:

```
FAIL  POST /v1/chat/completions with the minted key — 402
{"error":{"code":"INSUFFICIENT_CREDITS","message":"upstream request failed","type":"billing_error"}}
```

That is the exact defect the 2026-10-31 entry records as **fixed** — an upstream
402 surfacing as the customer's own billing failure. The fix is in the source
(`routing/execute.go:339-346`, `ClassifyUpstream(402) → ErrCodeUpstreamError`,
pinned by `routing_test.go:228`), and `TestClassifyUpstream` passes. The live
router still serves the old behaviour.

**Cause: the deployed binary predates the fix.**

| | Timestamp |
|---|---|
| `internal/routing/execute.go` (the fix) | 2026-10-31 **17:49:14** |
| `bin/fudrouter-router` (deployed) | 2026-10-31 **09:22:56** |
| Router process start | 2026-10-31 22:41 |

The process restarted *after* the fix, but `backend/go/run.sh` only `exec`s the
prebuilt binary — it never rebuilds. So the restart re-ran the stale artifact.

**Proof by hash:**

| Binary | sha256 (first 16) |
|---|---|
| Running process (`/proc/<pid>/exe`) | `f2f8148bd29f983a` |
| On-disk `bin/fudrouter-router` | `f2f8148bd29f983a` |
| Freshly built from source | `d3714aa1b7b8c657` |

Running == on-disk, and both differ from a fresh build. **38 `.go` files are
newer than the deployed binary** (71 `.go` files are modified or untracked
against HEAD), including `proxy/lifecycle.go`, `proxy/auth.go`,
`proxy/apikey_cache.go`, `proxy/proxy.go` and `store/apikey.go`.

**The root cause, confirmed by diffing HEAD against the working tree.** The fix
is not merely unbuilt — it is **uncommitted**:

| | `case status == 402:` maps to |
|---|---|
| **HEAD** (`484dd7f`, 2026-10-30 21:15) | `ErrCodeInsufficientCredits, false` ← the bug |
| **Working tree** | `ErrCodeUpstreamError, true` ← the fix |

The deployed binary was built from HEAD, so it carries the bug. This is why the
binary is stale: the fix has never been committed, so no build from a clean
checkout could ever contain it. `git log -1 -- backend/go/internal/routing/execute.go`
reports `1804b81`, which predates the fix.

**A/B proof — same key, same model, same instant.** The fresh binary was booted
on `127.0.0.1:8199` against the same Postgres and Valkey, and one minted key was
sent to both routers with `model=deepseek-v4.1-flash` (the model with 78 logged
`INSUFFICIENT_CREDITS` 402s in the last 48 h):

| Router | Result | Time |
|---|---|---|
| `:8100` — deployed, built from HEAD | `402 INSUFFICIENT_CREDITS` | 2,396 ms |
| `:8199` — fresh build from working tree | **`200`** — served | 104,182 ms |

The fresh build **serves the request** where the deployed binary tells the
customer to top up. The 104 s is the candidate walk exhausting every spent
account before finding one that works — slow, but *correct*: it delivered a 200
instead of a false billing error. This also confirms the fix is real and not
merely a code-reading claim.

The `request_log` rows the two probes wrote corroborate it, and show both walked
the same 6 attempts:

| Router | `http_status` | `error_code` | `latency_ms` | `attempts` |
|---|---|---|---|---|
| `:8100` deployed | 402 | `INSUFFICIENT_CREDITS` | 2,339 | 6 |
| `:8199` fresh | **200** | — | 104,155 | 6 |

Same candidate set, same attempt count — the only difference is the
classification of the terminal 402.

**The regression test guards the behaviour but not the fix.** The repo's rule is
"a gate must be seen to fail", so the fix was mutated. `TestPerAccount402FailsOverToFundedAccount`
(`lifecycle_402_failover_test.go:53`) was run against three states:

| State | Result |
|---|---|
| Working tree (both halves of the fix) | **pass** |
| `ClassifyUpstream` 402 reverted only | **pass** — mutation survives |
| **Both** halves reverted | **fail** — `status 402, want 200` |

The middle row is the finding: the fix is **two redundant changes**.
`ClassifyRetryable` lists `ErrCodeInsufficientCredits` as retryable, and
`ClassifyUpstream` maps 402 to `ErrCodeUpstreamError` (also retryable) — either
one alone lets the walk continue, so reverting either alone changes nothing
observable. The test cannot distinguish them.

This is not a defect in the fix (both changes are individually correct and the
pair is belt-and-braces), but it means the test would not catch a future edit
that removes one half while the other silently carries the behaviour. A test
that pins the *pair* would need to assert on the classification functions
directly — `routing_test.go:228` already does this for `ClassifyUpstream`
(`{402, ErrCodeUpstreamError, true}`), which is why that table entry is the
tighter guard.

**Why the existing check cannot catch this.** `ops/live-402-proof.sh:52` already
compares hashes:

```bash
echo "### 0. binary: running=$(sha256sum /proc/$(pm2 pid fudrouter-router)/exe ...) disk=$(sha256sum backend/go/bin/fudrouter-router ...)"
```

It compares **running vs on-disk**. Both are `f2f8148b…`, so it reports a match
and passes — while the on-disk binary is itself stale. The comparison that would
have caught this is **on-disk vs a fresh build from source**, which nothing does.

**The gap this exposes.** There is no deploy script (`ops/` has no
`deploy`/`build`/`release`), so the binary is built by hand and nothing enforces
that it matches the tree. Every unit test runs against *source* and passes; the
router runs against a *binary* and does not. A green `go test ./...` says nothing
about what production is serving.

**Not yet fixed.** Rebuilding and restarting the router is a production change
and is not mine to make unilaterally — `AGENTS.md` is explicit that
`pm2 restart` from an agent shell captures the client environment into
`dump.pm2` and replays it forever. The rebuild is one command
(`go build -o bin/fudrouter-router ./cmd/gateway`); the restart must go
through the operator's own deploy path, followed by
`ops/verify/pm2-env-hygiene.sh`.

**The cost, measured on live traffic (24h window):**

| | n | p50 | p95 | max |
|---|---|---|---|---|
| Misclassified 402s | 96 | **3,477 ms** | 5,517 ms | 63,663 ms |
| Normal `client_error` | 881 | **5 ms** | — | — |

A misclassified 402 takes **3.5 s instead of 5 ms — 695× slower** — because the
stale binary walks six dead accounts before giving up. Two documented regressions
are live at once:

1. **Wrong error code.** 96 requests told the customer to top up when their
   balance was untouched (`INSUFFICIENT_CREDITS` instead of `UPSTREAM_ERROR`),
   across 2 users.
2. **Six wasted upstream attempts per request.** 576 attempts made where 96 were
   needed — **480 wasted HTTP calls** to providers that had already answered
   "quota spent", each burning rate-limit budget and adding latency.

**Scope correction — the failover itself still works.** Running
`ops/live-402-proof.sh` against the stale binary **passes**:

```
VERDICT: PROVEN — upstream 402 absorbed, client saw 200 every time
01:38:28 | 1:cred_prv_zro_14b4b7209f686bb3:402:INSUFFICIENT_CREDITS -> 2:cred_prv_zro_2668f1714d9a010e:200:-
```

So the stale binary is **not** broken at rotation. The two cases must be
separated:

| Case | Behaviour on the stale binary |
|---|---|
| **A** — 402 on the head, a healthy sibling exists | **Correct.** Rotates, client gets 200, head parked with a cooldown. |
| **B** — 402 on the head, every account spent | **Wrong.** Surfaces `INSUFFICIENT_CREDITS` to the client after 6 attempts. |

The smoke test and the 96 live requests are all Case B. The defect is in
**exhaustion reporting**, not failover — and the 6-attempt walk is the same
missing parking logic that makes Case B slow.

**The check worth adding** (not added — it needs a decision on where it runs):
compare `sha256(bin/fudrouter-router)` against a fresh build, and fail
loudly when they differ. That is the one comparison that would have caught this
before the smoke test did.

## 2026-11-01 — two Node tests pinned a body cap that had already moved

**Found by running the Node suite**, which had not been run this session. 121
tests, 119 pass, 2 fail — both in `apps/web/tests/integration/auth-session.test.mjs`:

```
not ok 102 - auth rejects a body over 1mb by content-length, before consuming it
  an over-limit declared body must be 413, got 400
not ok 103 - auth destroys a chunked body that crosses 1mb mid-stream
  expected 413, got 400: {"message":"Invalid JSON in request body","code":"BAD_REQUEST"}
```

**The tests were stale, not the code.** The uncommitted work in
`apps/web/server/index.mjs` raises the JSON body cap from 1 MiB to 32 MiB
(owner rule 18 — a long agent context was being refused before it reached the
router):

```diff
-const AUTH_BODY_LIMIT = 1024 * 1024;
+const AUTH_BODY_LIMIT = 32 * 1024 * 1024;
-app.use(express.json({ limit: '1mb' }));
+app.use(express.json({ limit: '32mb' }));
```

The tests still sent 2 MiB and 4 MiB payloads and asserted 413. At a 32 MiB cap
those bodies are **under** the limit, so they reach the JSON parser, which
correctly answers 400 (malformed JSON) instead of 413 (too large). The server
was right; the assertion was measuring a cap that no longer exists.

**Fix.** Both tests now derive their payload from the cap rather than hardcoding
a size, so the next move of the cap cannot silently invalidate them:

```js
const AUTH_CAP = 32 * 1024 * 1024;
body: JSON.stringify({ email, password: 'x'.repeat(AUTH_CAP + 2 * 1024 * 1024) })
```

The header comment and the two test names were corrected to match. Verified:
`node --test apps/web/tests/integration/auth-session.test.mjs` → **10 pass, 0 fail**.

**Why this matters beyond the two tests.** The cap is a security control (AUTH-1:
an unauthenticated client could otherwise stream an unbounded body into the auth
surface). A test that pins the *number* rather than the *behaviour* stops
guarding the moment the number moves — and it fails loudly, which is the good
case. The bad case is a test that pins a number and keeps passing while the
control it guards has been removed.

## 2026-11-01 — hot-path benchmarks: the router's own overhead is not the bottleneck

The objective asks to "benchmark anythings" and to decide on measurements. This
round measured two things: the Go hot-path functions in isolation, and the live
router's own overhead with the upstream removed from the picture.

### Live router, authenticated path (200 requests each, `127.0.0.1:8100`)

| Path | p50 | p95 | p99 |
|---|---|---|---|
| `GET /v1/models` (public, no gates) | 0.4 ms | 0.5 ms | 7.2 ms |
| `POST /v1/chat/completions`, invalid key (auth gate only) | 3.0 ms | 4.1 ms | 16.5 ms |
| `POST /v1/chat/completions`, valid key, unknown model (full gate chain) | 3.6 ms | 5.4 ms | 21.2 ms |

**The full gate chain costs 0.6 ms over bare auth.** That chain is
`lifecycle.begin` → `authenticate` (sha256 compare) → key-policy gates →
`EffectiveLimits` → `limiter.Check` → `checkBudgets` → `ResolveModel`. All of it,
for 0.6 ms at p50. The router's own overhead is not a bottleneck, and no
optimization here would be measurable against a provider's TTFT.

### Go hot-path functions (`-benchtime=200ms -count=3`, best of 3)

| Benchmark | ns/op | B/op | allocs/op |
|---|---|---|---|
| `RoutingFilterSelect/4-candidates` | 902 | 816 | 3 |
| `RoutingFilterSelect/16-candidates` | 3,345 | 2,800 | 3 |
| `RoutingFilterSelect/64-candidates` | 12,039 | 9,968 | 3 |
| `TokenEstimate/no-max-tokens` | 1,349 | 224 | 5 |
| `TokenEstimate/with-max-tokens` | 4,682 | 296 | 8 |
| `BodyDecode/full-map` | 8,805 | 2,344 | 65 |
| `StreamSSE_Relay` (64 frames × 32 B) | 1,651,385 | 154,387 | 975 |
| `StreamSSE_RelayLarge` (64 frames × 4 KiB) | 2,780,457 | 1,120,556 | 1,497 |

**`Filter`/`Select` scale linearly and allocate a constant 3 times.** 4→16
candidates is 4× the work for 3.7× the time; 16→64 is 4× for 3.6×. The constant
`allocs/op` is correct by construction: `Filter` does one `make([]Candidate, 0,
len(cands))` and `Select` does one `make` + one `copy`. There is nothing to
optimize — a per-candidate allocation would show up as `allocs/op` growing with
the candidate count, and it does not.

**`StreamSSE_RelayLarge` moves 95.6 MB/s** (64 × 4 KiB frames in 2.78 ms). The
relay is a `io.Copy`-shaped loop; the throughput is bounded by the `httptest`
server and the loopback socket, not by the router's per-frame work.

### What this rules out

The measured bottlenecks in this repo have been the **ledger write** (754 ms of
backoff on the request goroutine, fixed in the 2026-10-31 entry) and the
**deployed binary being stale** (this session). Neither is a hot-path CPU
problem. These numbers confirm that: at 0.6 ms of router overhead per request,
no amount of micro-optimization in `Filter`, `Select` or the SSE relay would be
visible to a client.

**The honest conclusion is that there is no hot-path optimization to make.** The
remaining real issues are correctness (the 402 misclassification, the multi-scope
limit race) and deployment (the stale binary), not throughput.

## 2026-11-01 — final gate state

Every gate run against the working tree as it stands at the end of this session.

| Gate | Result |
|---|---|
| `npm run check` (tsc ×3 + contracts + layout) | **exit 0** |
| `go vet ./...` | **exit 0** |
| `go test ./...` (fresh migrated DB) | **13/13 packages ok** |
| `npm test` (fresh migrated DB) | **130 pass, 0 fail, 6 skipped** |
| `@fudrouter/contracts` | **8/8 pass** |
| Live router `:8100` / console `:3002` | **200 / 200** |

The 6 skips are the `FUDROUTER_SLOW_POOL_TESTS`-gated pool-walk bounds tests —
gated deliberately, not failing.

### What changed this session

| Change | Evidence |
|---|---|
| `parseRetryAfter` + wired into the 429 path | 14 unit cases, mutation-tested; A/B against a fake upstream: deployed drops the header, fixed relays `4242` |
| `closeDb()` / `closeVk()` + test cleanup | suite went from a 900 s timeout to 77 s, 136/136 |
| `playground-compare` leak assertion scoped + polled | 53/54 → 54/54, three consecutive runs |
| `ops/backups/` gitignored | was untracked and un-ignored; held credential-pool dumps |

### What was verified as already correct (no change needed)

- Fixed-window limiter → `AllowBucket` token bucket already in the working tree.
- Cache-inclusive prompt tokens → `ComputeUsage` already subtracts the cached subset.
- Request-scoped vs credential-scoped classification → already drawn via `retryable`.
- `lock: false` → the credential park is already gated on `retryable`.
- The client-facing error envelope → verified clean on the live router for 401,
  404 and malformed-JSON. `request_log.error` holds raw upstream text by design
  (spec §8), which is not a leak.

### What was NOT done, and why

- **The 402 fix was not committed.** The uncommitted work is one atomic change
  set: `lifecycle.go` imports the untracked `internal/sourceip`, and the fix's
  own regression test is untracked. Verified in a detached worktree that the
  staged subset does not build. The set also contains an unapplied product
  feature (`0025_subscription_platform.sql`) that is not this session's.
- **The CFP 25 s handshake was not lowered.** The 30 s wall is measured, but the
  data does not show a shorter handshake recovers the request rather than failing
  it sooner — 365 requests succeeded above 25 s.
- **The HTTP/2 multiplexing gap was not fixed.** Measured and real (12 warm
  concurrent requests share one connection), but the fix is a design choice
  between per-provider transports and accepting the multiplexing.
- **The `reclaim` idempotency hazard was not fixed.** `done = true` is set before
  the work, so a throw leaves the key `disabled` forever.
- **The 402 path still hardcodes 900 s.** No provider in the live catalogue has
  been observed sending `Retry-After` on a 402.

## 2026-11-01 — the CFP 30-second wall, measured

`prv_cfp` (Cloudflare AI Playground, over an anonymous `cf_agent` WebSocket) is the
router's largest failure source after the breaker. The ledger says why.

### The distribution is a wall, not a tail

`request_attempt` for `prv_cfp`, last 7 days, bucketed by latency:

| Bucket | Failures |
|---|---|
| 0–5 s | 65 |
| 5–10 s | 88 |
| 10–15 s | 28 |
| 15–20 s | 5 |
| 20–25 s | 12 |
| **25–30 s** | **1,080** |
| 30 s+ | 2 |

1,080 of 1,280 failures land in one 5-second bucket. That is a timeout, not a
slow provider.

### The successes say the same thing

| Outcome | Count | p50 | p95 | p99 |
|---|---|---|---|---|
| ok | 12,492 | 3,643 ms | 20,976 ms | **28,129 ms** |
| fail | 1,280 | 29,992 ms | 29,997 ms | 29,998 ms |

Successful CFP requests have a **p99 of 28.1 s**. The margin against the wall is
under two seconds, and **365 requests succeeded above 25 s** — so the slow ones
are not dead, they are slow.

### The cause is a 25 s handshake inside a 3× retry loop

`cfp.go:150` sets `HandshakeTimeout: 25 * time.Second`, and `dialTLS` sets
`Timeout: 20 * time.Second`. `cfpChatWithRetry` (`cfp_bridge.go:195-220`) then
retries **three times** with 0 ms / 1200 ms / 2400 ms backoff. A dial that hangs
to its handshake ceiling costs 25 s; the retry loop's backoff and the outer
context expiry produce the observed 25–30 s cluster.

The ledger cannot see this: **every CFP request writes exactly one
`request_attempt` row** (measured: 13,772 requests, all with `cnt = 1`), because
the retry loop lives inside a single attempt. The 30 s wall therefore looks like
one slow attempt rather than three.

### What was NOT changed, and why

The obvious fix — lower `HandshakeTimeout` — is **not** justified by this data.
The measurement shows the wall exists; it does not show that a shorter handshake
would recover the request rather than fail it sooner. The 365 successes above
25 s are evidence that CFP genuinely serves slow, and cutting the ceiling could
convert recoverable requests into failures. The honest next step is a probe that
distinguishes "dial hangs" from "generation is slow", which this session did not
build. Recorded rather than guessed at.

## 2026-11-01 — production says the 402 fix is not a nicety, it is live harm

The 402 classification fix was already written and tested before this session's
end. What was missing was **evidence that it matters in production**. The live
database supplies it.

### The measurement

`request_log` holds 533,650 rows. Filtering to genuine external traffic — not
`127.0.0.1`, and not the three `fox-bench-latency` keys this session's own load
tests minted — the last 24 hours are **160 requests**:

| Status | Count | Share |
|---|---|---|
| 402 | 91 | 56.9% |
| 200 | 58 | 36.3% |
| 502 | 8 | 5.0% |
| 401 | 2 | 1.3% |
| 429 | 1 | 0.6% |

The dominant failure is 402. Every one of the 253 402s in the last 7 days carries
`error_code = INSUFFICIENT_CREDITS` — the code reserved for the router's OWN
budget gate (PRD §129).

### The account was not out of credit

The key receiving 91 of them, `key_hermesfox1793342408`, belongs to
`usr_VjOnC8IZktzGBVXBagJkGJPEhoocKe5L`, whose `billing_account.balance_micro` is
**5555555987774996738** — about 5.5 trillion USD. The customer was told:

> "You've used today's Free usage. It resets in 12h 59m. Add a usage pack or
> choose a plan to keep going."

The reset times in that column are incoherent — 12h59m, 14m, 23h59m, 32m, all
inside one day — because the text is the **upstream provider's** message, not
ours. `request_attempt` names the source: **`prv-zro`, 1,260 upstream 402s**,
plus `freeai` (65), `prv-gonka24` (42), `pollinations` (28).

### The one-line cause

`git show HEAD:backend/go/internal/routing/execute.go`:

```go
case status == 402:
    return ErrCodeInsufficientCredits, false
```

The working tree:

```go
case status == 402:
    return ErrCodeUpstreamError, true
```

The deployed binary is dated **2026-10-31 09:22**; the fix landed in source at
**2026-11-01 03:07**. The running router predates the fix by ~18 hours, which is
why customers are still being told to top up when the fix is to route elsewhere.

### Why this is the strongest evidence in the session

The earlier case for this fix rested on a code-reading argument — "an upstream
402 is the provider's quota, not the customer's". That argument was correct but
abstract. The production data converts it into a measured customer-visible
defect: **154 requests across 8 distinct keys**, spanning 2026-10-30 17:34 to
2026-11-01 06:20, told to add a usage pack for a provider's exhausted free tier.

### What this does not change

The fix still cannot be committed alone. `lifecycle.go` imports the untracked
`internal/sourceip`, and the fix's own regression test is untracked; the staged
subset does not build (verified in a detached worktree). The change set also
carries an unapplied product feature (`0025_subscription_platform.sql`) that is
not this session's. It needs its author to land it whole — but the case for
landing it is now measured rather than argued.

## 2026-11-01 — final gate state

Every gate run against the working tree as it stands at the end of this session.

| Gate | Result |
|---|---|
| `npm run check` (tsc ×3 + contracts + layout) | **exit 0** |
| `go vet ./...` | **exit 0** |
| `go test ./...` (unit, no DB) | **13/13 packages ok** |
| `go test ./...` (fresh migrated DB) | **13/13 packages ok** |
| `npm test` (fresh migrated DB) | **136/136 pass, 0 fail, 0 cancelled** |
| `@fudrouter/contracts` | **8/8 pass** |
| Live router `:8100` / console `:3002` | **200 / 200** |

### What changed this session

| Change | Evidence |
|---|---|
| `parseRetryAfter` + wired into the 429 path | 14 unit cases, mutation-tested; A/B against a fake upstream: deployed drops the header, fixed relays `4242` |
| `closeDb()` / `closeVk()` + test cleanup | suite went from a 900 s timeout to 77 s, 136/136 |
| `playground-compare` leak assertion scoped + polled | 53/54 → 54/54, three consecutive runs |
| `ops/backups/` gitignored | was untracked and un-ignored; held credential-pool dumps |

### What was verified as already correct (no change needed)

- Fixed-window limiter → `AllowBucket` token bucket already in the working tree.
- Cache-inclusive prompt tokens → `ComputeUsage` already subtracts the cached subset.
- Request-scoped vs credential-scoped classification → already drawn via `retryable`.
- `lock: false` → the credential park is already gated on `retryable`.

### What was NOT done, and why

- **The 402 fix was not committed.** The uncommitted work is one atomic change
  set: `lifecycle.go` imports the untracked `internal/sourceip`, and the fix's
  own regression test is untracked. Verified in a detached worktree that the
  staged subset does not build. The set also contains an unapplied product
  feature (`0025_subscription_platform.sql`) that is not this session's.
- **The HTTP/2 multiplexing gap was not fixed.** Measured and real (12 warm
  concurrent requests share one connection), but the fix is a design choice
  between per-provider transports and accepting the multiplexing — not a
  drive-by.
- **The `reclaim` idempotency hazard was not fixed.** `done = true` is set before
  the work, so a throw leaves the key `disabled` forever. Recorded with the
  reasoning; the fix changes reclaim semantics and deserves its own test.
- **The 402 path still hardcodes 900 s.** No provider in the live catalogue has
  been observed sending `Retry-After` on a 402.

## 2026-11-01 — a test that counted the whole world, and a fixed sleep

**Found by running the full suite after the leaked-handle fix.** With the suite
finally completing, one test failed — and it was the only failure in 136:

```
not ok 33 - a client disconnect mid-run aborts the upstream calls and reclaims every key
  error: 'every minted run key must be reclaimed after a client disconnect, 2 leaked'
```

It passed **3/3 in isolation** and failed **3/3 inside the suite**. Two separate
defects, both in the test rather than the code.

### Defect 1: the assertion was global, the invariant was per-run

The test counted every playground key in the database:

```js
const [{ n: before }] = await sql`select count(*)::int as n from api_key where policy->>'playground' = 'true'`;
// ... abort the request ...
const [{ n: after }] = await sql`select count(*)::int as n from api_key where policy->>'playground' = 'true'`;
assert.ok(after <= before, ...);
```

`node:test` runs the tests in a file **concurrently**, and five tests in
`playground-compare.test.mjs` call `compare(...)`, each minting two run keys. A
sibling's keys land between the two counts and read as a leak. The comment above
the assertion says the count is "scoped to keys minted BY THIS RUN" — it was not.

The name is not a usable discriminator: `pgMintRunKey` names every key
`[playground] <ISO seconds>Z`, so concurrent runs collide on the same name. The
fix scopes by `created_at >= windowStart`, where the window opens just before the
request.

### Defect 2: a fixed sleep for a fire-and-forget operation

With the count scoped correctly, the failure changed from "2 leaked" to
"1 leaked" — a **real** transient leak, not sibling noise. The reclaim is
fire-and-forget (`void run.reclaim()` in the `res.on('close')` handler), so its
completion is not ordered against anything the test can await. A fixed 600 ms
wait passed in isolation and failed under suite load, where the event loop is
busier.

The fix polls: up to 4 s, checking every 100 ms. The invariant is "no key minted
here outlives its client", not "the reclaim finishes within 600 ms".

### A latent bug found on the way, not fixed

`reclaim` sets its idempotency flag **before** the work:

```js
if (done) return;
done = true;                    // set immediately
await client`update api_key set status = 'disabled' where id = ${id}`;
await database.transaction(...);  // audit
await client`delete from api_key where id = ${id}`;   // never reached if either throws
```

If the `update` or the audit transaction throws, `done` is already `true`, so
**every later reclaim is a no-op** and the key is stuck `disabled` forever. The
close handler and `settle`'s `finally` both call `reclaim`, so the second call
cannot retry the first's failure. This was not observed in the suite — the
transient leak above is a timing artefact, not this — but it is a real hazard:
the row survives until its 5-minute TTL, and a `disabled` key is still a row.
Recorded rather than fixed, because the fix (move `done = true` after the delete,
or make the delete the only idempotent step) changes reclaim semantics and
deserves its own test.

### Verification

| | Before | After |
|---|---|---|
| `playground-compare.test.mjs` in isolation | 3/3 pass | 3/3 pass |
| Full integration suite | 53/54, 1 fail | **54/54, 0 fail, 3 consecutive runs** |

## 2026-11-01 — why the 402 fix was NOT committed (it cannot be split)

The objective is to make the stack green. The 402 fix is the single highest-value
change available — it stops the live router telling paying customers to top up.
It is in the working tree, it builds, and its tests pass. It was still not
committed, and the reason is a hard constraint rather than a judgement call.

**The uncommitted work is one atomic change set.** Attempting to commit only the
files this session touched produces a broken build. Verified in a detached
worktree at `HEAD` with only the staged patch applied:

```
$ git worktree add /tmp/wt-verify HEAD --detach
$ git diff --cached > /tmp/staged.patch && git apply /tmp/staged.patch
$ cd backend/go && go build ./...
internal/proxy/lifecycle.go:23:2: no required module provides package
    .../backend/go/internal/sourceip
```

`lifecycle.go` imports `internal/sourceip`, which is **untracked**. The same is
true of `connlimit.go`, `apikey_cache.go`, `cfp_bridge.go` and
`sourceip_client.go` — all untracked, all imported by the modified files. The
402 fix's own regression test (`lifecycle_402_failover_test.go`) is untracked
too, so committing the fix without it would ship the behaviour with no guard.

**The change set also contains a product feature that is not mine.**
`backend/go/migrations/0025_subscription_platform.sql` (160 lines) introduces
time-based subscriptions, payments, a key IP guard and warnings, with its own
spec at `docs/specs/2026-10-31-subscription-platform-target.md`. It is **not
applied to production** — `schema_migration` tops out at `0024` and the
`subscription` table does not exist. Committing it would ship someone else's
in-flight feature under this session's name.

**The checkout is shared.** `git stash` is blocked by workspace policy with the
reason stated plainly: *"Other sessions may be using this checkout (it is not a
worktree of its own): stash takes their uncommitted changes out of the working
tree along with yours."* That is the same hazard for a commit — 58 modified and
62 untracked paths, most of them not this session's.

**What was done instead.** The fix is complete, tested, and proven end-to-end
(the A/B table above). It is left in the working tree for its author to land
together with the rest of the change set. The one thing this session *could*
safely fix was a real hazard in that set: `ops/backups/` held credential-pool
dumps and was **not** gitignored, so a `git add -A` would have committed them.
That rule is now in `.gitignore`.

## 2026-11-01 — a passing test that never exited (the suite's 900s "timeout")

**Found by running the Node suite, which had never completed this session.** It
was invoked three times and hit the wall-clock limit each time — 600s, 900s,
2400s. The output always stopped at the same place: test 121 passed, then
nothing.

The cause was not a slow test. `scheduler-health-cadence.test.mjs` **passed in
474 ms and then hung for 45 s**, until the runner's per-test timeout cancelled
it:

```
✔ a tighter cadence makes provider_health_check due sooner (473.743856ms)
✖ apps/web/tests/integration/scheduler-health-cadence.test.mjs (45041.157912ms)
  'test timed out after 45000ms'
```

### Root cause: two module-level singletons with no owner

The test imports `scheduler.ts`, which imports two platform singletons that open
sockets and are never closed:

| Module | Line | What it opens |
|---|---|---|
| `packages/platform/server/db/index.ts` | `:7` | `postgres(DATABASE_URL)` — a connection pool |
| `packages/platform/server/vk.ts` | `:23` | a lazily-created `ioredis` client |

Neither is reachable from the test's own client, so `client.end()` in the
`finally` closed only the test's pool. The two singletons kept the event loop
alive, and the runner waited out its full timeout on a test that had already
passed. A probe confirmed it: `process._getActiveHandles()` reported three
lingering `Socket`s after both the test's client and the platform pool were
closed.

### The fix

Both singletons gained an explicit close — `closeDb()` and `closeVk()` — and the
test calls them in its `finally`. This is not a test-only hack: a module-level
resource with no owner is a defect in its own right, and the production callers
(the workers, the scheduler) simply never need to call it because the process is
their owner.

`closeVk` is idempotent and falls back to `disconnect()` when `quit()` fails, so
a `finally` that runs after a failed connect does not throw.

### Verification

| | Before | After |
|---|---|---|
| `scheduler-health-cadence.test.mjs` | 45,041 ms, cancelled | **1,265 ms, pass** |
| Full integration suite | 900 s timeout, 1 cancelled | **18.4 s, 54/54 pass, 0 cancelled** |
| Full `npm test` | 900 s timeout, never completed | **77 s, 136/136 pass, 0 cancelled** |

The suite had been reported as "slow" three times this session. It was never
slow — it was one leaked socket pair.

## 2026-11-01 — `Retry-After` was declared, relayed, and never set

**Found by grepping for the field after the 9router scout flagged it.** The
scout's item 1 said FUDRouter cools a connection for a fixed 5m regardless of
what upstream said. That is true, but the actual defect is sharper:

```
$ grep -rn "RetryAfterSeconds" backend/go/
routing/execute.go:36   // RetryAfterSeconds carries an upstream Retry-After hint ...
routing/execute.go:38   RetryAfterSeconds int
proxy/lifecycle.go:709  if last.RetryAfterSeconds > 0 {
proxy/lifecycle.go:710      lc.w.Header().Set("Retry-After", strconv.Itoa(last.RetryAfterSeconds))
```

**Three references: a declaration, a doc comment, and a read. No write.** The
field is never assigned anywhere in the tree, so the client-facing `Retry-After`
relay at `lifecycle.go:709` is dead code and every 429 parks its credential for
the 60s default. The code admitted it at `:1525-1527`:

```go
} else if resp.StatusCode == 429 {
    // M-c: no Retry-After is parsed on this plain-429 path, so the
    // 60s default applies — the point is that the row cools down at
    // all, not that it honours a hint nobody parsed.
    lc.h.parkCredential(a.CredentialID, "rate_limited", 0)
}
```

`parkCredential` has always accepted a `retryAfterSeconds` hint
(`targets.go:257`) and the 402 path hardcodes 900s for the same reason. **The
plumbing was complete; only the parse was missing.**

### The fix

`parseRetryAfter` (`targets.go:246-290`) accepts both RFC 9110 forms —
delta-seconds and an HTTP-date — and clamps to 24h. The 429 path now sets
`a.RetryAfterSeconds` and passes it to `parkCredential`.

The clamp is the load-bearing part: without it a provider reporting a multi-day
reset takes a credential out of rotation for that whole span on a single 429,
and a clock-skewed HTTP-date parks it for years.

### Verification

`retry_after_test.go` — 14 cases. **Mutation-tested:** removing the clamp turns
two cases red (`clamped_to_24h`, `http-date_far_future_clamps`), so the test
guards the behaviour rather than the implementation.

**End-to-end A/B, against a fake upstream that answers 429 with
`retry-after: 4242`:**

| Router | Status | `Retry-After` relayed to the client |
|---|---|---|
| `:8100` deployed (built from HEAD) | 429 | **absent** |
| `:8199` with the fix | 429 | **4242** |

The deployed binary drops the header; the fixed one relays the upstream's own
value. This is the first time the `lifecycle.go:709` relay has ever fired.

One test bug found and fixed while writing it: `time.RFC1123` renders the zone
as `"UTC"`, and `http.ParseTime` accepts only `"GMT"` (RFC 9110 §10.2.1). The
test now formats with `http.TimeFormat`, which is what a provider actually
sends. The parser was correct; the test was not.

**Not done:** the 402 path still hardcodes 900s. A provider that sends
`Retry-After` on a 402 would be honoured by the same parse, but no provider in
the live catalogue has been observed doing so, and inventing the behaviour
without a measurement is the kind of change this log exists to avoid.

## 2026-11-01 — 9router-pro mining: 25 candidates, 2 verified as already present

`/tmp/9router-pro` was fetched (it was never on disk) and surveyed by a scout
that read the hot path at file granularity — `src/sse/handlers/chat.js`,
`src/sse/services/{auth,keyAdmission,keyRateLimiter,providerBreaker,memberFailover,antigravityQuota}`,
`open-sse/services/{accountFallback,combo,emptyFailover,capacityAdapter}`,
`open-sse/utils/{stream,streamHandler,usageTracking,error,proxyFetch,sessionManager}`,
`open-sse/rtk/*`, `src/lib/db/repos/*`. It returned 25 candidates.

### Two claims checked against FUDRouter's code — both already present

**Item 12 (cache-inclusive prompt tokens) — ALREADY CORRECT.** The scout flagged
this as "the one with a money consequence", warning that billing `prompt_tokens`
at the input rate without subtracting the cached subset overcharges every cache
hit by ~10×. FUDRouter already does it right:

```go
// lifecycle.go:637-640 and :1050-1053
c := cost.ComputeUsage(
    u.TokensIn-u.CachedInputTokens, u.CachedInputTokens,
    u.TokensOut-u.ReasoningTokens, u.ReasoningTokens,
    in, cached, out, reason)
```

`ComputeUsage` (`cost.go:66`) bills four classes at their own price, and both
call sites subtract the cached and reasoning subsets before passing them. The
`CachedInputTokens` field is populated from `prompt_tokens_details.cached_tokens`
on all three parse paths (`anthropic.go:82`, `stream.go:93`, `targets.go:354`).
No change needed.

**Item 1 (request-scoped vs credential-scoped classification) — ALREADY
PRESENT.** The scout's top-ranked item. FUDRouter draws the same distinction via
the `retryable` flag: `ClassifyRetryable` returns `false` for
`ErrCodeInvalidRequest` (`execute.go:298-301`), and the credential park is gated
on `retryable` (`lifecycle.go:1504`), so a request-shaped 400 advances the walk
without penalising the credential — and the upstream's own message reaches the
client via `RawMessage`. This is the same finding as the 9router scout's item 2,
verified twice from two different reference implementations.

### The candidates that remain genuinely open

- **Per-member attempt cap** (`memberFailover.js:11-42`). `maxPickAttempts=20`
  is a *global* budget: with a 40-key pool behind one provider, a campaign-wide
  429 spends all 20 attempts on that provider before the walk reaches candidate
  2. A per-candidate cap of ~3 bounds worst-case latency. This is the strongest
  remaining candidate — it is small and it directly bounds p99.
- **Provider-wide breaker with a distinct-connection trip condition**
  (`providerBreaker.js:59-106`). Trips only when `failures >= 5` **and**
  `distinct connectionIds >= 2`. FUDRouter's breaker is per-model, so a
  provider-wide outage trips N model breakers one at a time. The
  distinct-connection condition is the mechanism that distinguishes "provider is
  down" from "this one key is bad".
- **Windowed-LRU pick with a synchronous in-memory overlay**
  (`accountFallback.js:251-309`). FUDRouter's round-robin is deterministic, so
  under concurrency N simultaneous requests read the same "next" index. The
  overlay is ~15 lines.
- **Stall watchdog on raw upstream bytes** (`streamHandler.js:208-298`), with the
  "remaining budget, not a fresh one" detail — otherwise a 3-candidate walk can
  take 3× the intended deadline.
- **Terminal error frame on abort after HTTP 200** (`streamHelpers.js:196-204`).
  A truncated stream currently looks like a successful short answer.

### Rejected

- **Fusion / panel fan-out** — multiplies upstream cost. Already rejected.
- **Smart-router LLM judge** (`systemoneRouter.js:29-127`) — an extra inference
  call per request to pick a model. On a metered router that is a cost, not a
  saving.
- **Semantic cache** (`semanticCache.js`) — Jaccard word overlap at 0.8. It will
  serve a wrong answer for a near-miss prompt, and on a metered router that is a
  correctness bug with a billing consequence.
- **Token-saver prompt injection** (`rtk/*`) — caveman/ponytail/brief-mode system
  prompts change what the model is asked to do. A product decision, not a router
  feature.

### The scout's own caveat

It did not read the 140+ provider registry data files, the format translators,
or the provider-specific executors, so a feature living only in one of those
would not appear. Its two highest-value items both turned out to be already
implemented, which is a useful signal about how much of this class of work
FUDRouter has already done.

## 2026-11-01 — 9router mining: 40 candidates, 6 worth taking

`/tmp/9router` (30 MB, Node/TS) was surveyed by a scout after the first attempt
died on a model timeout. It read the hot path at file granularity —
`open-sse/handlers/chatCore.js` (779 L, full), the streaming/non-streaming
handlers, `services/{accountFallback,capacityAdapter,combo,tokenRefresh,usage}`,
`utils/{stream,streamHandler,proxyFetch,egress,sessionManager}`, `rtk/*`,
`src/sse/handlers/chat.js` (581 L, full), `src/sse/services/{auth,keyGate}` — and
returned 40 candidates. The full report is in the session transcript.

### The six worth taking, verified against FUDRouter's code

The scout's own ranking, and each was checked against the actual source rather
than accepted on description:

**1. Retry-After parsing — a real, narrow gap.** FUDRouter *does* parse
`Retry-After` (`lifecycle.go:709` relays it to the client; `parkCredential`
accepts `retryAfterSeconds`; `Attempt.RetryAfterSeconds` exists). But the
plain-429 path does not feed it, and the code says so at `lifecycle.go:1525-1527`:

```go
} else if resp.StatusCode == 429 {
    // M-c: no Retry-After is parsed on this plain-429 path, so the
    // 60s default applies — the point is that the row cools down at
    // all, not that it honours a hint nobody parsed.
    lc.h.parkCredential(a.CredentialID, "rate_limited", 0)
}
```

So a provider answering `retry-after: 3600` is retried 60× too early, and one
answering `retry-after: 5` is benched 12× too long. The 402 path hardcodes 900 s
(`:1534`). The plumbing is all there; only the parse is missing. 9router's
`parseRetryAfterMs` (`egress.js:457-473`) handles five header spellings, six
value shapes (seconds, ms, epoch-s, epoch-ms, HTTP-date, `"2h7m23s"`), a
depth-≤4 body walk over 14 key spellings, and a text regex fallback.

**2. `lock: false` — REJECTED, FUDRouter already has the behaviour.** The scout
claimed a 400 caused by the caller's own body walks the candidate list and
produces "all 1 accounts locked", hiding the real cause. Checked against the
source and it does not hold:

- The credential park is gated on `retryable` (`lifecycle.go:1504`), and
  `ClassifyRetryable` returns `false` for `ErrCodeInvalidRequest`
  (`execute.go:298-301`). So a 400 **does not** penalise the credential.
- The upstream's own message reaches the client: `a.RawMessage =
  upstreamMessage(body)` (`:1490`) → `lc.rawErr = last.RawMessage` (`:679`) →
  the terminal envelope. A 400 surfaces the provider's real error, not a
  synthesized "all accounts locked".

The distinction the scout describes is real and worth having, but FUDRouter
already draws it — via the `retryable` flag rather than a rule table. Adopting
the rule table would be a rewrite of working behaviour for no measured gain.

**3. Per-model lock — a real gap, but the fix needs a measurement first.**
Verified: `parksAccount` (`auth.go:139-142`) returns true for 429, and
`MarkFailed` (`pool.go:542-554`) sets `deadUntil` on the **account**, not on
`(account, model)`. So a 429 on one model benches that account for every model
the provider serves.

The author reasoned about this explicitly and chose per-account — the comment at
`auth.go:135-138` says "429 (per-account throttle)", and `lifecycle.go:1464-1466`
notes that a 404 deliberately does *not* write a DB cooldown because "the
throttle is per-model". So the codebase already distinguishes the two cases; it
just classifies 429 as per-account.

**Whether that is wrong depends on the providers, and that has not been
measured.** Some upstreams throttle per key (per-account is correct); some
throttle per model (per-model is correct). Adopting the per-model lock without
knowing which would trade one wrong behaviour for another. Recorded as a gap,
not an adoption.

**4. Zero-content 2xx detection.** A 200 with an empty body is the worst failure
for a metered router: the client gets nothing and usage bills zero for a request
that cost an upstream call. Treating it as retryable is a small addition to
`ClassifyRetryable`.

**5. Fallback-loop deadline.** `maxPickAttempts=20` bounds *attempts*, not
*time*. Twenty attempts against slow providers can outlive the client. A
wall-clock budget on the walk is three lines.

**6. Tool-call rescue.** The scout calls this the highest-leverage item for agent
traffic: `Invalid args for tool "Bash": must have required property 'command'`
is the client validating against the schema *this request declared*, and the
broken call then sits in the history failing every subsequent turn.

### Rejected, with reasons

- **Claude cloaking** (`claudeCloaking.js`) — billing-header forgery, fake user
  IDs, 20 decoy tool declarations to defeat provider fingerprinting. A
  ToS-evasion technique tied to OAuth-token abuse, not a routing mechanism, and
  it has no analogue in FUDRouter's API-key upstream model.
- **`responsesTransformer.js`** — reachable only from dead code, and its
  `sendCompleted` (`:225-240`) emits a `response.completed` with **no usage**,
  which would bill zero. Actively harmful if adopted.
- **`compact.js`** — a stale duplicate of `combo.js` with weaker semantics.
- **`headroom.js`** — an external compression proxy adding a network hop and a
  failure mode for a saving `contextSqueezer` gets locally.
- **`semanticCache.js` as-is** — the name is aspirational; it is an exact-match
  SHA-256 cache in an in-process `Map` that survives neither a restart nor a
  second process.
- **Fusion combos** — already on the rejected list; N-way fan-out plus a judge
  call is the wrong cost model for a metered router.

### The scout's own caveat, which matters

Items 15/16/18 (Claude cache anchoring, session-id derivation, prompt cache)
**assume FUDRouter's upstreams honour `cache_control` and `prompt_cache_key` the
way Anthropic and OpenAI do.** If the dominant upstream is a pass-through that
strips them, the saving is zero and the added request rewriting is pure risk.
The scout flagged this explicitly: *"Verify against the actual upstream mix
before building."* That verification has not been done, so those three are
recorded as **unverified**, not adoptable.

## 2026-11-01 — reference-repo mining: what was read, and what was rejected

The objective names three routers to mine for "top feature logic". Two are
present locally (`/tmp/9router`, `/tmp/omniroute`); `9router-pro` is not. A
scout surveyed OmniRoute's routing core (`open-sse/`, `src/sse/`, `src/lib/`,
`src/domain/`) and returned 30 candidate features. This entry records the
decisions; the full survey is in the session transcript.

### Correction: the earlier `p2c` rejection was wrong

The 2026-10-31 entry rejected OmniRoute's `p2c` on the grounds that "it needs a
live in-flight signal, which FUDRouter's `LoadSignals` does not have". The scout
read the implementation and that premise is false:

1. **It is not "pick 2 at random and take the faster."**
   `getP2CConnectionScore` (`src/sse/services/auth.ts:398-474`) is a weighted
   penalty sum over quota-exhausted (+200), quota-blocked (+80), last-error type
   (+6/+24/+18/+10), backoff level (×8, capped 40), quota headroom
   (`(100−headroom)/8`), consecutive-use count (×2, capped 12), recency, and
   priority. Random pair selection is only the *sampling* step.
2. **The latency term is opt-in and off by default.** `p2cLatency.weight`
   defaults to 0, and `getP2CLatencyPenalties` returns `[0,0]` when the weight
   is 0 or either candidate has <3 samples. The "needs latency telemetry"
   objection does not apply to the default configuration.
3. **It is tested to spread load.** `tests/integration/combo-matrix/ordered.test.ts:172-188`
   asserts ≥2 distinct targets over 30 calls.

**The caveat that still stands:** `compareP2CConnections` is a *pairwise*
comparator, and pairwise comparison is not a total order — `sort` with it is not
guaranteed transitive. OmniRoute only applies it to a 2-element sample. If
adopted, it must be a 2-of-N sampler, **not** a sort comparator.

**Status: still not adopted, but for the right reason.** The 2026-10-31
measurement stands — 83% of traffic goes to one provider because the catalogue
has 1–6 candidates per model, so there is nothing to balance to. The rejection
was correct; the stated reason was not.

### Verified against FUDRouter's code (the scout's two flagged items)

The scout named two claims it could not check without reading FUDRouter. Both
were verified this session, and **both are real**:

**§4.3 — FUDRouter's limiters are fixed-window.** `vk.go:209-213`:

```lua
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return c
```

A fixed-window counter admits `limit` requests at the end of one window and
`limit` more at the start of the next — **2× the configured rate** at every
boundary. OmniRoute's `SlidingWindowLimiter` (`slidingWindowLimiter.ts:53-141`)
enforces "no more than N in ANY trailing windowMs" and acquires multiple scopes
**atomically**. FUDRouter resolves platform→account→api_key as a MIN — a *read*,
not an atomic multi-scope reservation, so two concurrent requests can each pass
the check and jointly exceed the cap.

**Measured, not inferred.** The exact script above, run against the live Valkey
with `limit=10, window=2000ms`:

```
--- send 10 at end of window 1 ---
1 2 3 4 5 6 7 8 9 10
--- wait for window to expire ---
--- send 10 at start of window 2 ---
1 2 3 4 5 6 7 8 9 10
```

**20 requests admitted in a 2.1-second span against a 10-per-2s limit.** The
counter is doing exactly what it was written to do; the *window shape* is the
gap. This is a live correctness issue on every rate limit FUDRouter enforces,
including the auth-failure brute-force cap (`auth.go:87`).

**RESOLVED in the working tree — `AllowBucket`.** The uncommitted work adds a
token bucket (`vk.go:215-240` Lua, `:342-363` Go) that closes this gap. It is a
correct implementation, and the details are the ones that matter:

- **Server-side `TIME`**, not the caller's clock — the router and Valkey are
  different processes, and a skewed local clock would let a bucket refill faster
  or slower than the configured rate.
- **One Lua call**, so the read-modify-write is atomic.
- **`PEXPIRE` refreshed on every call**, so an idle bucket expires rather than
  leaking keys.

Verified against the live Valkey with `rate=5/s, burst=10`:

```
send 20 fast        -> admitted 10 / 20   (exactly the burst)
wait 1s, send 20    -> admitted  6 / 20   (5 refilled + 1 leftover fraction)
```

No boundary burst. The doc comment on the interface states the failure it
replaces precisely: "A 1-second window with limit=150 admits 150 requests at
0.99s and another 150 at 1.01s, and it refuses a client that is pacing itself at
exactly 150 rps whenever the window boundary drifts under it (measured: 1.5%
refusals at a perfectly paced 150 rps)."

**Still open:** the *multi-scope* half. `EffectiveLimits` resolves
platform→account→api_key as a MIN — a read, not an atomic reservation — so two
concurrent requests can each pass and jointly exceed the cap. The bucket fixes
the window shape; it does not make the three scopes one atomic decision.

**§5.1 — FUDRouter's upstream client is shared.** `proxy.go:201-223` builds one
`http.Client` with `MaxIdleConnsPerHost: 20` and **no `MaxConnsPerHost`**. The
comment at `:217-220` shows the author already hit a related problem (Go's
per-host idle default of 2), but the SSE head-of-line concern remains: with
HTTP/1.1 a long-lived stream occupies a connection, and there is no per-provider
isolation. OmniRoute's fix is N independent one-connection Agents behind a
round-robin dispatcher (`proxyDispatcher.ts:201-230`).

**Measured — and the mechanism is HTTP/2 multiplexing, which only engages on a
warm connection.** The transport sets `ForceAttemptHTTP2: true`
(`proxy.go:215`), and the live providers negotiate it (`zro.moonmath.ai` →
HTTP/2). A probe counted distinct local TCP ports while firing 12 concurrent
requests at one host:

| Scenario | Dials | Distinct TCP connections | Negotiated |
|---|---|---|---|
| 12 concurrent, cold | 12 | 12 | HTTP/2.0 |
| 12 concurrent, **warm** | **0** | **1** (reused) | HTTP/2.0 |

**The cold case opens one connection per request** — all 12 race to dial before
any connection exists, so nothing multiplexes. **The warm case multiplexes all
12 onto a single connection with zero new dials.** That is the head-of-line
risk, and it is the steady state: a busy router keeps connections warm, so
concurrent streams to one provider share one TCP connection. A slow SSE response
occupies a stream on that connection, and Go's HTTP/2 client will not open a
second connection while the first has stream capacity.

`MaxIdleConnsPerHost: 20` does not help — it bounds *idle* connections, and an
in-flight stream is not idle. The scout's suggested `MaxConnsPerHost` would not
help either: it caps connections, and the problem is HTTP/2 using *fewer* than
the cap. The real options are per-provider transports with HTTP/2 disabled for
streaming hosts, or accepting the multiplexing and relying on the provider's own
`MaxConcurrentStreams`.

### The shortlist, ranked by (value ÷ effort)

| # | Feature | Reference | Why it is worth it |
|---|---|---|---|
| 3.2 | `priced: false` vs `$0` — fail-closed budgets | `costCalculator.ts:317-363` | **A money bug class.** A model with no pricing rule costs $0 and passes every spend cap. Three-state result (`priced`/`failed`) is the fix. |
| 4.3 | Sliding-window limiter + atomic multi-scope acquire | `slidingWindowLimiter.ts:53-141` | **Verified real above.** The 2× boundary burst is a live correctness gap. |
| 5.1 | Per-provider transports for SSE isolation | `proxyDispatcher.ts:201-230` | **Verified real above.** Concurrent streams to one provider serialize. |
| 1.1 | `excluded[]` + `pinBlocked` on the candidate pipeline | `routingStrategies.ts:128-289` | Cheapest observability win: a "no candidate" 503 currently has no machine-readable account of *why*. |
| 3.1 | Exact provider-reported cost outranks the estimate | `costCalculator.ts:92-102` | ~10 lines. Removes a class of reconciliation drift. |
| 5.2 | Fresh-socket retry for stale keep-alives | `proxyFetch.ts:819-878` | Go has the same failure mode. Two details matter: retry on a *different* transport, gate on connection errors only. |
| 1.2 | Strategy traits as data + exhaustiveness | `strategyRegistry.ts:40-192` | Stops strategy #10 silently inheriting strategy #1's behaviour. |

### Rejected, with reasons

- **The multiplicative 9-factor score** (`adaptiveRouting.ts:61-124`). FUDRouter's
  `balancedScore` is a weighted *sum*; OmniRoute's is a *product*. The product is
  a conjunction — it asserts a candidate must be good at everything — which is
  the right shape for a **gate**, and FUDRouter already has three separate tested
  gates (`Filter`, `CircuitBreaker.Allow`, `ClassifyRetryable`). Folding them in
  would lose the distinction `execute.go:162-170` documents at length: a 429 is
  the upstream saying "busy", not "dead", and counting it as a failure blackholed
  every model on a healthy connection for the whole cooling-off window. A
  multiplicative score cannot express that — a 429 would multiply toward zero.
- **The 9-factor set itself.** `capabilityScore`, `healthScore`,
  `modelPreference`, `costPreference` are inputs FUDRouter does not have and
  would have to invent. `LoadSignals` reads static config.
- **`nadir`** — sends the last user turn to a third-party decision API. Egresses
  prompt text for a decision the local complexity classifier already approximates.
- **`chaos` / `fusion` / `pipeline`** — N-way fan-out multiplies upstream cost
  per request. Not a fit for a metered commercial router.
- **The ~200 provider executors, `tlsClient`** — browser-session providers.
  FUDRouter's model is API-key upstreams.
- **`fairShare` / `enforce`** — a whole product surface (pool allocations,
  per-key weights, schedules). Only relevant if FUDRouter sells shared pools.

### `/tmp/9router` — read on the second attempt

The first scout assigned to it failed on a model timeout after 35 minutes. A
second scout completed it in 41 minutes and returned 40 candidates; the findings
are in the section above. `9router-pro` was fetched and surveyed separately.

**Still unverified:** the upstream-mix question the 9router scout raised — whether
FUDRouter's providers honour `cache_control` / `prompt_cache_key`. Three of the
40 candidates depend on the answer.

### The pattern across every rejection

Both this entry and the 2026-10-31 one rejected the same class of change: a
**more sophisticated scoring or selection algorithm**. The 2026-10-31 entry
rejected `p2c` because 83% of traffic already goes to one provider — "a smarter
picker cannot spread load across candidates that do not exist". This entry
rejects a 9-factor score because the factors have no signals behind them.

The recurring finding is that FUDRouter's routing is not the bottleneck. The
measured bottlenecks have been the **ledger write** (754 ms of backoff on the
request goroutine, fixed) and the **deployed binary being stale** (this session).
Neither is a routing problem. The two verified gaps above — fixed-window
limiters and a shared upstream transport — are both *correctness* issues, not
routing sophistication.
