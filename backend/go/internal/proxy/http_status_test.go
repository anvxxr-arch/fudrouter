package proxy_test

// request_log.http_status acceptance: the column must describe the status the
// ROUTER answered with on every outcome, not only on failures.
//
// Measured defect this locks down: 724/724 rows with status='success' carried
// http_status = NULL, because only reject()/fail() ever set the lifecycle's
// httpStat while the success paths wrote 200 straight to the client. Every
// per-status metric therefore undercounted the successful requests — the only
// outcome a customer actually generates volume with.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

func TestSuccessfulBufferedCallRecordsHTTPStatus(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"x","object":"chat.completion","model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"PONG"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}`))
	}))
	defer up.Close()
	env := tests.SeedEnv(t, dsn, up.URL)
	p := tests.NewProxy(t, dsn, up.URL)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"`+env.Slug+`","messages":[{"role":"user","content":"say OK"}],"max_tokens":8}`))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	req.Header.Set("Content-Type", "application/json")
	p.ServeCompletions(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	log := tests.LastRequestLog(t, dsn, env.APIKeyID)
	if log.Status != "success" {
		t.Fatalf("request_log.status = %q, want success", log.Status)
	}
	if log.HTTPStatus == nil {
		t.Fatal("request_log.http_status = NULL on a successful request — the ledger cannot be read per status")
	}
	if *log.HTTPStatus != http.StatusOK {
		t.Errorf("request_log.http_status = %d, want 200", *log.HTTPStatus)
	}
}

func TestFailedCallKeepsItsOwnHTTPStatus(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"message":"boom"}}`))
	}))
	defer up.Close()
	env := tests.SeedEnv(t, dsn, up.URL)
	p := tests.NewProxy(t, dsn, up.URL)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"`+env.Slug+`","messages":[{"role":"user","content":"say OK"}],"max_tokens":8}`))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	req.Header.Set("Content-Type", "application/json")
	p.ServeCompletions(rec, req)
	if rec.Code == http.StatusOK {
		t.Fatalf("a 500 upstream was answered 200: %s", rec.Body.String())
	}
	log := tests.LastRequestLog(t, dsn, env.APIKeyID)
	if log.HTTPStatus == nil {
		t.Fatalf("request_log.http_status = NULL on a failure (client saw %d)", rec.Code)
	}
	if *log.HTTPStatus != rec.Code {
		t.Errorf("request_log.http_status = %d, client saw %d — the column must describe the answer", *log.HTTPStatus, rec.Code)
	}
	if *log.HTTPStatus == http.StatusOK {
		t.Error("the success default leaked onto a failed request")
	}
}
