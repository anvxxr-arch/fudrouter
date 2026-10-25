package proxy_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/proxy"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

// chatUpstream answers the probe's one-token completion like a real upstream:
// 200 + a choices array. The in-repo echoUpstream returns no choices (an
// accepted-in-prod but malformed-by-OpenAI body), which is exactly the case
// the probe must classify as down, so the ok-path needs its own server.
func chatUpstream(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "chatcmpl-probe", "object": "chat.completion", "model": "up-model",
			"choices": []any{map[string]any{"index": 0, "message": map[string]string{"role": "assistant", "content": "pong"}, "finish_reason": "stop"}},
			"usage":   map[string]any{"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
		})
	}))
	t.Cleanup(srv.Close)
	return srv
}

// TestProbeOnceOk pins the headline promise: a probe through the REAL routing
// walk against a live upstream lands as status=ok with non-negative latency.
func TestProbeOnceOk(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := chatUpstream(t)
	env := tests.SeedEnv(t, dsn, up.URL)
	h := tests.NewProxy(t, dsn, up.URL)

	e := h.ProbeOnce(context.Background(), env.Slug)
	if e.Status != "ok" {
		t.Fatalf("probe status = %q (err %q), want ok", e.Status, e.ErrCode)
	}
	if e.LatencyMs < 0 {
		t.Fatalf("latency = %d, want >= 0", e.LatencyMs)
	}
	if e.CheckedAt.IsZero() {
		t.Fatal("checked_at must be stamped")
	}
}

// TestProbeOnceDown pins the failure contract: a dead upstream answers down
// with a routing-layer error code, never a fabricated ok.
func TestProbeOnceDown(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := chatUpstream(t)
	env := tests.SeedEnv(t, dsn, up.URL)
	// Close the upstream AFTER seeding: the candidate targets its URL, which
	// now refuses connections — the honest "provider is down" scenario.
	up.Close()
	h := tests.NewProxy(t, dsn, up.URL)

	e := h.ProbeOnce(context.Background(), env.Slug)
	if e.Status != "down" {
		t.Fatalf("probe status = %q against a dead upstream, want down", e.Status)
	}
	if e.ErrCode == "" {
		t.Fatal("a dead upstream must carry a non-empty error code")
	}
}

// TestModelDetailOptInAbsentBeforeSweep pins the opt-in contract: without a
// health flag the object keeps the literal §6 P1 field set (exactly 5 fields),
// and with the flag a never-probed model OMITS health — absent = not probed.
func TestModelDetailOptInAbsentBeforeSweep(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := chatUpstream(t)
	env := tests.SeedEnv(t, dsn, up.URL)
	mux := proxy.ServeMux(tests.NewProxy(t, dsn, up.URL), readyHealth{})

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/models/"+env.Slug, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET detail = %d, want 200", rec.Code)
	}
	var plain map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &plain); err != nil {
		t.Fatalf("detail not JSON: %s", rec.Body.String())
	}
	if len(plain) != 5 {
		t.Fatalf("default detail fields = %v (%d), want exactly the 5 P1 fields", keysOf(plain), len(plain))
	}

	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/models/"+env.Slug+"?health=1", nil))
	var optIn map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &optIn); err != nil {
		t.Fatalf("opt-in detail not JSON: %s", rec.Body.String())
	}
	if _, present := optIn["health"]; present {
		t.Fatalf("never-probed model must OMIT health, got %v", optIn["health"])
	}
}

// TestHealthVisibleAfterProbeOnce is the closed loop: one successful probe
// makes the opt-in surfaces answer with the recorded status immediately.
func TestHealthVisibleAfterProbeOnce(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := chatUpstream(t)
	env := tests.SeedEnv(t, dsn, up.URL)
	h := tests.NewProxy(t, dsn, up.URL)
	mux := proxy.ServeMux(h, readyHealth{})

	if e := h.ProbeOnce(context.Background(), env.Slug); e.Status != "ok" {
		t.Fatalf("probe = %q (%q), want ok", e.Status, e.ErrCode)
	}

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/models/"+env.Slug+"?health=1", nil))
	var detail map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &detail); err != nil {
		t.Fatalf("detail not JSON: %s", rec.Body.String())
	}
	hv, present := detail["health"].(map[string]any)
	if !present {
		t.Fatalf("probed model must carry health after ProbeOnce, got %v", detail)
	}
	if hv["status"] != "ok" {
		t.Fatalf("health.status = %v, want ok", hv["status"])
	}

	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/models?health=1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET list?health=1 = %d", rec.Code)
	}
	var list struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("list not JSON: %s", rec.Body.String())
	}
	var hit bool
	for _, m := range list.Data {
		if m["id"] == env.Slug {
			_, hit = m["health"].(map[string]any)
		}
	}
	if !hit {
		t.Fatalf("opt-in list entry must carry health after the probe")
	}
}

// TestModelsListStaysValid keeps the additive-field promise honest: the list
// endpoint still answers 200 with the S0 envelope, whatever health data exists.
func TestModelsListStaysValid(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := chatUpstream(t)
	tests.SeedEnv(t, dsn, up.URL)
	mux := proxy.ServeMux(tests.NewProxy(t, dsn, up.URL), readyHealth{})

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/models", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /v1/models = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"object":"list"`) {
		t.Fatal("list envelope lost")
	}
}
