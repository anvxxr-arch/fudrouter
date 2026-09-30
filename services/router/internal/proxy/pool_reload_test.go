package proxy

import (
	"context"
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
