package proxy_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/proxy"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

// A health handler that is always ready, so these cases assert ROUTING and not
// database state: a 503 from /health is a correct answer about the dependency,
// and it would say nothing about whether the pattern matched.
type readyHealth struct{}

func (readyHealth) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true,"service":"fudrouter-router"}`))
}

// muxUnderTest builds the real route table with a real handler, so the table is
// exercised exactly as production wires it.
func muxUnderTest(t *testing.T) *http.ServeMux {
	t.Helper()
	return proxy.ServeMux(tests.NewProxyDefaultClient(t, tests.RequireDB(t)), readyHealth{})
}

// The public surface, pinned.
//
// The catch-all `/v1/` matches every remaining path, so "this endpoint works"
// and "this endpoint fell into the catch-all" look identical from outside without
// a valid key. Before this test the route table was four `mux.Handle` lines in
// main() that nothing asserted: adding a route, renaming one, or letting an exact
// pattern drift into the catch-all changed the API surface silently.
// `docs/specs/2026-09-25-endpoint-surface.md` §7 lists this as an unmet
// acceptance criterion ("Today nothing asserts which paths exist").
//
// Each case asserts that the path is ROUTED — that some handler answered. The
// handler-identity test below pins WHICH handler.
func TestPublicSurfaceIsPinned(t *testing.T) {
	cases := []struct {
		method string
		path   string
	}{
		// Registered exactly.
		{http.MethodGet, "/health"},
		{http.MethodGet, "/v1/models"},
		{http.MethodPost, "/v1/chat/completions"},
		// The catch-all: `/v1/embeddings` reaches ServeGeneric, which bills and
		// forwards. It is not advertised as fully supported (see the endpoint
		// spec §3), but the path is routed.
		{http.MethodPost, "/v1/embeddings"},
	}

	for _, c := range cases {
		t.Run(c.method+" "+c.path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			muxUnderTest(t).ServeHTTP(rec, httptest.NewRequest(c.method, c.path, nil))
			assertRouted(t, c.method, c.path, rec.Code, rec.Body.String())
		})
	}
}

// Which handler answers each exact path.
//
// The two registered handlers are distinguishable by authentication: ServeModels
// is deliberately unauthenticated (the same catalogue is public at /models and
// /pricing — see the endpoint spec §2.1), while every other handler demands a
// Bearer key.
//
// This is a real discriminator for the /v1/models pattern only: drop that exact
// pattern and the request falls into the catch-all, which authenticates and
// answers 401, so `GET /v1/models = 200` goes red. Verified by mutation.
//
// The chat pattern cannot be discriminated by status here (both the chat handler
// and the catch-all answer 401 to a bad key), so it is pinned by behaviour in
// TestChatCompletionsPatternIsServedByTheChatHandler below.
func TestRegisteredHandlerAnswersEachExactPath(t *testing.T) {
	cases := []struct {
		path   string
		method string
		want   int
	}{
		{"/v1/models", http.MethodGet, http.StatusOK},
		{"/v1/chat/completions", http.MethodPost, http.StatusUnauthorized},
		{"/v1/embeddings", http.MethodPost, http.StatusUnauthorized},
	}
	for _, c := range cases {
		t.Run(c.method+" "+c.path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			muxUnderTest(t).ServeHTTP(rec, httptest.NewRequest(c.method, c.path, nil))
			if rec.Code != c.want {
				t.Errorf("%s %s = %d, want %d", c.method, c.path, rec.Code, c.want)
			}
		})
	}
}

// The chat path's exact pattern, discriminated by BEHAVIOUR.
//
// Status codes cannot tell `POST /v1/chat/completions` served by its own handler
// from the same request served by the catch-all: both authenticate first, so both
// answer 401 to a bad key. The only real difference is what ServeCompletions does
// that ServeGeneric does not — it injects `stream_options.include_usage` into the
// upstream body so a streamed reply carries the usage block the bill is computed
// from. ServeGeneric has no such code at all.
//
// So this drives a real streaming request through the REAL mux with a real key
// and asserts the upstream actually received the injection. If the exact pattern
// were dropped, the request would be forwarded by ServeGeneric without it and
// this test would go red — which is what the status-code probe above cannot do.
func TestChatCompletionsPatternIsServedByTheChatHandler(t *testing.T) {
	var gotBody string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "text/event-stream")
		w.(http.Flusher).Flush()
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer up.Close()

	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, up.URL)
	mux := proxy.ServeMux(tests.NewProxy(t, dsn, up.URL), readyHealth{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"`+env.Slug+`","stream":true,"messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	// The assertion that pins the pattern: only ServeCompletions injects this.
	if !strings.Contains(gotBody, `"stream_options"`) || !strings.Contains(gotBody, `"include_usage"`) {
		t.Errorf("upstream body had no stream_options.include_usage injection (%q). "+
			"POST /v1/chat/completions was answered by the /v1/ catch-all instead of "+
			"the chat handler, so streamed requests are billed without a usage block.",
			gotBody)
	}
}

// A method mismatch falls through to the catch-all, and that is the behaviour to
// pin rather than to fix.
//
// Go's ServeMux has no method-mismatch error: a GET against a POST-only pattern
// keeps looking, and the `/v1/` catch-all answers it. So
// `GET /v1/chat/completions` reaches ServeGeneric (401) rather than producing a
// 405 — the Hot path's POST-only registration does not, by itself, prevent a GET
// from being routed, authenticated and billed through the generic handler.
//
// This is silent and worth a test: the response is indistinguishable from the
// exact pattern having been removed, so the only defence against someone "just
// deleting the POST line" is a test that notices the status stopped being what
// the pattern produces for its OWN method.
func TestMethodMismatchFallsThroughToTheCatchAll(t *testing.T) {
	rec := httptest.NewRecorder()
	muxUnderTest(t).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/chat/completions", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("GET /v1/chat/completions = %d, want 401 — that is ServeGeneric "+
			"answering the method mismatch, which is the documented fall-through.",
			rec.Code)
	}
}

// assertRouted fails when the mux itself produced a bare 404, which is the one
// response that proves no pattern matched. Everything else — 200, 400, 401, 503 —
// came from a handler that exists.
func assertRouted(t *testing.T, method, path string, code int, body string) {
	t.Helper()
	const mux404 = "404 page not found\n"
	if code == http.StatusNotFound && body == mux404 {
		t.Errorf("%s %s is not routed: the mux matched no pattern. "+
			"Adding or renaming a route means updating this table.", method, path)
	}
}
