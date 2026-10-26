package proxy_test

// The per-account 404 contract.
//
// Why this file exists: tokenharbor gates models PER ACCOUNT. Proven live on
// 2026-10-26 — mimo-v2.6-flash:free answers 200 on 23 of 25 probed accounts
// and 404 "This model is unavailable right now" on the throttled rest, while
// the same accounts serve deepseek-v4.1-flash:free fine. The proxy classified
// every upstream 404 as a non-retryable MODEL_NOT_FOUND, so the round-robin
// landing on a throttled account killed the request even though the very next
// account would have served it: 4 of 4 live attempts failed while direct
// probes on the same pool succeeded.
//
// The rule: an upstream 404 is retryable WHEN the pool holds more than one
// account, because the next Pick() rotates to a different one. A
// single-account pool keeps the honest non-retryable 404 — retrying it would
// only burn the attempt budget on the same deterministic answer.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

// unavailableUpstream answers `good` with 200 and everything else with 404 and
// tokenharbor's own "model unavailable" body — the exact shape that was being
// passed through to clients as MODEL_NOT_FOUND.
func unavailableUpstream(t *testing.T, goodHits *int32) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.Header.Get("Authorization"), "good") {
			atomic.AddInt32(goodHits, 1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true,"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"message":"This model is unavailable right now. Please pick a different model."}}`))
	}))
}

// A per-account 404 must fail over to the healthy account, exactly like a 429
// or a 503: the model exists, this account just cannot serve it.
func TestPerAccount404FailsOverToHealthyAccount(t *testing.T) {
	dsn := tests.RequireDB(t)
	var goodHits int32
	up := unavailableUpstream(t, &goodHits)
	defer up.Close()

	// Round-robin starts at the first account, so the throttled one is
	// probed first and the failover is real, not lucky ordering.
	env := tests.SeedEnvAccounts(t, dsn, up.URL, []string{"bad", "good"})

	if code := postGeneric(t, dsn, up.URL, env); code != http.StatusOK {
		t.Fatalf("status %d, want 200 — a per-account 404 did not fail over to the healthy account", code)
	}
	if atomic.LoadInt32(&goodHits) != 1 {
		t.Fatalf("healthy account saw %d requests, want 1", goodHits)
	}
}

// The control: with ONE account the 404 is the truthful answer. Retrying it
// would burn the attempt budget on the same deterministic response, so the
// proxy must return it as-is and leave the pool alone.
func TestSingleAccount404ReturnedAsIs(t *testing.T) {
	dsn := tests.RequireDB(t)
	var goodHits int32
	up := unavailableUpstream(t, &goodHits)
	defer up.Close()

	env := tests.SeedEnvAccounts(t, dsn, up.URL, []string{"bad"})

	if code := postGeneric(t, dsn, up.URL, env); code != http.StatusNotFound {
		t.Fatalf("status %d, want 404 returned as-is for a single-account pool", code)
	}
	if atomic.LoadInt32(&goodHits) != 0 {
		t.Fatalf("single-account pool saw %d healthy hits, want 0", goodHits)
	}
}
