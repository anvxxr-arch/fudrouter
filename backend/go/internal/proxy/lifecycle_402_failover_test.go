package proxy_test

// The per-account 402 contract.
//
// Why this file exists: a free-tier pool is paid PER ACCOUNT, and an account
// runs out of credits long before its key goes invalid — so a 402 arrives from
// one account while its siblings still serve. routing.ClassifyRetryable already
// lists INSUFFICIENT_CREDITS as retryable (spec §9), but ClassifyUpstream
// answered 402 with retryable=false, so the candidate loop broke on the FIRST
// spent account and the client got the rejection while the rest of the pool sat
// idle.
//
// Measured on prv_zro 2026-10-30 with a two-account pool holding one spent key:
// 6/6 live requests failed (5x402 + 1x503 CIRCUIT_OPEN) and the spent key was
// never parked, so every following request rediscovered it. The same pool
// answered 8/8 200 once the escalation below existed.
//
// The rule: an upstream 402 is retryable WHEN the pool holds more than one
// account, because the next Pick() rotates to a different one and the loop
// parks the spent row. A single-account pool keeps the honest non-retryable
// 402 — retrying it would only burn the attempt budget on the same
// deterministic answer.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

// spentUpstream answers the `good` account with 200 and everything else with
// the 402 + INSUFFICIENT_CREDITS body a drained free-tier account returns.
func spentUpstream(t *testing.T, goodHits *int32) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.Header.Get("Authorization"), "good") {
			atomic.AddInt32(goodHits, 1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true,"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusPaymentRequired)
		_, _ = w.Write([]byte(`{"error":{"code":"INSUFFICIENT_CREDITS","message":"Insufficient balance"}}`))
	}))
}

// A spent account's 402 must fail over to a funded account, exactly like a
// per-account 404 or a 429: the provider is fine, this account cannot pay.
func TestPerAccount402FailsOverToFundedAccount(t *testing.T) {
	dsn := tests.RequireDB(t)
	var goodHits int32
	up := spentUpstream(t, &goodHits)
	defer up.Close()

	// Round-robin starts at the first account, so the spent one is probed
	// first and the failover is real, not lucky ordering.
	env := tests.SeedEnvAccounts(t, dsn, up.URL, []string{"spent", "good"})

	if code := postGeneric(t, dsn, up.URL, env); code != http.StatusOK {
		t.Fatalf("status %d, want 200 — a per-account 402 did not fail over to the funded account", code)
	}
	if got := atomic.LoadInt32(&goodHits); got != 1 {
		t.Fatalf("funded account saw %d requests, want 1", got)
	}
}

// The control: with ONE account the 402 is the terminal answer. Retrying it
// would burn the attempt budget on the same deterministic response.
//
// The client-facing CODE is UPSTREAM_ERROR, not INSUFFICIENT_CREDITS. An
// upstream 402 is the PROVIDER's quota — measured live 2026-10-31: zro answered
// 402 "You've used today's Free usage" while the customer's balance was
// untouched. INSUFFICIENT_CREDITS is reserved for the router's own budget gate
// (PRD §129), so reporting it here told the customer to top up when the fix was
// to route elsewhere. What this test pins is the part that did not change: the
// walk does NOT retry a single-account 402.
func TestSingleAccount402ReturnedAsIs(t *testing.T) {
	dsn := tests.RequireDB(t)
	var goodHits int32
	up := spentUpstream(t, &goodHits)
	defer up.Close()

	env := tests.SeedEnvAccounts(t, dsn, up.URL, []string{"spent"})

	code, errCode := postGenericCode(t, dsn, up.URL, env)
	if code == http.StatusOK {
		t.Fatalf("status %d, want a failure — a single-account 402 must not succeed", code)
	}
	if errCode == "INSUFFICIENT_CREDITS" {
		t.Errorf("client code = INSUFFICIENT_CREDITS, want UPSTREAM_ERROR — an upstream 402 is the provider's quota, not the customer's balance")
	}
	if got := atomic.LoadInt32(&goodHits); got != 0 {
		t.Fatalf("single-account pool saw %d funded hits, want 0", got)
	}
}
