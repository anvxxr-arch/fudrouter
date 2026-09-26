package proxy

import (
	"context"
	"testing"

	"github.com/anvxxr-arch/fudrouter/services/router/internal/store"
)

// A pool that is never rebuilt keeps serving tokens that were rotated away from
// outside the process. Rebuilding after the trust window is what lets a
// maintenance rotation (or an import) take effect without a restart — the
// failure that made a repaired pool still read as unusable until pm2 restart.
func TestPoolForReloadsAfterTrustWindow(t *testing.T) {
	old := poolReloadAfter
	poolReloadAfter = 0
	defer func() { poolReloadAfter = old }()

	h := &Handler{refresher: newFakeRefresher()}
	m := &store.ModelRow{ProviderID: "p1"}
	first := h.poolFor(m, credentials{Accounts: []account{
		{Email: "a@x", AccessToken: "tok-1", RefreshToken: "rt-1", Expired: future()},
	}})
	second := h.poolFor(m, credentials{Accounts: []account{
		{Email: "a@x", AccessToken: "tok-2", RefreshToken: "rt-2", Expired: future()},
	}})

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
	m := &store.ModelRow{ProviderID: "p1"}
	cred := credentials{Accounts: []account{
		{Email: "a@x", AccessToken: "tok-1", Expired: future()},
	}}
	if h.poolFor(m, cred) != h.poolFor(m, cred) {
		t.Fatal("pool was rebuilt inside the trust window")
	}
}

// Providers are cached independently: reloading one must not disturb another.
func TestPoolForKeepsProvidersSeparate(t *testing.T) {
	h := &Handler{refresher: newFakeRefresher()}
	a := h.poolFor(&store.ModelRow{ProviderID: "pa"}, credentials{Accounts: []account{
		{Email: "a@x", AccessToken: "tok-a", Expired: future()},
	}})
	b := h.poolFor(&store.ModelRow{ProviderID: "pb"}, credentials{Accounts: []account{
		{Email: "b@x", AccessToken: "tok-b", Expired: future()},
	}})
	if a == b {
		t.Fatal("two providers share one pool")
	}
	if again := h.poolFor(&store.ModelRow{ProviderID: "pa"}, credentials{}); again != a {
		t.Error("provider pa lost its pool inside the trust window")
	}
}
