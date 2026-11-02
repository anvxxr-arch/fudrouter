# Phase log — subscription platform (2026-10-31)

Target: `docs/specs/2026-10-31-subscription-platform-target.md`.
Every phase: implement → 4-case test → benchmark where it touches the hot path →
skeptical re-read.

## What shipped

| Phase | Deliverable | Evidence |
|---|---|---|
| Schema | `0025_subscription_platform.sql` — subscription, payment, api_key_ip, member_warning + `api_key.restricted_at/reason` | applied clean on a fresh DB (`fudrouter_sub_test2`) |
| Entitlement | `internal/entitlement` — single key, 3 IPs, 5 concurrency, auto-restrict, grace window | 20 subtests, 4 cases each |
| Payments | `packages/platform/server/payments.ts` — plan table, QRIS builder, grant rule, approval | 21 tests |
| Bots | `packages/platform/server/bots.ts` — pay/warn/marketplace, admin approval | 18 tests |
| Surfaces | pricing (subscriptions only), subscription/IP/warning endpoints, Telegram login, 32 MB cap | `npm run check` exit 0 |

## Benchmarks (i5-6500T, median of 3)

### Routing select — the biggest win

| `RoutingFilterSelect/64-candidates` | Before | After | Change |
|---|---|---|---|
| ns/op | 66,559 | 12,000 | **−82%** |
| B/op | 15,875 | 9,968 | −37% |
| allocs/op | 322 | 3 | **−99.1%** |

| `RoutingFilterSelect/16-candidates` | Before | After | Change |
|---|---|---|---|
| ns/op | 17,397 | 4,500 | −74% |
| allocs/op | 82 | 2 | −97.6% |

**Root cause, found by profiling not guessing:** `selectReason` was 96% of all
allocated objects (917,531 of 955,331). It built a `fmt.Sprintf` reason string
for **every** candidate, but only the candidate that is actually attempted ever
has its reason persisted (`request_attempt.reason`). Fix: store the reason
*inputs* on the candidate and build the string lazily in `Reason()`. A second
fix stored the `Plan` by pointer, not value — copying it per candidate had grown
the slice from 15 KB to 38 KB.

### Entitlement admission — the capacity proof

| Benchmark | ns/op | allocs/op |
|---|---|---|
| `Admission` (full: sub → IP → acquire → release) | 352 | **0** |
| `AdmissionParallel` (GOMAXPROCS goroutines) | 556 | **0** |
| `Admission15k` (3000 keys × 5 slots, all in flight) | 91 | **0** |

At 352 ns/op a single core admits ~2.8M requests/sec. The 15k-concurrent target
(3000 users × 5) is met with ~180× headroom on one core.

**Root cause of the first 2 allocs/op:** `Acquire` returned a `func()` closure
that captured the guard and key id, so it escaped to the heap — one allocation
per request, 15k live closures at target load. Fix: return a `Slot` value with a
`Release()` method. The remaining 1 alloc/op was the *benchmark's* own
`"key_"+Itoa` string, not the guard; precomputing the keys took it to 0.

## Skeptical re-read (criterion 5) — what is still not proven

1. **`BodyDecode/full-map` is 8.8 µs / 65 allocs.** This is `json.Unmarshal`
   into `map[string]any`, which is deliberate: the body is forwarded verbatim to
   the upstream, so it cannot be decoded into a typed struct without dropping
   unmodelled fields. Not a defect; a documented tradeoff. Left alone.

2. **The 15k benchmark proves the GUARD, not the whole router.** It measures
   admission in isolation. The full path (auth → limits → budget → route →
   upstream) is not load-tested end-to-end — there is no e2e/load harness in the
   repo (AGENTS.md "Known gaps"). The guard is the piece this directive added,
   and it is proven; the rest was already benchmarked separately.

3. **Cache hit rate (rule 19) is now measured, but not yet at target under
   load.** The counters exist: `vk.Client.CacheStats()` tallies hits/misses on
   every `GetJSON`/`GetJSONMany`, and `/health` reports
   `{"cache":{"hits":N,"misses":M,"hit_rate":R}}`. Verified end-to-end against
   the real DB + Valkey: 5 catalogue reads produced 2 hits, 0 misses,
   `hit_rate: 1`. What is NOT yet proven is the ≥60% figure *under production
   load* — that needs a load run reading the counter, and there is no load
   harness (AGENTS.md "Known gaps"). The measurement now exists; the load run
   does not.

4. **The bots have no transport adapter yet.** `bots.ts` is the pure decision
   core (tested); the Discord/Telegram HTTP adapters that call it are not
   written. The decisions are proven; the wiring is not.

5. **`payment.status` gained `claimed`/`confirmed`/`rejected`** after the first
   migration draft. The CHECK was widened before any DB applied it, so there is
   no migration-history hazard — but a DB that applied the first draft would
   need the CHECK altered. None did (verified: only scratch DBs).

## Verification run

- `go vet ./...` — clean
- `go test ./...` — all packages pass
- `npm run check` — exit 0 (tsc ×3, contracts, structure)
- `node --test packages/platform/test/*.test.mjs` — 46 pass, 0 fail
- `npm test --workspace apps/web` — 136 tests, 82 pass, 0 fail, 54 skipped (no DB)
- `/health` smoke against real DB + Valkey — cache block present, counter moves
  (5 catalogue reads → 2 hits, `hit_rate: 1`)
