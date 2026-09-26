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
		t.Skip("set FUDROUTER_SLOW_POOL_TESTS=1 — walks a 663-account pool, ~80s")
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
	t.Logf("pool=%d  refresher calls=%d  refresh cost=%v  Pick total=%v",
		poolSize, fr.calls, fr.cost, elapsed.Round(time.Millisecond))

	// Every account must have been tried, and the total must be the sum of the
	// per-account costs — that is the multiplication this test pins down.
	if fr.calls != poolSize {
		t.Errorf("refresher calls = %d, want %d (Pick must try every account once)", fr.calls, poolSize)
	}
	want := time.Duration(poolSize) * fr.cost
	if elapsed < want-want/10 {
		t.Errorf("Pick returned in %v, faster than %d serial refreshes at %v each — Pick is not paying the full cost",
			elapsed, poolSize, fr.cost)
	}
}

// The second call must be cheap: the first failure set a cooldown on every
// account, so a retry walks the pool without touching the network. This is the
// difference between "one slow request" and "every request slow".
func TestPickFailureIsCooldownOnRetry(t *testing.T) {
	if !slowPoolTests() {
		t.Skip("set FUDROUTER_SLOW_POOL_TESTS=1 — walks a 663-account pool, ~80s")
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

	t.Logf("first Pick: %d refresher calls;  second Pick: %d calls in %v (cooldown active)",
		callsAfterFirst, fr.calls-callsAfterFirst, second.Round(time.Millisecond))

	if got := fr.calls - callsAfterFirst; got != 0 {
		t.Errorf("second Pick made %d refresher calls, want 0 — the cooldown is not short-circuiting", got)
	}
	if second > time.Second {
		t.Errorf("second Pick took %v, want ~0 — cooldowned accounts must not cost a network call", second)
	}
}
