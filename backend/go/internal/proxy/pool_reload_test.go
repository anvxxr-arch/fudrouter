package proxy

import (
	"context"
	"sync"
	"testing"
)

// A pool that is never rebuilt keeps serving tokens that were rotated away from
// outside the process. Rebuilding after the trust window is what lets a
// maintenance rotation (or an import) take effect without a restart — the
// failure that made a repaired pool still read as unusable until pm2 restart.
//
// Pools are keyed by credential target (spec §4: one pool per credential row /
// connection), so the key is now an explicit string rather than a model row.
func TestPoolForReloadsAfterTrustWindow(t *testing.T) {
	old := poolReloadAfter
	poolReloadAfter = 0
	defer func() { poolReloadAfter = old }()

	h := &Handler{refresher: newFakeRefresher()}
	first := h.poolFor("cred:c1", credentials{Accounts: []account{
		{Email: "a@x", AccessToken: "tok-1", RefreshToken: "rt-1", Expired: future()},
	}}, nil, nil)
	second := h.poolFor("cred:c1", credentials{Accounts: []account{
		{Email: "a@x", AccessToken: "tok-2", RefreshToken: "rt-2", Expired: future()},
	}}, nil, nil)

	if first == second {
		t.Fatal("pool was not rebuilt after the trust window")
	}
	tok, err := second.Pick(context.Background())
	if err != nil {
		t.Fatalf("Pick: %v", err)
	}
	if tok.Token != "tok-2" {
		t.Errorf("rebuilt pool serves %q, want the reloaded token", tok.Token)
	}
}

// Inside the window the same pool is reused: rebuilding on every request would
// throw away refresh state (rotations, cooldowns) faster than it can be used.
func TestPoolForReusesWithinTrustWindow(t *testing.T) {
	h := &Handler{refresher: newFakeRefresher()}
	cred := credentials{Accounts: []account{
		{Email: "a@x", AccessToken: "tok-1", Expired: future()},
	}}
	if h.poolFor("cred:c1", cred, nil, nil) != h.poolFor("cred:c1", cred, nil, nil) {
		t.Fatal("pool was rebuilt inside the trust window")
	}
}

// Credential targets are cached independently: reloading one must not disturb
// another (spec §4: each connection/row keeps its own secret state).
func TestPoolForKeepsTargetsSeparate(t *testing.T) {
	h := &Handler{refresher: newFakeRefresher()}
	a := h.poolFor("cred:ca", credentials{Accounts: []account{
		{Email: "a@x", AccessToken: "tok-a", Expired: future()},
	}}, nil, nil)
	b := h.poolFor("cred:cb", credentials{Accounts: []account{
		{Email: "b@x", AccessToken: "tok-b", Expired: future()},
	}}, nil, nil)
	if a == b {
		t.Fatal("two credential targets share one pool")
	}
	if again := h.poolFor("cred:ca", credentials{}, nil, nil); again != a {
		t.Error("target ca lost its pool inside the trust window")
	}
}

// H2: two racers that BOTH observe the same stale pool must converge on ONE
// rebuilt pool. The rebuild used a bare Store, so both installed their own
// pool and each persisted its rotated refresh token — the loser's token died
// upstream and the account broke on its next expiry. With CompareAndSwap the
// first installer wins and every loser returns the winner's pool; this test
// fails (two distinct pools) if the rebuild path ever goes back to Store.
//
// The hook holds every racer inside the rebuild window simultaneously: with
// poolReloadAfter=0 a freshly built pool is immediately stale again, so
// without the gate the racers would rebuild sequentially — correct
// trust-window behaviour, not the race under test.
func TestPoolForConcurrentRebuildsConvergeOnOnePool(t *testing.T) {
	old := poolReloadAfter
	poolReloadAfter = 0
	defer func() { poolReloadAfter = old }()

	entered := make(chan struct{}, 8)
	release := make(chan struct{})
	restore := SetPoolBuildHookForTest(func() {
		entered <- struct{}{}
		<-release
	})
	defer restore()

	h := &Handler{refresher: newFakeRefresher()}
	cred := credentials{Accounts: []account{
		{Email: "a@x", AccessToken: "tok-1", RefreshToken: "rt-1", Expired: future()},
	}}

	const racers = 8
	results := make([]*Pool, racers)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := range racers {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			results[i] = h.poolFor("cred:race", cred, nil, nil)
		}(i)
	}
	close(start)

	// All 8 racers are now inside build() — i.e. all past the stale check,
	// all about to CAS. Under the old bare Store each would install its own
	// pool; under CAS exactly one wins.
	for range racers {
		<-entered
	}
	close(release)
	wg.Wait()

	for i := 1; i < racers; i++ {
		if results[i] != results[0] {
			t.Fatalf("racer %d got a different pool than racer 0 — the rebuild path is not compare-and-swap", i)
		}
	}
}
