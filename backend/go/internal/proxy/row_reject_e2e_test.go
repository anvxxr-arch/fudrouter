package proxy_test

// End-to-end: an upstream that answers a retryable 4xx blaming the BODY
// (`duplicate field ...`) must cost ONE attempt per request — not one per
// credential — and the row that was refused must be skipped for the rest of the
// walk.
//
// The measured failure (2026-11-03, prv_tokenjuice row
// pmdl_352ff54e `deepseek-ai/DeepSeek-V4.1-Flash-1017`): HTTP 400
// `duplicate field `reasoning_content` at line 1 column 109228`, retryable=t,
// 383 of 383 attempts. Because a 4xx blames no credential, nothing parked the
// row; it stayed enabled/available and was re-picked on every request, and the
// model it served read request_log p50 88 s (110 of 173 requests over 60 s,
// max 221 s).
//
// This test seeds a two-account pool whose upstream answers that 400, and
// asserts the upstream is contacted exactly ONCE and exactly one
// request_attempt row is written. Before the fix, the credential rotation alone
// produced two attempts (the 400 is retryable, and the pool has a sibling).
//
// NOTE on scope: the test handler runs on vk.Disabled (see tests.NewProxy), so
// the CROSS-request park degrades open here by design. That half is covered by
// routing.TestRowRejectParkRoundTrip / TestFilterRowRejectParked, which drive a
// fake Valkey client, and the in-walk skip is covered by
// routing.TestExecuteParksRowAfterBodyRejection. What this test proves is the
// remaining half: an upstream body rejection is CLASSIFIED as a row rejection
// and stops the credential rotation on the row.
//
// The literal envelope is the measured one, pinned verbatim: lifecycle.go's
// predicate keys on the substrings `deserialize` and `duplicate field`.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

// rowRejectBody is the upstream answer measured from tokenjuice's DeepSeek
// row (line/column included; only the substrings matter to the predicate).
const rowRejectBody = "{\"error\":\"deserialize error: duplicate field `reasoning_content` at line 1 column 109228\"}"

// rowRejectUpstream answers every request with the measured body rejection.
func rowRejectUpstream(t *testing.T, hits *int32) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(hits, 1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(rowRejectBody))
	}))
}

// TestBodyRejectionCostsOneAttempt is the row-reject reproduction: a two-account
// pool whose row is refused must produce ONE upstream exchange.
func TestBodyRejectionCostsOneAttempt(t *testing.T) {
	dsn := tests.RequireDB(t)
	var hits int32
	up := rowRejectUpstream(t, &hits)
	defer up.Close()

	// Two accounts: the body rejection is retryable, so without the fix the
	// credential rotation alone spends two attempts on the same refused row.
	env := tests.SeedEnvAccounts(t, dsn, up.URL, []string{"acct-a", "acct-b"})

	p := tests.NewProxy(t, dsn, up.URL)

	srv := httptest.NewServer(http.HandlerFunc(p.ServeGeneric))
	defer srv.Close()

	body := `{"model":"` + env.Slug + `","input":"hi"}`
	t.Logf("curl -sS -X POST %s/v1/embeddings -H 'Authorization: Bearer ***' -d '%s'", srv.URL, body)

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
	respBody := make([]byte, 4096)
	n, _ := resp.Body.Read(respBody)
	_ = resp.Body.Close()
	respBody = respBody[:n]

	// The client must still see the provider's own rejection — the park is an
	// internal routing fact, never a rewrite of the upstream's answer.
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d, want 400 — the client must still see the provider's own rejection (body=%s)",
			resp.StatusCode, truncateBody(respBody))
	}
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(respBody, &envelope); err != nil {
		t.Fatalf("client body is not JSON: %v (%s)", err, truncateBody(respBody))
	}
	if envelope.Error.Code != "INVALID_REQUEST" {
		t.Errorf("client code = %q, want INVALID_REQUEST", envelope.Error.Code)
	}

	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Fatalf("upstream saw %d requests, want 1 — a body rejection must not be re-asked per credential", got)
	}

	log := tests.LastRequestLog(t, dsn, env.APIKeyID)
	if log.Attempts != 1 {
		t.Fatalf("request_attempt rows = %d, want 1 (was 2 for a two-account pool before the row break)", log.Attempts)
	}
}
