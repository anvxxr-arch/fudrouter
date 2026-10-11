package proxy

// The defect this test pins: Pool.Pick is handed the raw request context, so
// the bounded non-streaming timeout (nonStreamTimeout, applied to upCtx) never
// reaches the credential refresh inside Pick. Pick walks every account in the
// pool serially, and each walk can cost one HTTP round trip, so a pool of N
// accounts can burn N round trips inside a request whose own upstream budget
// is fixed.
//
// Observed live: a 99.652s "no usable credential" on a 663-account pool, which
// is 83% of the 120s upstream budget spent before the request even reached the
// upstream.
//
// FIXED. Pick now bounds itself (maxPickAttempts, pickBudget) and is handed the
// bounded upstream context. These tests are kept as the before/after record:
// they now measure the bounded behaviour and must keep doing so, so a revert of
// the cap turns them red again. The active guards live in pool_bound_test.go.

import (
	"context"
	"os"
	"testing"
	"time"
)

// The two tests below deliberately walk a real 663-account pool, which costs
// ~100s each. They are gated so the default suite stays fast; the measurement
// is opt-in. Without this gate the proxy package went from ~1s to ~263s, which
// is a 256x tax on every `go test ./...` for two tests of documentation value.
//
//	FUDROUTER_SLOW_POOL_TESTS=1 go test ./internal/proxy/ -run TestDeadPool -v
func slowPoolTests() bool { return os.Getenv("FUDROUTER_SLOW_POOL_TESTS") == "1" }

// A pool whose refreshes are slow enough that walking it exceeds the upstream
// budget, but whose individual refreshes would each fit inside it.
func TestPickIgnoresTheRequestTimeoutItWasHanded(t *testing.T) {
	if !slowPoolTests() {
		t.Skip("set FUDROUTER_SLOW_POOL_TESTS=1 — walks a 663-account pool, ~3s now that the walk is capped")
	}
	const poolSize = 40
	const perRefresh = 60 * time.Millisecond
	upstreamBudget := 200 * time.Millisecond

	accounts := make([]*poolAccount, poolSize)
	for i := range accounts {
		accounts[i] = &poolAccount{
			data: account{
				Email:        "acct",
				RefreshToken: "rt",
				Expired:      time.Now().Add(-time.Minute).UTC().Format("2006-01-02T15:04:05Z"),
			},
		}
	}
	fr := &failingRefresher{cost: perRefresh}
	p := &Pool{accounts: accounts, refresher: fr}

	// The caller derives upCtx with WithTimeout and passes it down. Pick must
	// respect that deadline; it currently does not, because the refresh HTTP
	// call is not bounded by the context it is given.
	ctx, cancel := context.WithTimeout(context.Background(), upstreamBudget)
	defer cancel()

	t0 := time.Now()
	_, err := p.Pick(ctx)
	elapsed := time.Since(t0)

	fullWalk := time.Duration(poolSize) * perRefresh
	t.Logf("pool=%d per-refresh=%v budget=%v  -> Pick returned after %v (full walk would be %v), calls=%d",
		poolSize, perRefresh, upstreamBudget, elapsed.Round(time.Millisecond), fullWalk, fr.calls)

	if err == nil {
		t.Fatal("expected Pick to fail")
	}
	// Now an assertion, not a log line. The walk must not run to completion:
	// 40 accounts at 60ms is 2.4s, so a full walk here is the defect returning.
	// A small overshoot of the caller's budget is correct — the in-flight
	// refresh that was started before the deadline cannot be recalled.
	if elapsed > upstreamBudget+perRefresh {
		t.Errorf("Pick spent %v against a %v budget (one %v refresh of slack) — the walk is not bounded by the caller's context again",
			elapsed.Round(time.Millisecond), upstreamBudget, perRefresh)
	}
	if fr.calls >= poolSize {
		t.Errorf("probed all %d accounts — the count cap regressed", fr.calls)
	}
	t.Logf("pool=%d per-refresh=%v budget=%v  -> Pick returned after %v (full walk would be %v), calls=%d — bounded",
		poolSize, perRefresh, upstreamBudget, elapsed.Round(time.Millisecond), fullWalk, fr.calls)
}

// The failover cap of 3 is applied to the OUTER loop, but it does not multiply
// the cost: the first Pick's failures put every account into cooldown, so
// attempts 2 and 3 return without a network call. Measured, not assumed — the
// first draft of this test predicted poolSize*attempts and was wrong by 3x.
//
// So one request costs ONE full pool walk, not three. The blast radius is
// therefore "one walk per failCooldown window", not "three walks per request".
// That is still a real defect (a single request pays for 663 round trips) but
// it is much smaller than the naive reading of the cap, and the difference
// matters when sizing the fix.
// A pool that is entirely unusable should not be re-probed account by account on
// every request. One account is enough to establish that the pool is dead; the
// rest is latency the client pays for nothing.
func TestDeadPoolProbesEveryAccountOnEveryRequest(t *testing.T) {
	if !slowPoolTests() {
		t.Skip("set FUDROUTER_SLOW_POOL_TESTS=1 — walks a 663-account pool, ~3s now that the walk is capped")
	}
	const poolSize = 663
	accounts := make([]*poolAccount, poolSize)
	for i := range accounts {
		accounts[i] = &poolAccount{
			data: account{
				Email:        "acct",
				RefreshToken: "rt",
				Expired:      time.Now().Add(-time.Minute).UTC().Format("2006-01-02T15:04:05Z"),
			},
		}
	}
	fr := &failingRefresher{cost: 150 * time.Millisecond}
	p := &Pool{accounts: accounts, refresher: fr}

	t0 := time.Now()
	_, _ = p.Pick(context.Background())
	elapsed := time.Since(t0)
	t.Logf("one request against a dead pool of %d costs %v (cooldown then makes the retry cheap)",
		poolSize, elapsed.Round(time.Millisecond))

	// This is the headline before/after: the same request cost ~100s before the
	// cap and must now cost a small fraction of that. The 30s bound is generous
	// for a slow machine, but it is 3x under the live 99.652s row, so a revert
	// of the cap cannot pass here.
	if elapsed > 30*time.Second {
		t.Errorf("one request against a dead pool of %d took %v — the walk is unbounded again (live row was 99.652s)",
			poolSize, elapsed.Round(time.Millisecond))
	}
	if fr.calls >= poolSize {
		t.Errorf("probed all %d accounts — the count cap regressed", fr.calls)
	}
}

// Compile-time proof that the timeout really is applied to a different context
// than the one handed to Pick — the wiring bug in one assertion.
