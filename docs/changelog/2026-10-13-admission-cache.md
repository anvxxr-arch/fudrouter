# Admission was 525µs of Postgres round trip on every request

`checkBudgets` read three things from Postgres per request: the billing
account plus the environment's flat monthly budget (`BudgetGateState`, one query),
the scoped `budget` rows (`BudgetsFor`, one query), and the key's `rate_limit`
chain (`EffectiveLimits`, one query — only its platform hard-limits row was cached).

Measured with the package's own benchmark (`BenchmarkBudgetGate/no-budgets`,
`-benchtime=200000x` on the i5-6500T on this box):

| | ns/op | allocs/op |
|---|---|---|
| before | 525,393 | 50 |
| after | **391** | **0** |

That is 525µs of pure round-trip latency — against single-digit microseconds for
everything else in admission (`LimiterCheck` 2.8µs, `RoutingFilterSelect` 4.8µs,
`TokenEstimate` 1.5µs) — paid unconditionally, including for the common case
of a workspace with no `budget` rows at all.

The round-trip budget for one canonical-slug request went **10 → 5**:

| # | statement | before | after |
|---|---|---|---|
| 1 | `LookupAPIKey` (auth) | 1 | 1 |
| 2 | `platform_hard_limits` | 1 (60s cache) | 1 (60s cache) |
| 3 | `rate_limit` chain | 1 | **0** |
| 4 | `billing_account` + `environment.monthly_budget` | 1 | **0** |
| 5 | `budget` rows | 1 | **0** |
| 6 | `ResolveModel` | 1 | 1 |
| 7 | `CandidatesBatch` | 1 | 1 |
| 8 | `request_log` + `credit_ledger` | 1 | 1 |
| 9 | `request_attempt` | 1 | 1 |

## Why a cache and not a smaller query

The three reads re-derive ownership from ids `LookupAPIKey` already returned, so
they can be folded into one statement — but one statement is still a round trip,
and the target is a request that does not wait on Postgres at all for **policy**.
The data plane is a stateless replica fleet over one Postgres: at 100k RPS a single
round trip per request is 100k queries/s, which one Postgres cannot answer, so the
cost is a throughput ceiling rather than a latency constant.

## What is cached, and for how long

`store/admission.go` holds three maps behind one `sync.RWMutex`, filling on miss and
bounding the map with `admissionCacheMax` (8,192 keys).

- **`rate_limit` chain and `budget` rows: 60s** (`policyTTL`). These change on an
  operator edit, not on traffic — the same bound `hardLimitCache` already puts on
  `platform_hard_limits`, and the limiter's own counters in Valkey are what
  actually enforce, so the window is a policy lag, not an enforcement gap.
- **`billing_account`: 5s** (`gateTTL`), because this entry carries a BALANCE and a
  balance only falls. It is not left to expire: `ChargeRequest` drops the entry the
  moment a charge crosses the hard stop, so the next request reads the authoritative
  row instead of a pre-charge balance (see `InvalidateAdmission`). A suspension from
  the console still propagates within one `gateTTL`.
- **`EffectiveLimits` itself stays uncached** and keeps its query-count contract;
  nothing in this repo caches an error, so a Postgres read that fails still refuses
  the request (spec §10, fail closed).

`LookupAPIKey` is deliberately **not** cached: a cached key row would delay
revocation, and that is the security boundary the data plane owns.

## Verified

- `TestAdmissionReadsAreOneRoundTrip` pins both states: **WARM = 1 query**
  (authentication only, down from 4) and **COLD = 5** (a fresh Store, every
  cache empty).
- `TestFullRequestRoundTrips` reports **5 store round trips** for one chat
  request, down from 10.
- `admission_cache_test.go` pins the four ways the cache can be wrong: 50 repeat
  reads issue 0 queries; the account entry expires on its TTL (so a suspension is
  visible after it); `InvalidateAdmission` drops the entry; and a charge that
  crosses the hard stop is visible to the very next gate read without waiting out
  the TTL.
- Reverting `checkBudgets` to the uncached reads turns the query-count contract
  red.

## What is left between this and 100k RPS

Not claimed as done, and the arithmetic is the reason. At 5 round trips per
request, 100k RPS is 500k Postgres queries/s, which one Postgres cannot answer —
so the remaining work is not tuning, it is removing the round trips:

| remaining | count | why it has not been removed unilaterally |
|---|---|---|
| `LookupAPIKey` (auth) | 1 | a cached key row delays REVOCATION; this is the security boundary the data plane owns |
| `ResolveModel` + `CandidatesBatch` | 2 | both read the catalogue, which the console writes in ANOTHER process. `catalog_cache.go` already documents the 45s window and says the fix is "either an invalidation the console publishes (it shares this Valkey) or an ADR agreeing the window is acceptable. Both are decisions, not a drive-by." |
| `ChargeRequest` + `InsertRequestAttempts` | 2 | the metering write. `credit_ledger` is the billing record of truth (`usage_charge` exactly-once, `balance_micro` a reconcilable cache), so buffering or batching it is a billing-correctness decision, not a performance one |

The connection pool is not the constraint: `poolConfig` sets `MaxConns = 20`
(pinned by `TestPoolConfigDefaults`), and 20 connections at 5 × ~117µs per request
caps a single replica at roughly 34k RPS — above what the query count allows
anyway. The reads that remain are a policy decision; the writes that remain are a
billing-integrity decision.
