package proxy

import (
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/routing"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
)

// candWithLatency builds the minimum Candidate firstTryFits inspects.
func candWithLatency(ms int64) *routing.Candidate {
	return &routing.Candidate{
		Store:     &store.Candidate{ProviderID: "prv_x", ProviderModelID: "pmdl_x"},
		LatencyMs: ms,
	}
}

// The bug this guards (measured 2026-11-03): a row that ONLY answers a
// retryable 4xx never gets any credential parked, so its measured latency
// estimate climbs toward the wire timeout (125–165 s observed for the tokenjuice
// DeepSeek-V4.1-Flash row). Before the floor, the FIRST-try exception started
// such a candidate on ANY request however small the remaining budget, and the
// client inherited the hang — the model read request_log p50 88 s (110 of 173
// requests over 60 s, max 221 s).
func TestFirstTryFitsBoundsPoisonedEstimate(t *testing.T) {
	now := time.Now()

	cases := []struct {
		name      string
		latencyMs int64
		budget    time.Duration
		want      bool
	}{
		// A poisoned estimate must NOT buy a start on a nearly-expired request.
		{"poisoned estimate, 2s budget", 150_000, 2 * time.Second, false},
		{"poisoned estimate, 9s budget", 150_000, 9 * time.Second, false},
		// At the floor it fits (10s estimate ≤ 10s remaining).
		{"poisoned estimate, exactly the floor", 150_000, 10 * time.Second, true},
		{"poisoned estimate, 30s budget", 150_000, 30 * time.Second, true},
		// A healthy estimate is untouched by the floor: it still has to fit.
		{"healthy estimate, tight budget", 7_000, 3 * time.Second, false},
		{"healthy estimate, roomy budget", 7_000, 30 * time.Second, true},
		// Unmeasured (300ms default) is always trustworthy — this is the case
		// the first-try exception exists for, and it must keep working.
		{"unmeasured candidate, tight budget", 0, 200 * time.Millisecond, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := firstTryFits(now, now.Add(tc.budget), candWithLatency(tc.latencyMs))
			if got != tc.want {
				t.Errorf("firstTryFits(latencyMs=%d, budget=%v) = %v, want %v",
					tc.latencyMs, tc.budget, got, tc.want)
			}
		})
	}
}

// No deadline (the streaming/unbounded path) must never be gated by the floor.
func TestFirstTryFitsWithoutDeadline(t *testing.T) {
	if !firstTryFits(time.Now(), time.Time{}, candWithLatency(150_000)) {
		t.Fatal("a request with no deadline must always allow a first try")
	}
	// A nil candidate must not panic and must not block the walk.
	if !firstTryFits(time.Now(), time.Now().Add(time.Second), nil) {
		t.Fatal("a nil candidate must allow the first try (walk handles it)")
	}
}
