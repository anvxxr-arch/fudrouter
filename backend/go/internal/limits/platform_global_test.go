package limits

import (
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
)

// The platform ceiling must bind on ONE global counter: 150 rps is a property of
// the deployment, not of each key. A per-key reading would let N keys multiply
// the ceiling by N — the exact bug this counter exists to prevent.
func TestPlatformGlobalCounter(t *testing.T) {
	rpm := int64(1) // one request per minute, so the second must be refused
	conc := int64(2)
	l := New(nil)
	lim := &store.Limits{PlatformRPM: &rpm, PlatformConcurrency: &conc}

	if _, rej := l.Check(nil, &APIKeyIdentity{KeyID: "key-a", UserID: "user-a"}, lim, 0); rej != nil {
		t.Fatalf("first request must pass: %+v", rej)
	}
	// A DIFFERENT account: still the same global rpm counter.
	_, rej2 := l.Check(nil, &APIKeyIdentity{KeyID: "key-b", UserID: "user-b"}, lim, 0)
	if rej2 == nil {
		t.Fatal("global rpm counter did not bind across keys")
	}
	if rej2.HTTPStatus != 429 || rej2.Code != "RATE_LIMITED" {
		t.Fatalf("wrong rejection: %+v", rej2)
	}
}

// A refused request must not keep the slots it already took, and Release must
// return them: a leak here silently shrinks the platform ceiling over time.
func TestPlatformConcurrencyReleases(t *testing.T) {
	conc := int64(2)
	l := New(nil)
	lim := &store.Limits{PlatformConcurrency: &conc}

	a1, rej := l.Check(nil, &APIKeyIdentity{KeyID: "k1"}, lim, 0)
	if rej != nil {
		t.Fatalf("slot 1: %+v", rej)
	}
	a2, rej := l.Check(nil, &APIKeyIdentity{KeyID: "k2"}, lim, 0)
	if rej != nil {
		t.Fatalf("slot 2: %+v", rej)
	}
	if _, rej := l.Check(nil, &APIKeyIdentity{KeyID: "k3"}, lim, 0); rej == nil {
		t.Fatal("third in-flight request must be refused")
	}
	a1.Release()
	a2.Release()
	if a3, rej := l.Check(nil, &APIKeyIdentity{KeyID: "k4"}, lim, 0); rej != nil {
		t.Fatalf("slots were not returned by Release: %+v", rej)
	} else {
		a3.Release()
	}
}
