# High-Availability Hardening of the FUDRouter Data Plane

## Scope

The Go data plane (`backend/go`) already carries substantial HA machinery: a Valkey circuit breaker, a deadline-bounded retry/fallback walk, per-connection credential pools with bounded walks, a per-connection pacing gate, a model health sweeper, and a detached ledger write with retry. This plan does **not** rebuild any of that. It closes the specific gaps where the existing machinery is dead, disconnected, or unbounded.

**In scope:** routing strategy correctness, failover completeness, upstream backend hardening, and the observability that makes an HA claim verifiable.

**Out of scope (explicitly not touched):** the Node control plane, the scheduler/workers, migrations beyond one additive index, the contracts surface, the UI. No new top-level directories (structure gate). No new dependencies.

---

## Corrections to the first draft of this plan

Two findings in the first draft were **wrong**, and one was overstated. They are recorded here rather than silently dropped, because the wrong version would have produced a duplicate implementation of a job that already exists.

**F4 (first draft) — WITHDRAWN.** The draft claimed "the health sweeper's results never reach routing" and proposed a new `store.RecordModelHealth` writing measured p95 into `connection.config`. That job already exists: `routing_signals_refresh` (`packages/platform/server/workers.ts:1296-1339`) aggregates the trailing 7 days of `request_log` per connection and merges `p95_latency_ms`, `availability`, `ttft_p95_ms`, `signal_samples`, `signal_updated_at` into `connection.config` — precisely the keys `routing.LoadSignals` reads (`routing/select.go:144-158`). It is registered (`workers.ts:1599`) and scheduled every 30 minutes (`scheduler.ts:127-131`). Its own doc comment describes the same gap the draft "found" and then closes it. **Step 4 is deleted.** Implementing it would have been a second writer of the same keys, fighting the job.

**F3 (first draft) — OVERSTATED, still valid.** The draft said a credential parked `'invalid'` "can only be revived by the hourly TypeScript probe or an operator" and that the revival mechanism "does not exist in this tree." The mechanism does exist: `credential_validation` writes `status='healthy'` and clears `cooldown_until` on a passing probe (`workers.ts:654-664`), and its comment at 623-625 says so explicitly. The real gap is **latency, not absence**: the job is a fan-out, one job per enabled connection, hourly (`scheduler.ts:152-157`), batch 250 (`workers.ts:462`). A credential parked by a transient 401 stays dark for **up to ~1 hour**. That is still worth closing — a provider-side auth blip should not cost an hour of capacity on a 663-account farm — but the justification is "too slow," not "missing."

**F1, F2, F5, F6, F7, F8, F9 — unchanged.** Each was verified by direct read and, for F8, by running the test.

---

## Findings that drive the plan

Verified by direct read of every file named below, plus five read-only scouts. Each finding cites its anchor.

### F1 — The circuit breaker's configuration table is dead code

`proxy.New` constructs the breaker as `routing.NewCircuitBreaker(c, nil)` (`proxy/proxy.go:148`). `NewCircuitBreaker` turns a nil map into an empty map (`routing/execute.go:398-406`), so `CircuitBreaker.config` (`execute.go:490-495`) **always** returns `DefaultBreaker()` = `{FailureThreshold: 5, WindowSeconds: 60, OpenMs: 30000, HalfOpenProbes: 2}` (`execute.go:376-378`).

`store.CircuitBreakers` (`store/policy.go:138-157`) reads the `circuit_breaker` table correctly and has **zero callers**. The comment at `proxy.go:75-76` ("config comes from the circuit_breaker table and is refreshed with the routing policy") is false today.

Consequence: an operator who tunes a breaker row in the console changes nothing. Every target in the fleet runs one hardcoded policy.

### F2 — The breaker counts consecutive failures, not a failure rate

`CircuitBreaker.Result` (`execute.go:470-484`) does `st.Failures++` and opens at `>= FailureThreshold`. `WindowSeconds` is used **only** as the Valkey TTL (`execute.go:520`), never as a failure window. A target that fails once an hour for six hours opens the circuit; a target that fails 4 times in 10 seconds and then recovers never does. The spec (`docs/specs/2026-09-30-platform-schema.md:398-401`) defines `window_seconds` as a column of the config, and the natural reading is a window.

### F3 — Credential recovery from success is absent in the data plane

`parkCredential` (`proxy/targets.go:303-325`) is the only Go writer of `credential.status`/`cooldown_until`. A successful exchange (`lifecycle.go:1438-1441`) returns immediately and touches nothing.

A credential parked `'invalid'` by a 401/403 has `cooldown_until = NULL` and is excluded by the **status** clause, not the cooldown clause (`store/catalog.go:588-589`). The only revival path is the hourly `credential_validation` fan-out (`workers.ts:654-664`, `scheduler.ts:152-157`).

Consequence: one transient 401 (a provider-side auth blip, a clock skew, a mass session invalidation) removes a credential from rotation for **up to an hour**. On a 663-account farm that is a silent, avoidable capacity loss. The data plane already knows the credential works — it just served a 200 with it — and throws that knowledge away.

### F5 — `request_attempt` is write-only forensics

`InsertRequestAttempts` (`store/logs.go:262`) records one row per exchange with `latency_ms`, `error_code`, `retryable`, `http_status`. Nothing reads it back for any decision. It is the only per-attempt latency record in the system. **Not addressed by this plan** (see "Explicitly not doing"); recorded so it is not lost.

### F6 — The source-IP rotating client has no response-header timeout

`rotatingClient` (`proxy/sourceip_client.go:81-102`) clones `http.DefaultTransport`, which carries **no `ResponseHeaderTimeout`** and no `Timeout`. Every other outbound client in the tree bounds the header phase: `newUpstreamClient` sets `ResponseHeaderTimeout: 120s` (`proxy.go:223`), `guardedOAuthClient` sets `30s` (`pool.go:591`). A keyless upstream that accepts the connection and then never sends a response header hangs the request until the caller's context expires — and for a **streaming** request the caller's context is `r.Context()` with no deadline at all (`lifecycle.go:766-768`).

### F7 — No panic recovery on the hot path

`ServeMux` (`proxy.go:164-184`) registers bare handlers. `cmd/gateway/main.go:132-137` sets `Handler: mux` with no wrapping. A panic in any handler propagates to `net/http`'s per-connection recover: the connection closes, the client gets a truncated response, and **no `request_log` row is written** — the request becomes invisible to billing and to the ledger reconciliation.

### F8 — `pool_config_test.go` pins a value the code deliberately changed

`store/pool_config_test.go:17` asserts `cfg.MaxConns != 20` fails. `store/store.go:190` sets `cfg.MaxConns = 60` with a documented measurement (pool=60 → 2008 rps, 0 timeouts; pool=90 → 862 timeouts because the server's `max_connections` is 100). **Verified by running it: the test fails today.** This is a pre-existing red test, not something this plan introduces.

### F9 — Dead code in the classification path

`shouldFailover` (`proxy/auth.go:125-132`) and `parksAccount` (`proxy/auth.go:140-143`) have no call sites. `routing.ErrNoCandidates` (`select.go:557`) has no use site. `store.Candidates` (singular, `catalog.go:677`) has no production caller — only `CandidatesBatch` is on the hot path.

---

## Design decisions

**D1 — Breaker config loads lazily on first use, refreshed on a 30s in-process TTL.** Not per-request, and not in `New`. `New` has no context and its signature is pinned by `tests/helpers.go:425,446` and `cmd/gateway/main.go:121`; adding blocking I/O there would also make every test construction do a query. The refresh mirrors the house pattern for operator-edited config: `store.hardLimits` (`store/limits.go:109-140`, `store/store.go:55-59`) — an in-process cache with a TTL, because the row changes only by hand and no invalidation channel is needed.

**D2 — The breaker window becomes a real sliding window.** `Failures` becomes a ring of timestamps; `Result` prunes entries older than `WindowSeconds` before counting. This is the reading the spec's column name supports and it fixes both failure modes in F2. The Valkey value shape changes, so the key namespace is bumped (`circuit:v2:…`) rather than migrated — stale `v1` entries age out on their own TTL.

**D3 — Credential recovery is earned by success, bounded by a probe.** On a 2xx the router writes `status='healthy', cooldown_until=NULL` for the credential that served. This is the missing half of F3 and it is safe: a 2xx is proof the credential works *right now*, which is exactly the claim `'invalid'` makes. The write runs in a goroutine — unlike `parkCredential` (`targets.go:382-404`), which blocks its caller — because this is the success path and a synchronous write would add a DB round trip to every 200. It does not conflict with the hourly TS probe — both write the same terminal state.

**D4 — Every hardening is fail-open in the direction that keeps traffic flowing.** Breaker config unreadable → keep the last good config, or defaults on first load. Credential recovery write fails → log and continue. This matches the existing convention (`limits.go:499-511`, `execute.go:408-410`, `health.go:78-105`) and PRD §150.

---

## Execution plan

Ordered so each step is independently verifiable. Steps 1–3 are the HA core; 4–5 are hardening; 6 is the pre-existing red test.

### Step 1 — Wire the circuit breaker to its configuration table

**Files:** `backend/go/internal/routing/execute.go`, `backend/go/internal/proxy/policy_cache.go`, `backend/go/internal/proxy/proxy.go`, `backend/go/internal/proxy/lifecycle.go`

1. `routing/execute.go`: add `(*CircuitBreaker).SetConfig(map[string]BreakerDefaults)`. It **replaces** the map (a row deleted from `circuit_breaker` must stop applying; a merge would serve it forever), takes `b.mu`, and is nil-receiver-safe like `Allow`/`Result`. Update the `config()` doc comment, which currently says the map "is populated once at construction and never written afterwards" — that stops being true.
2. `proxy/policy_cache.go`: add `breakerConfigKey()` (namespaced via `cacheNS()`, key `breaker:v1`) and `cachedBreakerConfig(ctx)`. Valkey `GetJSON` first; on miss, `store.CircuitBreakers(ctx)`; on success `SetJSON` with a 30s TTL; on any error return `nil` (caller keeps the last good config). Add `breakerDefaultsFrom(map[string]store.CircuitBreakerConfig) map[string]routing.BreakerDefaults`, which **skips rows with `Enabled == false`** — `BreakerDefaults` has no `Enabled` field, so a disabled row would otherwise be applied as if enabled. The map key is `Target + ":" + TargetID`, which is exactly what `CircuitBreaker.config` looks up (`execute.go:490-495`) and what `store.CircuitBreakers` already produces (`store/policy.go:138-157`).
3. `proxy/proxy.go`: add `breakerCfgMu sync.Mutex`, `breakerCfg map[string]routing.BreakerDefaults`, `breakerCfgAt time.Time` to `Handler`, plus `breakerConfigTTL = 30 * time.Second`. Add `refreshBreakerConfig(ctx)`: return early if within the TTL; otherwise load and, **only on a non-nil result**, store it and call `h.breaker.SetConfig(cfg)`. Guard `h.store == nil`, `h.vk == nil` and `h.breaker == nil` — tests build `&Handler{...}` literals directly, and `SetConfig` is nil-receiver-safe.
4. `proxy/lifecycle.go`: in `begin()`, immediately after the `cachedRoutingPolicy` block (`lifecycle.go:219-223`), add `h.refreshBreakerConfig(r.Context())`. `begin` threads `r.Context()` everywhere (`lifecycle.go:196,213,220`), so use that exact expression — there is no `ctx` variable in scope.
5. Update the stale comment at `proxy.go:75-76`.

**Verification:** `go test ./internal/routing/ ./internal/proxy/ -count=1` (unit-only). New test in `routing_test.go`: a config map with `"connection:con_x": {FailureThreshold: 1, …}` opens after one failure where the default (5) would not — the mutation-visible assertion that F1 is closed. New test in `proxy`: `cachedBreakerConfig` returns `nil` when Valkey is disabled and the DB is unreachable, and `breakerDefaultsFrom` drops a disabled row.

### Step 2 — Make the breaker window a real window

**Files:** `backend/go/internal/routing/execute.go`, `backend/go/internal/routing/routing_test.go`

1. Change `circuitState.Failures int` → `Failures []int64` (unix-millis timestamps), keeping the JSON field name `failures`.
2. In `Result` (`execute.go:470-484`): prune timestamps older than `WindowSeconds` before appending; open when the pruned length `>= FailureThreshold`.
3. Bump the key prefix in `circuitKey` (`execute.go:547-549`) from `circuit:` to `circuit:v2:` with a one-line comment: the value shape changed, and a `v1` entry decoded into the new shape would read as zero failures — harmless, but the bump makes the boundary explicit rather than accidental.
4. Keep the half-open re-open path (`execute.go:473-475`) seeding `Failures` with `FailureThreshold` entries so a failed probe re-opens immediately.

**Verification:** new table test in `routing_test.go`: 4 failures inside the window with threshold 5 → closed; a 5th → open. 4 failures spread over 3× the window → still closed (this is the F2 mutation). Existing `TestExecuteCircuitOpenRefusesAndRecords`, `TestExecuteRateLimitedDoesNotTripBreaker`, `TestCircuitBreakerDegradesClosedWhenValkeyIsDown` must stay green unchanged.

### Step 3 — Earn credential recovery from success

**Files:** `backend/go/internal/store/store.go`, `backend/go/internal/proxy/targets.go`, `backend/go/internal/proxy/lifecycle.go`

1. Add `(*Store).MarkCredentialHealthy(ctx, credentialID)` in `store/store.go` beside `UpdateCredentialState` (`store.go:290-303`):

```go
// MarkCredentialHealthy clears a parked credential after a 2xx proved it works.
// One statement, no read-modify-write: the caller already knows the credential
// served this request, so there is nothing to check first.
func (s *Store) MarkCredentialHealthy(ctx context.Context, credentialID string) error {
	_, err := s.pool.Exec(ctx, `
		update credential
		set status = 'healthy', cooldown_until = null,
		    last_success_at = now(), updated_at = now()
		where id = $1`, credentialID)
	return err
}
```

2. Add `(*Handler).reviveCredential(credID string)` in `targets.go` beside `parkCredential` (`targets.go:382-404`):

```go
// reviveCredential is the missing half of parkCredential: a 2xx is proof the
// credential works right now, which is exactly the claim 'invalid' makes.
//
// Detached in a goroutine, UNLIKE parkCredential, which blocks its caller.
// parkCredential runs on the error path — the request is already failing and
// about to walk to another candidate — so a 5s write there costs nothing.
// This runs on the SUCCESS path, where the response is about to be written;
// a synchronous write would add a DB round trip to every 200.
func (h *Handler) reviveCredential(credID string) {
	if credID == "" || h.store == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(context.Background()), 5*time.Second)
		defer cancel()
		if err := h.store.MarkCredentialHealthy(ctx, credID); err != nil {
			log.Printf("[proxy] credential revive failed for %s: %v", credID, err)
		}
	}()
}
```

3. Call it from `exchange` on the 2xx path, immediately before `return a` at `lifecycle.go:1438-1441`:

```go
if resp.StatusCode >= 200 && resp.StatusCode < 300 {
	if a.CredentialID != "" && !keylessAuth(target.authKind) {
		h.reviveCredential(a.CredentialID)
	}
	a.Payload = resp
	return a
}
```

`target` and `a.CredentialID` are both in scope there — the same two identifiers the non-2xx branch uses at `lifecycle.go:1504` and `:1523`. `keylessAuth` is `targets.go:455-457`.

4. The justificatory comment above records what bug this fixes (F3), why a 2xx is sufficient proof, and why it is detached where `parkCredential` is not.

**Verification:** new DB-backed test in `proxy` (follows `lifecycle_402_failover_test.go`'s shape): park a credential `'invalid'` via a 401, confirm the candidate query withholds it, serve a 200 through the same credential, confirm the row is `'healthy'` with `cooldown_until IS NULL` and routable again. `go test ./internal/proxy/ -run Credential -count=1` with `DATABASE_URL` set to the scratch DB.

### Step 4 — Bound the rotating client's header phase

**Files:** `backend/go/internal/proxy/sourceip_client.go`

1. In `rotatingClient` (`sourceip_client.go:81-102`), after cloning `http.DefaultTransport`, set `tr.ResponseHeaderTimeout` to a package-level `var rotatingHeaderTimeout = 120 * time.Second` — the same value `newUpstreamClient` uses (`proxy.go:223`), so the two clients agree on what "a dead upstream" means. A `var` (not a const) so the test can shorten it without waiting 120s, following the `genericTimeout` precedent (`proxy.go:233`).
2. Add the justificatory comment naming F6: the streaming path hands this client `r.Context()` with no deadline (`lifecycle.go:766-768`), so without this bound a keyless upstream that accepts and then stalls holds the request open indefinitely.

**Verification:** new `proxy/sourceip_client_test.go`: start a listener that accepts and never writes, drive one keyless exchange through `rotatingClient` with `rotatingHeaderTimeout` shortened, assert it returns within the bound.

### Step 5 — Recover from a handler panic without losing the connection

**Files:** `backend/go/internal/proxy/proxy.go`

**Verified API (do not invent):** the error writer is a **method on `*Handler`** — `func (h *Handler) writeErrCode(w http.ResponseWriter, code, message string)` (`proxy.go:328-330`), which delegates to `h.writeErr(w, normalize(code, message))` (`proxy.go:319`). The internal-error code constant is `routing.ErrCodeInternalError` (`errors.go:47`); there is **no** `errInternal` symbol. `log` is already imported in `proxy.go:15`.

1. Add a `wroteHeader` wrapper in `proxy.go`:

```go
// wroteHeader records whether the handler already committed a status line, so
// a panic mid-stream does not attempt a second WriteHeader (which net/http
// logs as "superfluous response.WriteHeader" and which would corrupt the body).
type wroteHeader struct {
	http.ResponseWriter
	wrote bool
}

func (w *wroteHeader) WriteHeader(code int) {
	w.wrote = true
	w.ResponseWriter.WriteHeader(code)
}

func (w *wroteHeader) Write(b []byte) (int, error) {
	w.wrote = true
	return w.ResponseWriter.Write(b)
}
```

2. Add `recoverMiddleware` as a **free function taking the handler**, because it must call the `*Handler` method:

```go
func recoverMiddleware(p *Handler, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ww := &wroteHeader{ResponseWriter: w}
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("panic serving %s %s (request %s): %v\n%s",
					r.Method, r.URL.Path, r.Header.Get("x-fudrouter-request-id"), rec, debug.Stack())
				if !ww.wrote {
					p.writeErrCode(ww, routing.ErrCodeInternalError, "")
				}
			}
		}()
		next.ServeHTTP(ww, r)
	})
}
```

`debug.Stack()` needs `runtime/debug` added to the import block (`proxy.go:10-29`).

3. Wrap **at registration inside `proxy.ServeMux`** (`proxy.go:164-184`), not in `newMux`. Every test calls `proxy.ServeMux(...)` directly (e.g. `surface_test.go:28`, `health_test.go:80`), so wrapping in `newMux` would leave the tests uncovered. Keep the return type `*http.ServeMux` — `muxUnderTest` (`surface_test.go:26`) and every test helper depend on it, and no test calls `.Handle` on the result. Change each registration from `mux.Handle(pattern, http.HandlerFunc(p.ServeX))` to `mux.Handle(pattern, recoverMiddleware(p, http.HandlerFunc(p.ServeX)))`. Leave `GET /health` unwrapped (it is a separate handler with no lifecycle state).

4. The ledger row is **not** recoverable from the middleware (the lifecycle is handler-local state), and this plan does not attempt it. The middleware's job is to stop the connection-level failure mode; the missing-row case stays a documented gap.

**Verification:** new test in `proxy`: a handler that panics before writing → client gets 500 with the taxonomy envelope (`{"error":{"code":"INTERNAL_ERROR",…}}`) and the request-id header; a handler that panics after writing 200 → client gets the truncated stream, no second header, no `http: superfluous response.WriteHeader` log. `TestPublicSurfaceIsPinned` and `TestRegisteredHandlerAnswersEachExactPath` (`surface_test.go:43,81`) must stay green — they assert status codes, not handler identity, so wrapping at registration does not disturb them.

### Step 6 — Fix the pre-existing red test

**Files:** `backend/go/internal/store/pool_config_test.go`

`TestPoolConfigDefaults` (`pool_config_test.go:12-32`) asserts `cfg.MaxConns != 20` fails at line 17. The code sets `cfg.MaxConns = 60` (`store.go:190`) with a measured rationale at `store.go:169-189`:

```
pool=20  828 / 819 rps   0 timeouts
pool=40 1507 / 1596 rps  0 timeouts
pool=60 2008 / 2436 rps  0 timeouts   <- optimum
pool=90  683 / 2146 rps  862 / 230 timeouts
```

Change line 17-19 to assert 60, and add to the test's header comment: the value is measured, 60 is the top of the flat region, and 90 is worse because the server's `max_connections` is 100. The assertion still fails on an unmeasured change, so the gate keeps its teeth.

**This is a test correction, not a test weakening:** the code's value is the measured one and the comment records why. Per the repo's own rule ("A gate must be seen to fail"), the corrected assertion still fails if someone changes 60 without re-measuring.

**Verification:** `go test ./internal/store/ -run TestPoolConfig -count=1 -v` → all four subtests pass.

---

## Verification sequence

Run in this order. Each command's expected output is stated.

```sh
# 1. Unit-only, no DB (agent shells export CI=true, so -u CI is required)
cd backend/go && env -u DATABASE_URL -u CI GOTOOLCHAIN=auto go test ./... -count=1
# EXPECT: 13 packages ok, 0 FAIL (12 ok + store red until step 6 lands)

# 2. Vet + build
env -u DATABASE_URL -u CI GOTOOLCHAIN=auto go vet ./... && env -u DATABASE_URL -u CI GOTOOLCHAIN=auto go build ./...
# EXPECT: no output, exit 0

# 3. DB-backed (scratch DB, never production)
docker exec postgre psql -U postgres -d postgres -c "create database fudrouter_test owner fudrouter"
export DATABASE_URL=postgres://fudrouter:fudrouter@127.0.0.1:5432/fudrouter_test
./ops/migrate.sh
env -u CI GOTOOLCHAIN=auto go test ./... -race -count=1
# EXPECT: all packages ok, including the new credential-recovery test

# 4. Race detector on the packages this plan touches
env -u CI GOTOOLCHAIN=auto go test ./internal/routing/ ./internal/proxy/ -race -count=1
# EXPECT: ok, no DATA RACE

# 5. The failover drill (builds the router from this tree, runs T0–T5)
bash ops/verify/route-integrity/run.sh
# EXPECT: T0–T5 all pass, exit 0

# 6. Layout + contracts gate
npm run check
# EXPECT: exit 0
```

**Smoke proof beyond tests** (required before claiming done): boot the router against the scratch DB with `ROUTER_ALLOW_DEV_PROVIDERS=1`, drive one chat completion through a seeded provider, and confirm from `request_log` + `request_attempt` that the row landed and the attempt carries a latency. Then park that credential with a 401, serve a 200, and confirm the row flipped to `'healthy'` — that is step 3's behavior observed end-to-end, not just asserted.

---

## Risks and edge cases

| # | Risk | Mitigation |
|---|---|---|
| R1 | Lazy breaker-config load races with the first request | `SetConfig` replaces the map under `b.mu`; `config()` reads under the same lock. A request that arrives before the load completes uses defaults — the current behavior, so no regression. |
| R2 | `circuit:v2:` orphans open `v1` circuits | A `v1` OPEN state is forgotten, so the target gets one probe immediately. Strictly safer than the opposite (a forgotten CLOSED state would let a dead target be retried). Documented in the key-bump comment. |
| R3 | Credential revival writes on every successful request | One `update` per successful exchange per credential. At 150 rps that is 150 small updates/s against a table the candidate query already reads. **Measure before shipping:** if the write load is material, gate the revival on "the row is currently not healthy" by reading `status` from the candidate the request already holds (`store.Candidate.Credentials[0].Status` is already in the json_agg, `catalog.go:584`) and only writing when it differs. |
| R4 | ~~`provider_model` may have no `config` jsonb~~ | **Resolved and moot.** `provider_model` has no `config` column (`0006_platform_schema.sql:223-238` — only `capabilities_override`/`context_override`), and the whole step that needed it is deleted (see Corrections). |
| R5 | Panic middleware double-writes a header | The wrapped ResponseWriter tracks `wroteHeader`; the 500 path checks it. Covered by the step-5 test's second case. |
| R6 | `ResponseHeaderTimeout` on the rotating client cuts a slow-but-alive keyless upstream | 120s matches `newUpstreamClient` exactly. A keyless upstream that cannot produce a header in 120s is the same dead upstream the chat path already refuses. |
| R7 | Step 6's test correction looks like weakening a gate | The header comment records the measurement (pool=60 → 2008 rps / 0 timeouts; pool=90 → 862 timeouts, server `max_connections`=100). The assertion still fails on an unmeasured change. |

---

## Explicitly not doing

- **No `RecordModelHealth` / no second writer of `connection.config` signals.** `routing_signals_refresh` owns those keys (`workers.ts:1296-1339`, every 30 min). Adding a Go writer would fight it. This was step 4 of the first draft; deleted.
- **No latency EWMA or learned routing.** `StrategySmart` normalizes to `balanced` by design (`select.go:30-31,49-53`); the learned signals are P2 and out of scope.
- **No new health table, no new migration.** Nothing in this plan needs schema.
- **No per-request breaker-config read.** D1.
- **No retry of the client request itself, no idempotency-key replay.** Not asked for; the existing walk already covers upstream retry.
- **No changes to `apps/web`, `apps/workers`, `apps/scheduler`, `packages/*`.** The TS credential probe keeps its hourly revival; step 3 adds the data plane's own, they do not conflict (both write the same terminal state).
- **No read path for `request_attempt` (F5).** Closing it needs an index and a query on the hot path, and the signal it would feed is already supplied by `routing_signals_refresh` from `request_log`. Recorded as a finding, not a task.
- **No deletion of `store.Candidates`, `shouldFailover`, `parksAccount`, `ErrNoCandidates`** in this plan. They are dead (F9) but deleting them is a separate cleanup with its own blast radius across tests; noted here so it is not forgotten.

---

## Already done (do not repeat)

- Full read of `routing/{execute,select,plan}.go`, `proxy/{proxy,lifecycle,pool,health,budget,connlimit,stream,sourceip_client,policy_cache,catalog_cache}.go`, `limits/limits.go`, `vk/vk.go`, `store/{catalog,store,policy,limits}.go`, `cmd/gateway/main.go`.
- Five read-only scouts mapped the remaining surface (routing core, proxy hot path, store/migrations, limits/Valkey, tests/gates/docs). One scout (`LimitsValkey`) failed on a provider error; its scope was covered by direct read.
- Unit baseline established: `env -u DATABASE_URL -u CI GOTOOLCHAIN=auto go test ./... -count=1` → 12 packages ok, `internal/store` FAIL on `TestPoolConfigDefaults` (pre-existing, F8). `go vet ./...` clean.
- The `MaxConns` 20-vs-60 disagreement confirmed by running the test, not by reading alone.
- **The first draft's F4 was disproved** by reading `packages/platform/server/workers.ts:1255-1345` and `scheduler.ts:127-131`; the corresponding step was deleted rather than implemented.
