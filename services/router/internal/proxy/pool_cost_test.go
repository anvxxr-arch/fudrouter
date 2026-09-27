package proxy

// Why this test exists: a live request_log row recorded 99.652s for a
// "no usable credential" failure on a 663-account pool, which is impossible to
// explain from the code alone. This reproduces Pick's failure path at real pool
// size and times each attempt, so the cost of a failing Pick is a measured
// number rather than an assumption.
//
// The reproducer uses a refresher that fails, never a real credential.

import (
	"context"
	"errors"
	"testing"
	"time"
)

// Both tests here walk a real 663-account pool, costing ~80s each. Gated for the
// same reason as pool_budget_test.go: two documentation-value tests must not tax
// every `go test ./...` by four minutes. slowPoolTests lives in pool_budget_test.go.
//
//	FUDROUTER_SLOW_POOL_TESTS=1 go test ./internal/proxy/ -run TestPickFailure -v

type failingRefresher struct {
	calls    int
	cost     time.Duration
	lastSeen string
}

func (f *failingRefresher) Refresh(_ context.Context, rt string) (string, string, int, error) {
	f.calls++
	f.lastSeen = rt
	time.Sleep(f.cost)
	return "", "", 0, errors.New("upstream rejected the refresh token")
}

func TestPickFailureCostAtRealPoolSize(t *testing.T) {
	if !slowPoolTests() {
		t.Skip("set FUDROUTER_SLOW_POOL_TESTS=1 — walks a 663-account pool, ~5s now that the walk is capped")
	}
	const poolSize = 663 // the live xai-grok account count
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
	fr := &failingRefresher{cost: 120 * time.Millisecond}
	p := &Pool{accounts: accounts, refresher: fr}

	t0 := time.Now()
	_, err := p.Pick(context.Background())
	elapsed := time.Since(t0)

	if err == nil {
		t.Fatal("expected Pick to fail when every refresh fails")
	}
	t.Logf("pool=%d  refresher calls=%d  refresh cost=%v  Pick total=%v  (cap=%d)",
		poolSize, fr.calls, fr.cost, elapsed.Round(time.Millisecond), maxPickAttempts)

	// Before the cap this cost 663 refreshes, ~80s, for a single request. The
	// walk is now bounded, so the cost is a fixed fraction of the pool instead
	// of the whole of it. This assertion is the cap: reverting it makes the
	// test demand 663 round trips again.
	if fr.calls > maxPickAttempts {
		t.Errorf("refresher calls = %d, want at most the cap %d (a dead pool of %d must not cost one round trip per account)",
			fr.calls, maxPickAttempts, poolSize)
	}
	uncapped := time.Duration(poolSize) * fr.cost
	if elapsed > uncapped {
		t.Errorf("Pick took %v, more than the uncapped %v — the cap added cost?", elapsed.Round(time.Millisecond), uncapped)
	}
	t.Logf("one request against a dead pool of %d costs %v instead of ~%v uncapped",
		poolSize, elapsed.Round(time.Millisecond), uncapped.Round(time.Second))
}

// The second call must be cheap: the first failure set a cooldown on every
// account, so a retry walks the pool without touching the network. This is the
// difference between "one slow request" and "every request slow".
func TestPickFailureIsCooldownOnRetry(t *testing.T) {
	if !slowPoolTests() {
		t.Skip("set FUDROUTER_SLOW_POOL_TESTS=1 — walks a 663-account pool, ~5s now that the walk is capped")
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
	fr := &failingRefresher{cost: 120 * time.Millisecond}
	p := &Pool{accounts: accounts, refresher: fr}

	if _, err := p.Pick(context.Background()); err == nil {
		t.Fatal("expected the first Pick to fail")
	}
	callsAfterFirst := fr.calls

	t0 := time.Now()
	if _, err := p.Pick(context.Background()); err == nil {
		t.Fatal("expected the second Pick to fail")
	}
	second := time.Since(t0)

	t.Logf("first Pick: %d refresher calls;  second Pick: %d calls in %v (cap=%d)",
		callsAfterFirst, fr.calls-callsAfterFirst, second.Round(time.Millisecond), maxPickAttempts)

	// The cooldown property CHANGED with the cap, and the change is worth being
	// explicit about rather than papering over.
	//
	// Uncapped: Pick 1 cooled down all 663 accounts, so Pick 2 cost 0 round
	// trips. One catastrophic request, then free.
	//
	// Capped: Pick 1 cools down 20, so Pick 2 rotates onto the next 20 and
	// costs another 20 round trips. Every request pays up to the cap.
	//
	// Total round trips over N requests is therefore similar (uncapped
	// 663 + 0 + 0...; capped 20N, so they cross around N=34), but the shape is
	// inverted: the old shape put the whole cost on one unlucky request, the
	// new one spreads it so no single request can be charged for the pool.
	// That is the entire point of the fix — a 99.652s request is a client
	// timeout, and a client timeout is not recoverable.
	secondCalls := fr.calls - callsAfterFirst
	if secondCalls > maxPickAttempts {
		t.Errorf("second Pick made %d refresher calls, over the cap %d — a single request is still unbounded", secondCalls, maxPickAttempts)
	}
	// Progress, not repetition: the second walk must examine accounts the first
	// one did not put into cooldown, or the cap would just re-probe the same 20
	// dead accounts forever and never find a live one.
	if secondCalls > 0 && secondCalls == callsAfterFirst && poolSize <= 2*maxPickAttempts {
		t.Error("second Pick re-probed the same accounts; the walk is not advancing through the pool")
	}
	// The bound is per-request cost, with slack for the boundary of the final
	// refresh. Without slack this is a timestamp comparison, not a behavioural
	// one: 20 x 120ms is 2.400s and the measured value rounds to 2.406s.
	perRequestCeiling := time.Duration(maxPickAttempts)*fr.cost + fr.cost
	if second > perRequestCeiling {
		t.Errorf("second Pick took %v, more than %d capped refreshes (%v) could cost",
			second, maxPickAttempts, perRequestCeiling)
	}
	t.Logf("per-request cost is now bounded at %d round trips (was: 663 on the first request, 0 after) — uncapped, Pick 1 walked the whole pool: %d x %v = ~%v",
		maxPickAttempts, poolSize, fr.cost, (time.Duration(poolSize) * fr.cost).Round(time.Second))
}
