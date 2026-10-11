package proxy_test

// The failover contract, widened 2026-09-27. Before this, ONLY a 401/403 moved
// the request to the next pooled account: a 429 (per-account throttle), a 5xx
// (bad upstream instance) or a transport error (timeout/reset/EOF) reached the
// client while a live account sat in the pool, and the account that produced
// them was never parked. Measured end to end by scratch/route-integrity/run.sh
// (T2/T3 showed 429 and 503 landing on the client).
//
// The control case matters as much as the retry cases: a 400 is request-shaped,
// so the proxy must NOT burn the pool on it.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

// retryableUpstream answers `good` with 200 and everything else with `status`.
// goodHits counts how many requests reached the healthy account.
func retryableUpstream(t *testing.T, status int, goodHits *int32) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.Header.Get("Authorization"), "good") {
			atomic.AddInt32(goodHits, 1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true,"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"error":"from the mock"}`))
	}))
}

func postGeneric(t *testing.T, dsn, url string, env *tests.Env) int {
	t.Helper()
	p := tests.NewProxy(t, dsn, url)
	rec := httptest.NewRecorder()
	body := `{"model":"` + env.Slug + `","input":"hi"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/embeddings", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeGeneric(rec, req)
	return rec.Code
}

func TestFailsOverOnRetryableStatuses(t *testing.T) {
	cases := []struct {
		name   string
		status int
	}{
		{"429 rate limited", http.StatusTooManyRequests},
		{"502 bad gateway", http.StatusBadGateway},
		{"503 unavailable", http.StatusServiceUnavailable},
		{"504 gateway timeout", http.StatusGatewayTimeout},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dsn := tests.RequireDB(t)
			var goodHits int32
			up := retryableUpstream(t, tc.status, &goodHits)
			defer up.Close()

			// Round-robin starts at the first account, so the failing one is
			// probed first and the failover is real, not lucky ordering.
			env := tests.SeedEnvAccounts(t, dsn, up.URL, []string{"bad", "good"})

			if code := postGeneric(t, dsn, up.URL, env); code != http.StatusOK {
				t.Fatalf("status %d, want 200 — %d did not fail over to the healthy account", code, tc.status)
			}
			if atomic.LoadInt32(&goodHits) != 1 {
				t.Fatalf("healthy account saw %d requests, want 1", goodHits)
			}
		})
	}
}

// A 400 belongs to the request, not the credential: another account cannot fix
// it, so the proxy must return it and leave the pool alone.
func TestRequestShaped4xxDoesNotFailOver(t *testing.T) {
	dsn := tests.RequireDB(t)
	var goodHits int32
	up := retryableUpstream(t, http.StatusBadRequest, &goodHits)
	defer up.Close()

	env := tests.SeedEnvAccounts(t, dsn, up.URL, []string{"bad", "good"})
	if code := postGeneric(t, dsn, up.URL, env); code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400 returned as-is", code)
	}
	if atomic.LoadInt32(&goodHits) != 0 {
		t.Fatalf("a request-shaped 400 burned the pool: healthy account saw %d requests", goodHits)
	}
}

// A transport error (connection reset before any response) is retryable: the
// client must not see it while another account remains.
func TestTransportErrorFailsOver(t *testing.T) {
	dsn := tests.RequireDB(t)
	var goodHits int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.Header.Get("Authorization"), "good") {
			atomic.AddInt32(&goodHits, 1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
			return
		}
		// Answer nothing and slam the connection: the client sees EOF.
		hj, ok := w.(http.Hijacker)
		if !ok {
			t.Fatal("test upstream cannot hijack")
		}
		conn, _, err := hj.Hijack()
		if err != nil {
			t.Fatalf("hijack: %v", err)
		}
		_ = conn.Close()
	}))
	defer up.Close()

	env := tests.SeedEnvAccounts(t, dsn, up.URL, []string{"bad", "good"})
	if code := postGeneric(t, dsn, up.URL, env); code != http.StatusOK {
		t.Fatalf("status %d, want 200 — a transport error did not fail over", code)
	}
	if atomic.LoadInt32(&goodHits) != 1 {
		t.Fatalf("healthy account saw %d requests, want 1", goodHits)
	}
}

// The chat path is the audited one; pin the 429 failover there too so both call
// sites stay covered.
func TestChatPathFailsOverOn429(t *testing.T) {
	dsn := tests.RequireDB(t)
	var goodHits int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(r.Header.Get("Authorization"), "good") {
			atomic.AddInt32(&goodHits, 1)
			_, _ = w.Write([]byte(`{"id":"x","object":"chat.completion","model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"PONG"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}`))
			return
		}
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"message":"rate limit exceeded"}}`))
	}))
	defer up.Close()

	env := tests.SeedEnvAccounts(t, dsn, up.URL, []string{"bad", "good"})
	p := tests.NewProxy(t, dsn, up.URL)
	rec := httptest.NewRecorder()
	body := `{"model":"` + env.Slug + `","messages":[{"role":"user","content":"say OK"}],"max_tokens":8}`
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	req.Header.Set("Content-Type", "application/json")
	p.ServeCompletions(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s — the chat path did not fail over a 429", rec.Code, rec.Body.String())
	}
	if atomic.LoadInt32(&goodHits) != 1 {
		t.Fatalf("healthy account saw %d requests, want 1", goodHits)
	}
}
