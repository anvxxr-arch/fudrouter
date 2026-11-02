package proxy

import (
	"context"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/vk"
)

// F1 (HA hardening): the breaker config must fail OPEN when the table cannot be
// read — a disabled Valkey plus an unreachable DB returns nil so the caller
// keeps its last good config (D4), never a blanked breaker.
func TestCachedBreakerConfigFailsOpen(t *testing.T) {
	ctx := context.Background()
	// Port 1 is never a Postgres: store.New parses the DSN without dialing, and
	// CircuitBreakers fails fast on the first query.
	st, err := store.New(ctx, "postgres://u:p@127.0.0.1:1/db_breaker")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(st.Close)

	h := &Handler{store: st, vk: vk.Disabled()}
	if got := h.cachedBreakerConfig(ctx); got != nil {
		t.Fatalf("cachedBreakerConfig = %v, want nil when Valkey is disabled and the DB is unreachable", got)
	}
}

// breakerDefaultsFrom must DROP a disabled row: BreakerDefaults has no Enabled
// field, so applying a disabled row would silently enable it.
func TestBreakerDefaultsFromDropsDisabled(t *testing.T) {
	in := map[string]store.CircuitBreakerConfig{
		"connection:con_on": {
			Target: "connection", TargetID: "con_on",
			FailureThreshold: 3, WindowSeconds: 90, OpenMs: 1000, HalfOpenProbes: 2,
			Enabled: true,
		},
		"connection:con_off": {
			Target: "connection", TargetID: "con_off",
			FailureThreshold: 9, Enabled: false,
		},
	}
	out := breakerDefaultsFrom(in)
	if len(out) != 1 {
		t.Fatalf("breakerDefaultsFrom kept %d rows, want 1 (disabled dropped): %+v", len(out), out)
	}
	on, ok := out["connection:con_on"]
	if !ok {
		t.Fatal("enabled row missing from the map")
	}
	if on.FailureThreshold != 3 || on.WindowSeconds != 90 || on.OpenMs != 1000 || on.HalfOpenProbes != 2 {
		t.Errorf("enabled row fields not copied: %+v", on)
	}
	if _, ok := out["connection:con_off"]; ok {
		t.Error("disabled row was applied as if enabled")
	}
}
