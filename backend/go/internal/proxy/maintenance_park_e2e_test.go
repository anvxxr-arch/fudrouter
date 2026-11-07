package proxy_test

// End-to-end: a provider that answers with its SERVICE-WIDE maintenance
// envelope must cost ONE attempt per request, not one per credential and not
// one per provider_model sibling.
//
// The measured failure (2026-11-03, prv_freemodel): three provider_model rows ×
// two credential rotations = six 32–299 ms attempts per request, 58 requests,
// every one of them freemodel-only — the client got a 503 after the router had
// asked an upgrading provider six times.
//
// This test seeds a two-account pool whose upstream answers the maintenance
// envelope, and asserts the upstream is contacted exactly ONCE and exactly one
// request_attempt row is written. Before the park, the credential rotation alone
// produced two attempts (and a third shard would have made six).
//
// NOTE on scope: the test handler runs on vk.Disabled (see tests.NewProxy), so
// the CROSS-request park degrades open here by design. That half is covered by
// routing.TestMaintenanceParkRoundTrip / TestFilterMaintenanceParked, which
// drive a fake Valkey client. What this test proves is the in-request half: the
// walk stops re-asking the provider that just said it is upgrading.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

const maintenanceBody = `{"error":"FreeModel is being upgraded right now. Please retry in a few minutes - nothing was charged."}`

// maintenanceUpstream answers every request with the measured envelope.
func maintenanceUpstream(t *testing.T, hits *int32) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(hits, 1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(maintenanceBody))
	}))
}

// TestMaintenanceEnvelopeCostsOneAttempt is the card's core reproduction: a
// two-account pool under maintenance must produce ONE upstream exchange.
func TestMaintenanceEnvelopeCostsOneAttempt(t *testing.T) {
	dsn := tests.RequireDB(t)
	var hits int32
	up := maintenanceUpstream(t, &hits)
	defer up.Close()

	// Two accounts: without the fix the credential rotation alone spends two
	// attempts, because the 503 is retryable and the pool has a sibling.
	env := tests.SeedEnvAccounts(t, dsn, up.URL, []string{"acct-a", "acct-b"})

	p := tests.NewProxy(t, dsn, up.URL)

	// Drive it over a real TCP listener rather than a recorder: this is the
	// curl the operator runs, and it exercises the same path (auth, admission,
	// walk, ledger) as a live request.
	srv := httptest.NewServer(http.HandlerFunc(p.ServeGeneric))
	defer srv.Close()

	body := `{"model":"` + env.Slug + `","input":"hi"}`
	t.Logf("curl -sS -X POST %s/v1/embeddings -H 'Authorization: Bearer $KEY' -d '%s'", srv.URL, body)

	httpReq, err := http.NewRequest(http.MethodPost, srv.URL+"/v1/embeddings", strings.NewReader(body))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+env.Key)
	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	reqBody := make([]byte, 4096)
	n, _ := resp.Body.Read(reqBody)
	_ = resp.Body.Close()
	reqBody = reqBody[:n]

	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status %d, want 503 — the client must still see the provider's own unavailability (body=%s)",
			resp.StatusCode, truncateBody(reqBody))
	}
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(reqBody, &envelope); err != nil {
		t.Fatalf("client body is not JSON: %v (%s)", err, truncateBody(reqBody))
	}
	if envelope.Error.Code != "PROVIDER_UNAVAILABLE" {
		t.Errorf("client code = %q, want PROVIDER_UNAVAILABLE", envelope.Error.Code)
	}

	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Fatalf("upstream saw %d requests, want 1 — a maintenance envelope must not be re-asked per credential", got)
	}

	log := tests.LastRequestLog(t, dsn, env.APIKeyID)
	if log.Attempts != 1 {
		t.Fatalf("request_attempt rows = %d, want 1 (was 2 for a two-account pool before the park)", log.Attempts)
	}
}
