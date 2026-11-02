package proxy_test

// The 2xx ERROR-ENVELOPE contract.
//
// Why this file exists: an upstream can answer a refusal with HTTP 200 and an
// error envelope in the BODY. tokenharbor.ai does exactly that, proved live
// 2026-11-02:
//
//	HTTP/1.1 200 OK
//	Server: nginx/1.18.0 (Ubuntu)
//	X-RateLimit-Limit: 60
//	{"error":{"message":"Per-minute rate limit reached — slow down a bit.",
//	          "type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}
//
// The router read only the status. So the walk saw a terminal SUCCESS: it
// stopped (no failover ran), the ledger recorded status='success', and the
// client was handed the refusal as if it were an answer. A 200 was answering
// 200 with a refusal inside.
//
// The rule: a buffered 2xx whose body is an error envelope and carries NO
// completion payload is a FAILED attempt, classified from the envelope. It is
// retryable when the pool holds more than one account (the next Pick() rotates
// to a funded sibling) and terminal for a single-account pool. The raw envelope
// is never relayed as the client's answer.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

// envelopeUpstream answers the `good` account with a real completion and every
// other account with HTTP 200 + the rate-limit envelope an exhausted account
// returns.
func envelopeUpstream(t *testing.T, goodHits *int32) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(r.Header.Get("Authorization"), "good") {
			atomic.AddInt32(goodHits, 1)
			// 200 with a REAL completion: the sniff must let this through.
			_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],` +
				`"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
			return
		}
		// 200 with an error envelope and no completion payload.
		_, _ = w.Write([]byte(`{"error":{"message":"Per-minute rate limit reached — slow down a bit.",` +
			`"type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}`))
	}))
}

// postGenericBody mirrors postGenericCode but hands back the raw body, so a test
// can prove the client got a real completion and NOT the relayed envelope.
func postGenericBody(t *testing.T, dsn, url string, env *tests.Env) (int, []byte) {
	t.Helper()
	p := tests.NewProxy(t, dsn, url)
	rec := httptest.NewRecorder()
	body := `{"model":"` + env.Slug + `","input":"hi"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/embeddings", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeGeneric(rec, req)
	return rec.Code, rec.Body.Bytes()
}

// A throttled account's 200-wrapped refusal must fail over to a funded account,
// exactly like a per-account 402 or 429 — the provider is fine, this account is
// being throttled.
func TestHTTP200ErrorEnvelopeFailsOverToFundedAccount(t *testing.T) {
	dsn := tests.RequireDB(t)
	var goodHits int32
	up := envelopeUpstream(t, &goodHits)
	defer up.Close()

	// Round-robin starts at the first account, so the throttled one is probed
	// first and the failover is real, not lucky ordering.
	env := tests.SeedEnvAccounts(t, dsn, up.URL, []string{"throttled", "good"})

	code, body := postGenericBody(t, dsn, up.URL, env)
	if code != http.StatusOK {
		t.Fatalf("status %d, want 200 — a 2xx error envelope did not fail over to the funded account (body=%s)",
			code, truncateBody(body))
	}
	if got := atomic.LoadInt32(&goodHits); got != 1 {
		t.Fatalf("funded account saw %d requests, want 1", got)
	}
	// The client must get the COMPLETION, never the relayed envelope.
	var parsed struct {
		Choices []json.RawMessage `json:"choices"`
		Error   json.RawMessage   `json:"error"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatalf("client body is not JSON: %v (%s)", err, truncateBody(body))
	}
	if len(parsed.Choices) == 0 {
		t.Fatalf("client body has no choices — the 200-envelope was relayed as an answer: %s", truncateBody(body))
	}
	if parsed.Error != nil {
		t.Fatalf("client body carries an error envelope alongside the completion: %s", truncateBody(body))
	}

	// And the ledger must record a real success, not a phantom one.
	log := tests.LastRequestLog(t, dsn, env.APIKeyID)
	if log.Status != "success" {
		t.Errorf("ledger status = %q, want success", log.Status)
	}
}

// The control: with ONE account the envelope is terminal. It must NOT be
// reported to the client as a success, and it must not be relayed as an answer.
func TestSingleAccountHTTP200ErrorEnvelopeIsNotSuccess(t *testing.T) {
	dsn := tests.RequireDB(t)
	var goodHits int32
	up := envelopeUpstream(t, &goodHits)
	defer up.Close()

	env := tests.SeedEnvAccounts(t, dsn, up.URL, []string{"throttled"})

	code, body := postGenericBody(t, dsn, up.URL, env)
	if code == http.StatusOK {
		t.Fatalf("status %d, want a failure — a single-account 200 error envelope must not succeed (body=%s)",
			code, truncateBody(body))
	}
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatalf("client body is not JSON: %v (%s)", err, truncateBody(body))
	}
	if envelope.Error.Code != "RATE_LIMITED" {
		t.Errorf("client code = %q, want RATE_LIMITED — the envelope's own code must be classified", envelope.Error.Code)
	}
	if got := atomic.LoadInt32(&goodHits); got != 0 {
		t.Fatalf("single-account pool saw %d funded hits, want 0", got)
	}

	log := tests.LastRequestLog(t, dsn, env.APIKeyID)
	if log.Status == "success" {
		t.Errorf("ledger status = success — a 200 with a refusal inside was recorded as a success")
	}
}

func truncateBody(b []byte) string {
	const n = 220
	s := strings.TrimSpace(string(b))
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}
