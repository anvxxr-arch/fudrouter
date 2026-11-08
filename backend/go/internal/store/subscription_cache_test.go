package store_test

// B0 — the subscription read must be served from the in-process cache, never as
// a Postgres round trip per request. The read is added to checkBudgets (the
// admission hot path), which is exactly where the account/budget reads had to
// be cached out (525µs/request -> single-digit µs); this test pins that the
// subscription read follows the same contract instead of quietly re-growing the
// per-request query count the cache exists to remove.

import (
	"context"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

func TestAdmissionSubscriptionServesRepeatReadsFromCache(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	s, tr := startCounting(t, dsn)
	ctx := context.Background()

	// The first read fills the cache and is expected to query (LatestSubscription).
	if _, err := s.AdmissionSubscription(ctx, env.UserID); err != nil {
		t.Fatalf("first AdmissionSubscription: %v", err)
	}
	tr.Reset()
	for range 50 {
		if _, err := s.AdmissionSubscription(ctx, env.UserID); err != nil {
			t.Fatalf("cached AdmissionSubscription: %v", err)
		}
	}
	if got := tr.Count(); got != 0 {
		t.Errorf("50 cached subscription reads issued %d queries, want 0: %v", got, tr.Texts())
	}
}
