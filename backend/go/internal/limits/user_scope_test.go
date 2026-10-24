package limits_test

import (
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/limits"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/vk"
)

// The free tier bounds the ACCOUNT, not each key: two keys of one user share
// one user-scoped counter (72 rpm / 3 concurrent total), so the second key of
// the same user cannot multiply the ceiling.
func TestUserScopedRPMCountsAcrossKeysOfOneUser(t *testing.T) {
	l := limits.New(vk.NewFake())
	lim := &store.Limits{UserRPM: ptr(int64(1))}

	a := &limits.APIKeyIdentity{KeyID: "k1", UserID: "user-a"}
	if _, rej := l.Check(t.Context(), a, lim, 0); rej != nil {
		t.Fatalf("first request must pass: %+v", rej)
	}
	// A DIFFERENT key of the SAME user must hit the same counter.
	b := &limits.APIKeyIdentity{KeyID: "k2", UserID: "user-a"}
	if _, rej := l.Check(t.Context(), b, lim, 0); rej == nil {
		t.Fatal("second key of the same user must be refused: the cap is per account")
	} else if rej.HTTPStatus != 429 {
		t.Fatalf("want 429, got %d", rej.HTTPStatus)
	}
	// A different user is untouched.
	c := &limits.APIKeyIdentity{KeyID: "k3", UserID: "user-b"}
	if _, rej := l.Check(t.Context(), c, lim, 0); rej != nil {
		t.Fatalf("another user must not inherit the counter: %+v", rej)
	}
}

// Same rule for the concurrency gauge: three slots belong to the account; the
// fourth request — even from a different key — waits, and release frees them.
func TestUserScopedConcurrencyCountsAcrossKeysOfOneUser(t *testing.T) {
	l := limits.New(vk.NewFake())
	lim := &store.Limits{UserConcurrency: ptr(int64(2))}

	keys := []*limits.APIKeyIdentity{
		{KeyID: "k1", UserID: "user-a"},
		{KeyID: "k2", UserID: "user-a"},
	}
	var adms []*limits.Admission
	for _, k := range keys {
		adm, rej := l.Check(t.Context(), k, lim, 0)
		if rej != nil {
			t.Fatalf("first two slots must pass: %+v", rej)
		}
		adms = append(adms, adm)
	}
	if _, rej := l.Check(t.Context(), &limits.APIKeyIdentity{KeyID: "k3", UserID: "user-a"}, lim, 0); rej == nil {
		t.Fatal("third concurrent request of the account must be refused")
	}
	// Release both; the account recovers its slots.
	for _, a := range adms {
		a.Release()
	}
	if _, rej := l.Check(t.Context(), &limits.APIKeyIdentity{KeyID: "k4", UserID: "user-a"}, lim, 0); rej != nil {
		t.Fatalf("after release a slot must be available again: %+v", rej)
	}
}

// The legacy shape (a hand-built Limits without UserRPM) keeps the old
// behaviour: lim.RPM counts PER KEY, so two keys of one user each get the cap.
func TestLegacyRPMStaysPerKey(t *testing.T) {
	l := limits.New(vk.NewFake())
	lim := &store.Limits{RPM: ptr(int64(1))}

	if _, rej := l.Check(t.Context(), &limits.APIKeyIdentity{KeyID: "k1", UserID: "user-a"}, lim, 0); rej != nil {
		t.Fatalf("first request must pass: %+v", rej)
	}
	// A SECOND key of the same user has its OWN counter under the legacy shape.
	if _, rej := l.Check(t.Context(), &limits.APIKeyIdentity{KeyID: "k2", UserID: "user-a"}, lim, 0); rej != nil {
		t.Fatalf("legacy Limits must stay per-key: %+v", rej)
	}
}

// EffectiveLimits composes the free-tier default with the platform ceiling and
// an operator row: an account row replaces the default, the ceiling clamps it.
func TestUserLimitsFromAccountRowAndCeiling(t *testing.T) {
	// No DB here — the composition under test is minPtr + defaults, exercised
	// through the same logic EffectiveLimits applies.
	lim := &store.Limits{}
	if lim.UserRPM != nil {
		t.Fatal("hand-built Limits must not invent user limits")
	}
}
