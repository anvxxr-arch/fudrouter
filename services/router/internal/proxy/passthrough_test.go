package proxy_test

// The generic_passthrough behaviour matrix (Main's decision, spec §14 promise
// #5 + endpoint-surface spec §8's resolved open question):
//
//	absent / {"enabled":false} / false  -> truthful 404 (honesty is the default)
//	true / {"enabled":true}             -> forward non-stateful unimplemented /v1/*
//	stateful /v1/files|batches|vector_stores -> ALWAYS honest 404
//
// The value is read per request and the control plane writes {"enabled":bool}
// while older rows hold a bare bool — both spellings must steer the hatch, or
// the admin toggle silently no-ops. The 404 body must be the spec §8 taxonomy
// shape ({"error":{"message","type","code"}}), never a bare text 404: a valid
// key must learn the truth in a parseable form.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudrouter/services/router/internal/proxy"
	"github.com/anvxxr-arch/fudrouter/services/router/tests"
)

type taxError struct {
	Error struct {
		Message string `json:"message"`
		Type    string `json:"type"`
		Code    string `json:"code"`
	} `json:"error"`
}

type upHit struct{ Method, Path string }

func hitUpstream(t *testing.T) (*httptest.Server, *upHit) {
	t.Helper()
	h := &upHit{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.Method, h.Path = r.Method, r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(srv.Close)
	return srv, h
}

func TestGenericPassthroughMatrix(t *testing.T) {
	dsn := tests.RequireDB(t)
	up, hit := hitUpstream(t)
	env := tests.SeedEnv(t, dsn, up.URL)
	// The real route table with a dialable client: the production upstream
	// client's SSRF guard (correctly) refuses the loopback mock, so every
	// forwarding test in this package dials with tests.NewProxy's plain client.
	// The guard itself is pinned in netguard's and TestClientRefusesNonPublicUpstream.
	mux := proxy.ServeMux(tests.NewProxy(t, dsn, up.URL), readyHealth{})
	keyBody := `{"model":"` + env.Slug + `","query":"x"}`

	// The truthful-404 assertion: spec §8 taxonomy shape, not a bare text 404
	// (which is what an unmatched mux pattern answers).
	assertTruthful404 := func(t *testing.T, rec *httptest.ResponseRecorder) {
		t.Helper()
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404; body %s", rec.Code, rec.Body.String())
		}
		var e taxError
		if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil {
			t.Fatalf("404 body is not JSON at all (%q) — the taxonomy shape is the contract", rec.Body.String())
		}
		if e.Error.Code != "MODEL_NOT_FOUND" {
			t.Errorf("error.code = %q, want MODEL_NOT_FOUND", e.Error.Code)
		}
		if e.Error.Type != "invalid_request_error" {
			t.Errorf("error.type = %q, want invalid_request_error", e.Error.Type)
		}
		if e.Error.Message == "" {
			t.Error("error.message is empty — the 404 must say what is not implemented")
		}
	}
	call := func(t *testing.T, method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		*hit = upHit{} // no upstream contact expected unless the hatch forwards
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+env.Key)
		req.Header.Set("Content-Type", "application/json")
		mux.ServeHTTP(rec, req)
		return rec
	}

	t.Run("absent setting is a truthful 404", func(t *testing.T) {
		assertTruthful404(t, call(t, http.MethodPost, "/v1/rerank", keyBody))
		if hit.Method != "" {
			t.Errorf("upstream saw %s %s — the hatch must be closed by default", hit.Method, hit.Path)
		}
	})
	t.Run("bare true forwards", func(t *testing.T) {
		tests.SetSystemSetting(t, dsn, "generic_passthrough", true)
		rec := call(t, http.MethodPost, "/v1/rerank", keyBody)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 from the forwarded upstream; body %s", rec.Code, rec.Body.String())
		}
		if hit.Method != http.MethodPost || hit.Path != "/rerank" {
			t.Errorf("upstream saw %s %s, want POST /rerank", hit.Method, hit.Path)
		}
	})
	t.Run("object spelling true forwards", func(t *testing.T) {
		// The admin console's shape (apps/web settings.ts): {"enabled":bool}.
		tests.SetSystemSetting(t, dsn, "generic_passthrough", map[string]any{"enabled": true})
		if rec := call(t, http.MethodPost, "/v1/rerank", keyBody); rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 — the console's spelling must open the hatch too; body %s", rec.Code, rec.Body.String())
		}
		if hit.Path != "/rerank" {
			t.Errorf("upstream saw %q, want /rerank", hit.Path)
		}
	})
	t.Run("both off spellings stay 404", func(t *testing.T) {
		tests.SetSystemSetting(t, dsn, "generic_passthrough", map[string]any{"enabled": false})
		assertTruthful404(t, call(t, http.MethodPost, "/v1/rerank", keyBody))
		tests.SetSystemSetting(t, dsn, "generic_passthrough", false)
		assertTruthful404(t, call(t, http.MethodPost, "/v1/rerank", keyBody))
		if hit.Method != "" {
			t.Errorf("upstream saw %s %s with the hatch off", hit.Method, hit.Path)
		}
	})
	t.Run("stateful resources are never forwarded", func(t *testing.T) {
		tests.SetSystemSetting(t, dsn, "generic_passthrough", map[string]any{"enabled": true})
		for _, path := range []string{"/v1/files", "/v1/files/f_1", "/v1/batches", "/v1/batches/b_1", "/v1/vector_stores", "/v1/vector_stores/v_1"} {
			assertTruthful404(t, call(t, http.MethodPost, path, keyBody))
		}
		if hit.Method != "" {
			t.Errorf("upstream saw %s %s — stateful resources are ours to own (spec §6 P2), never a passthrough", hit.Method, hit.Path)
		}
	})
	t.Run("hatch still needs a model to route", func(t *testing.T) {
		// spec §6 P0 rule 6 maps "no model" to a provider-selection strategy —
		// that is P2 scope, so the honest answer is a 400 that says so, never a
		// request forwarded without a target.
		tests.SetSystemSetting(t, dsn, "generic_passthrough", map[string]any{"enabled": true})
		rec := call(t, http.MethodPost, "/v1/rerank", `{"query":"x"}`)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400 for a model-less forwarded body; body %s", rec.Code, rec.Body.String())
		}
		if hit.Method != "" {
			t.Errorf("upstream saw %s %s — nothing may forward without a routing key", hit.Method, hit.Path)
		}
	})
}
