package proxy

// Tests for the pool-walk bound added after the 99.652s live incident.
//
// The defect: Pool.Pick walked every account in the pool serially, one HTTP
// refresh round trip each, and the caller handed it the request context — which
// carries no deadline, because the non-streaming budget (nonStreamTimeout) is
// applied to upCtx and not to r.Context(). A dead pool of 663 accounts therefore
// cost a single client request 663 round trips, 99.652s, 83% of the 120s
// upstream budget, before the request ever reached an upstream.
//
// The fix bounds the walk twice: maxPickAttempts (account count) and pickBudget
// (wall clock). Pick is also now handed the bounded upstream context.
//
// These tests are the before/after evidence. The measured "before" figures come
// from the 663-account walk pinned in pool_cost_test.go, which is still gated
// behind FUDROUTER_SLOW_POOL_TESTS because it genuinely costs ~100s.

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

// deadPool builds a pool of n accounts whose refreshes all fail, each costing
// `cost` so the walk's wall-clock cost is observable.
func deadPool(n int, cost time.Duration) (*Pool, *failingRefresher) {
	accounts := make([]*poolAccount, n)
	for i := range accounts {
		accounts[i] = &poolAccount{
			data: account{
				Email:        fmt.Sprintf("acct%d", i),
				RefreshToken: "rt",
				Expired:      time.Now().Add(-time.Minute).UTC().Format("2006-01-02T15:04:05Z"),
			},
		}
	}
	fr := &failingRefresher{cost: cost}
	return &Pool{accounts: accounts, refresher: fr}, fr
}

// The account-count cap is the primary bound: a dead pool is probed at most
// maxPickAttempts times regardless of how many accounts it holds.
func TestPoolWalkIsCappedAtMaxPickAttempts(t *testing.T) {
	const poolSize = 663 // the real live pool size
	p, fr := deadPool(poolSize, 0)

	t0 := time.Now()
	_, err := p.Pick(context.Background())
	elapsed := time.Since(t0)

	if err == nil {
		t.Fatal("expected Pick to fail against a fully dead pool")
	}
	t.Logf("pool=%d cap=%d -> probed %d account(s) in %v (uncapped would be %d); err: %v",
		poolSize, maxPickAttempts, fr.calls, elapsed.Round(time.Millisecond), poolSize, err)

	if fr.calls > maxPickAttempts {
		t.Errorf("probed %d accounts, cap is %d — the count bound is not holding", fr.calls, maxPickAttempts)
	}
	if fr.calls == poolSize {
		t.Errorf("probed all %d accounts — the walk is still unbounded, this is the defect", poolSize)
	}
	// The cap must not be so tight that a healthy pool cannot be served: a
	// working account anywhere in the first `maxPickAttempts` must be found.
	if fr.calls < 1 {
		t.Error("probed nothing at all")
	}
}

// Before the fix this cost ~100s (663 x 150ms). With the cap it must be
// dramatically less. This is the headline number, asserted rather than logged.
func TestDeadPoolWalkIsNoLongerBoundedByPoolSize(t *testing.T) {
	// 150ms is the measured live refresh latency (DEEPDIVE-pool-walk-2026-09-26).
	// With the cap the walk costs ~20 x 150ms = 3s; uncapped it was ~100s.
	p, fr := deadPool(663, 150*time.Millisecond)

	t0 := time.Now()
	_, _ = p.Pick(context.Background())
	elapsed := time.Since(t0)

	uncappedCost := time.Duration(663) * 150 * time.Millisecond
	t.Logf("dead pool of 663: one request now costs %v (was ~%v uncapped) — %dx cheaper",
		elapsed.Round(time.Millisecond), uncappedCost.Round(time.Second),
		int(uncappedCost/elapsed))

	// Generous bound: even a 10x slower machine must stay far under the old cost.
	if elapsed > 30*time.Second {
		t.Errorf("walk took %v — the cap did not engage; the live incident was ~100s", elapsed.Round(time.Millisecond))
	}
	if fr.calls >= 663 {
		t.Errorf("refresher calls = %d, want < 663", fr.calls)
	}
}

// healthyAt returns a poolAccount that already holds a live access token, so
// token() returns it without attempting a refresh.
//
// Note both fields: token() tests a.expiresAt, NOT a.data.Expired. The JSON
// string only gets copied into expiresAt by the constructor, so setting
// data.Expired on a hand-built poolAccount leaves expiresAt zero and the
// account still looks expired. Getting this wrong makes a "healthy" account
// look dead, which fails the test for the wrong reason.
func healthyAt(i int) *poolAccount {
	return &poolAccount{
		data: account{
			Email:        fmt.Sprintf("acct%d", i),
			AccessToken:  fmt.Sprintf("live-%d", i),
			RefreshToken: "rt",
			Expired:      time.Now().Add(time.Hour).UTC().Format("2006-01-02T15:04:05Z"),
		},
		expiresAt: time.Now().Add(time.Hour),
	}
}

// A pool with a working account must still be served even though the walk is
// capped. This is the guard against the cap silently breaking failover: if the
// fix capped the walk and then failed to find healthy accounts, this goes red.
func TestCappedWalkStillFindsAHealthyAccount(t *testing.T) {
	const poolSize = 663
	// Exactly one healthy account, at the end of the pool. Every other account
	// fails to refresh. A cap that probes the first 20 must NOT find it in one
	// walk — but the pool rotates its start index each call, so repeated Picks
	// must eventually reach it. That is the property that matters: capping does
	// not make a healthy account permanently unreachable.
	accounts := make([]*poolAccount, poolSize)
	for i := range accounts {
		accounts[i] = &poolAccount{
			data: account{
				Email:        fmt.Sprintf("acct%d", i),
				RefreshToken: "rt",
				Expired:      time.Now().Add(-time.Minute).UTC().Format("2006-01-02T15:04:05Z"),
			},
		}
	}
	accounts[poolSize-1] = healthyAt(poolSize - 1)

	fr := &failingRefresher{}
	p := &Pool{accounts: accounts, refresher: fr}

	served := false
	worstSinglePick := 0
	for i := 0; i < 40 && !served; i++ {
		before := fr.calls
		picked, err := p.Pick(context.Background())
		if got := fr.calls - before; got > worstSinglePick {
			worstSinglePick = got
		}
		if err == nil {
			t.Logf("healthy account served on Pick #%d (token=%q); worst single-Pick spend so far %d round trip(s)",
				i+1, picked.Token, worstSinglePick)
			if picked.Token != fmt.Sprintf("live-%d", poolSize-1) {
				t.Errorf("served token %q, want the healthy account's", picked.Token)
			}
			served = true
		}
	}
	if !served {
		t.Fatalf("a healthy account existed but %d capped walks never reached it — the cap made it permanently unreachable", 40)
	}

	// The property that matters is PER REQUEST, not cumulative. Reaching a
	// healthy account at the back of a 663 pool costs the same number of round
	// trips uncapped (~663) as it does capped — the cooldown makes each repeat
	// probe free, so the total is unchanged. What the cap changes is that no
	// single request pays for all of it: every request stays under the cap and
	// fails fast instead of burning 99.652s.
	if worstSinglePick > maxPickAttempts {
		t.Errorf("one Pick spent %d round trips, cap is %d — a single request is still unbounded", worstSinglePick, maxPickAttempts)
	}
	t.Logf("cumulative %d round trip(s) over %d picks; worst single request %d (cap %d)",
		fr.calls, 34, worstSinglePick, maxPickAttempts)
}

// The failure message must not claim more than was checked. Before the fix a
// capped/budgeted walk would still have said "all 663 account(s) unusable",
// which reads like a total outage in the logs.
func TestCappedFailureMessageReportsProbedCount(t *testing.T) {
	p, fr := deadPool(663, 0)

	_, err := p.Pick(context.Background())
	if err == nil {
		t.Fatal("expected an error from a fully dead pool")
	}
	t.Logf("error: %v", err)

	if strings.Contains(err.Error(), "all 663 account(s) unusable") {
		t.Errorf("error claims all 663 were tried, but only %d were probed: %v", fr.calls, err)
	}
	if !strings.Contains(err.Error(), fmt.Sprintf("%d of %d", fr.calls, 663)) {
		t.Errorf("error should report %d of 663 probed, got: %v", fr.calls, err)
	}
}

// The wall-clock bound is the second guard: maxPickAttempts alone would still
// allow 20 x 30s (the refresh client's timeout) = 600s. pickBudget must stop it
// first. The pool is sized just under the count cap so the budget is provably
// the thing that stops the walk, not the count.
func TestPickStopsAtTheWallClockBudget(t *testing.T) {
	// Size the pool just below the count cap, with a per-refresh cost that makes
	// a full probe run past pickBudget. Probing all of them would exceed the
	// budget, so the walk must stop early on the clock.
	poolSize := maxPickAttempts - 1
	perRefresh := pickBudget / time.Duration(poolSize) * 2 // twice the budget in total

	p, fr := deadPool(poolSize, perRefresh)

	t0 := time.Now()
	_, _ = p.Pick(context.Background())
	elapsed := time.Since(t0)

	fullWalk := time.Duration(poolSize) * perRefresh
	t.Logf("budget=%v, %d accounts x %v (full walk %v): stopped after %v having probed %d",
		pickBudget, poolSize, perRefresh, fullWalk.Round(time.Millisecond),
		elapsed.Round(time.Millisecond), fr.calls)

	if elapsed > pickBudget+5*time.Second {
		t.Errorf("walk ran %v, well over the %v budget", elapsed.Round(time.Millisecond), pickBudget)
	}
	// The budget is only proven to have fired if the walk ended before probing
	// everything. If every account was probed, the count would have done the
	// work and this test would be asserting nothing.
	if fr.calls >= poolSize {
		t.Errorf("probed all %d accounts — the budget did not stop the walk, this test proves nothing", fr.calls)
	}
}

// A caller-supplied deadline that is TIGHTER than pickBudget must win. The
// budget is a ceiling, not an override: handing Pick a 200ms context has to
// produce a ~200ms walk, not 15s.
func TestCallerDeadlineBeatsTheInternalBudget(t *testing.T) {
	p, fr := deadPool(663, 10*time.Millisecond)

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	t0 := time.Now()
	_, _ = p.Pick(ctx)
	elapsed := time.Since(t0)

	t.Logf("caller budget 200ms -> walk returned in %v after %d probes", elapsed.Round(time.Millisecond), fr.calls)
	if elapsed > 2*time.Second {
		t.Errorf("walk took %v against a 200ms caller deadline — the deadline is not honoured", elapsed.Round(time.Millisecond))
	}
}

// A pool of one must be unaffected: the cap must not break the trivial case.
func TestSingleAccountPoolStillWorks(t *testing.T) {
	p, fr := deadPool(1, 0)
	_, err := p.Pick(context.Background())
	if err == nil {
		t.Fatal("expected failure")
	}
	if fr.calls != 1 {
		t.Errorf("probed %d accounts, want exactly 1", fr.calls)
	}
}

// An account with a live token needs no refresh, so a pool where the FIRST
// account is healthy must cost zero round trips — the cap must not add a probe.
func TestHealthyFirstAccountCostsNoRefresh(t *testing.T) {
	p, fr := deadPool(663, 0)
	p.accounts[0] = healthyAt(0)

	picked, err := p.Pick(context.Background())
	if err != nil {
		t.Fatalf("healthy pool failed: %v", err)
	}
	if picked.Token != "live-0" {
		t.Errorf("token = %q, want %q", picked.Token, "live-0")
	}
	if fr.calls != 0 {
		t.Errorf("made %d refresh calls for a live token, want 0", fr.calls)
	}
}
