package proxy_test

// The endpoint-surface spec §3 table, asserted row by row with a seeded key
// (§7 acceptance: "a test pins the surface ... hits every path in §3 with a
// seeded key and asserts the expected status"). Each row's expected status is
// the state the router is CONTRACTED to reach:
//
//	 1 POST /v1/responses          forwarded faithfully (Tier A)
//	 2 POST /v1/chat/completions   native hot path
//	 3 POST /v1/completions        forwarded faithfully (Tier A)
//	 4 GET  /v1/models             native catalogue, public
//	 5 GET  /v1/models/{model}     native single row, public (was: 400!)
//	 6 POST /v1/embeddings         forwarded, billed (Tier A)
//	 7 POST /v1/moderations        forwarded faithfully (Tier A)
//	 8–15 files/batches/vector_stores: stateful (Tier C) → truthful 404 error
//	   body, never a forwarded lie and never "400 invalid JSON body".
//
// The §7 fidelity lines ride the same table's forwarded rows: the echo upstream
// proves the real method (a DELETE arrives as DELETE — row 13's old POST
// hardcode), the query string survives, and the request Content-Type passes
// through. A streamed Tier A call must bill (tokens_in > 0), and the PRD §90
// response headers must be present with cost metadata behind its flag.

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudrouter/services/router/internal/proxy"
	"github.com/anvxxr-arch/fudrouter/services/router/tests"
)

// echoUpstream answers with a JSON description of the request it received, so
// the response body IS the forwarding-fidelity evidence.
func echoUpstream(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"method":       r.Method,
			"path":         r.URL.Path,
			"query":        r.URL.RawQuery,
			"content_type": r.Header.Get("Content-Type"),
			"body":         string(b),
		})
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestEndpointSurfaceSpec3Rows(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := echoUpstream(t)
	env := tests.SeedEnv(t, dsn, up.URL)
	mux := proxy.ServeMux(tests.NewProxy(t, dsn, up.URL), readyHealth{})
	modelBody := `{"model":"` + env.Slug + `","input":"x"}`

	call := func(t *testing.T, method, path, body string, contentType string) *httptest.ResponseRecorder {
		t.Helper()
		rec := httptest.NewRecorder()
		var rdr io.Reader
		if body != "" {
			rdr = strings.NewReader(body)
		}
		req := httptest.NewRequest(method, path, rdr)
		req.Header.Set("Authorization", "Bearer "+env.Key)
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		mux.ServeHTTP(rec, req)
		return rec
	}

	// The forwarded rows relay the echo: method, path and query must be the
	// client's, not hardcoded POST or a query-less rebuild (spec §6 P0 rules 2-4).
	assertForwarded := func(t *testing.T, method, path, wantUpPath string) {
		t.Helper()
		rec := call(t, method, path, modelBody, "application/json; charset=utf-8")
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
		}
		var echo struct {
			Method      string `json:"method"`
			Path        string `json:"path"`
			ContentType string `json:"content_type"`
			Body        string `json:"body"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &echo); err != nil {
			t.Fatalf("response is not the upstream echo: %s", rec.Body.String())
		}
		if echo.Method != method {
			t.Errorf("upstream method = %s, want %s (method must not be hardcoded POST)", echo.Method, method)
		}
		if echo.Path != wantUpPath {
			t.Errorf("upstream path = %s, want %s", echo.Path, wantUpPath)
		}
		if !strings.Contains(echo.ContentType, "application/json") {
			t.Errorf("upstream content-type = %q, want the client's passed through", echo.ContentType)
		}
		if !strings.Contains(echo.Body, env.Slug) {
			t.Errorf("upstream body lost the request body: %q", echo.Body)
		}
	}

	t.Run("row1 POST /v1/responses forwarded", func(t *testing.T) {
		assertForwarded(t, http.MethodPost, "/v1/responses", "/responses")
	})
	t.Run("row2 POST /v1/chat/completions native", func(t *testing.T) {
		rec := call(t, http.MethodPost, "/v1/chat/completions",
			`{"model":"`+env.Slug+`","messages":[{"role":"user","content":"hi"}]}`, "application/json")
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
		}
	})
	t.Run("row3 POST /v1/completions forwarded", func(t *testing.T) {
		assertForwarded(t, http.MethodPost, "/v1/completions", "/completions")
	})
	t.Run("row4 GET /v1/models public catalogue", func(t *testing.T) {
		rec := call(t, http.MethodGet, "/v1/models", "", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
		}
		var list struct {
			Data []map[string]any `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil || len(list.Data) == 0 {
			t.Fatalf("catalogue not a data list: %s", rec.Body.String())
		}
		// Public (spec §2.1): the same answer without any key.
		anon := httptest.NewRecorder()
		mux.ServeHTTP(anon, httptest.NewRequest(http.MethodGet, "/v1/models", nil))
		if anon.Code != http.StatusOK {
			t.Errorf("GET /v1/models without a key = %d, want 200 (public catalogue)", anon.Code)
		}
	})
	t.Run("row5 GET /v1/models/{model} native single row", func(t *testing.T) {
		rec := call(t, http.MethodGet, "/v1/models/"+env.Slug, "", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d body %s — row 5 was 400 'invalid JSON body' before", rec.Code, rec.Body.String())
		}
		var obj map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &obj); err != nil {
			t.Fatalf("not a model object: %s", rec.Body.String())
		}
		if obj["id"] != env.Slug {
			t.Errorf("id = %v, want %s", obj["id"], env.Slug)
		}
	})
	t.Run("row6 POST /v1/embeddings forwarded", func(t *testing.T) {
		assertForwarded(t, http.MethodPost, "/v1/embeddings", "/embeddings")
	})
	t.Run("row7 POST /v1/moderations forwarded", func(t *testing.T) {
		assertForwarded(t, http.MethodPost, "/v1/moderations", "/moderations")
	})

	statefulRows := []struct{ method, path string }{
		{http.MethodPost, "/v1/batches"},          // row 8
		{http.MethodGet, "/v1/batches/b_1"},       // row 9
		{http.MethodPost, "/v1/files"},            // row 10
		{http.MethodGet, "/v1/files"},             // row 11
		{http.MethodGet, "/v1/files/f_1"},         // row 12
		{http.MethodDelete, "/v1/files/f_1"},      // row 13 (was: forwarded as POST)
		{http.MethodPost, "/v1/vector_stores"},    // row 14
		{http.MethodGet, "/v1/vector_stores"},     // row 15
	}
	for i, row := range statefulRows {
		t.Run("stateful row "+strconv.Itoa(8+i), func(t *testing.T) {
			rec := call(t, row.method, row.path, modelBody, "application/json")
			if rec.Code != http.StatusNotFound {
				t.Fatalf("%s %s = %d, want 404 (stateful resources are honest 404s, never 400 'invalid JSON body')",
					row.method, row.path, rec.Code)
			}
			var e taxError
			if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil || e.Error.Code == "" {
				t.Fatalf("%s %s 404 body is not the taxonomy envelope: %s", row.method, row.path, rec.Body.String())
			}
		})
	}

	t.Run("query string survives forwarding", func(t *testing.T) {
		rec := call(t, http.MethodPost, "/v1/embeddings?api-version=2024-01-01&x=1", modelBody, "application/json")
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
		}
		var echo struct {
			Query string `json:"query"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &echo)
		if echo.Query != "api-version=2024-01-01&x=1" {
			t.Errorf("upstream query = %q, want the client's query string (§7: a query string survives)", echo.Query)
		}
	})
	t.Run("DELETE reaches upstream as DELETE", func(t *testing.T) {
		// §7: "A DELETE reaches the upstream as a DELETE" — the stateful row
		// above never forwards, so the method fidelity is pinned through the
		// passthrough hatch on an ad-hoc endpoint (the P0 rules are about the
		// forwarder, and this is the forwarder's only remaining DELETE path).
		tests.SetSystemSetting(t, dsn, "generic_passthrough", map[string]any{"enabled": true})
		rec := call(t, http.MethodDelete, "/v1/rerank?after=cur", modelBody, "application/json; charset=utf-8")
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
		}
		var echo struct {
			Method      string `json:"method"`
			Path        string `json:"path"`
			Query       string `json:"query"`
			ContentType string `json:"content_type"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &echo)
		if echo.Method != http.MethodDelete {
			t.Errorf("upstream method = %s, want DELETE (row 13's POST hardcode is gone)", echo.Method)
		}
		if echo.Path != "/rerank" || echo.Query != "after=cur" {
			t.Errorf("upstream target = %s?%s, want /rerank?after=cur", echo.Path, echo.Query)
		}
		if !strings.Contains(echo.ContentType, "application/json") {
			t.Errorf("content-type = %q, want the client's passed through", echo.ContentType)
		}
	})
}

// §7: "A streamed call on any Tier A endpoint writes tokens_in > 0 to
// request_log" — the generic path used to have no usage injection at all, so
// every streamed Tier A call was recorded at zero tokens and zero cost.
func TestGenericStreamIsBilled(t *testing.T) {
	dsn := tests.RequireDB(t)
	var gotAuth, gotBody string
	up := newUpstream(t, []string{
		`{"object":"chunk","choices":[{"delta":{"content":"He"}}]}`,
		`{"object":"chunk","choices":[],"usage":{"prompt_tokens":21,"completion_tokens":13,"total_tokens":34}}`,
	}, &gotAuth, &gotBody)
	defer up.Close()
	env := tests.SeedEnv(t, dsn, up.URL)
	p := tests.NewProxy(t, dsn, up.URL)
	rec := httptest.NewRecorder()
	body := `{"model":"` + env.Slug + `","stream":true,"input":"hi"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	req.Header.Set("Content-Type", "application/json")
	p.ServeGeneric(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(gotBody, `"include_usage":true`) {
		t.Error("stream_options.include_usage not injected on the generic path (P0 rule 5)")
	}
	log := tests.LastRequestLog(t, dsn, env.APIKeyID)
	if log.TokensIn == 0 {
		t.Error("tokens_in = 0 — a streamed Tier A call must record the provider's usage (§7)")
	}
	if log.Cost == 0 {
		t.Error("cost = 0 — the streamed Tier A call is unbilled")
	}
}

// PRD §90: identity headers on every response; cost metadata is OFF by default
// and only on behind ROUTER_COST_HEADERS.
func TestResponseHeadersFollowPRD90(t *testing.T) {
	dsn := tests.RequireDB(t)
	// A usage-bearing response: cost metadata is computed FROM the provider's
	// reported usage, so the header can only exist when the body carried one.
	up := jsonUpstream(t, `{"ok":true,"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}`, nil, 200)
	env := tests.SeedEnv(t, dsn, up.URL)
	call := func(t *testing.T) *httptest.ResponseRecorder {
		t.Helper()
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/v1/embeddings",
			strings.NewReader(`{"model":"`+env.Slug+`","input":"hi"}`))
		req.Header.Set("Authorization", "Bearer "+env.Key)
		req.Header.Set("Content-Type", "application/json")
		proxy.ServeMux(tests.NewProxy(t, dsn, up.URL), readyHealth{}).ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
		}
		return rec
	}
	t.Run("identity headers present, cost hidden by default", func(t *testing.T) {
		t.Setenv("ROUTER_COST_HEADERS", "")
		rec := call(t)
		if id := rec.Header().Get("x-fudrouter-request-id"); !strings.HasPrefix(id, "req_") {
			t.Errorf("x-fudrouter-request-id = %q, want a req_ id (PRD §90)", id)
		}
		if m := rec.Header().Get("x-fudrouter-model"); m != env.Slug {
			t.Errorf("x-fudrouter-model = %q, want %q", m, env.Slug)
		}
		if p := rec.Header().Get("x-fudrouter-provider"); p == "" {
			t.Error("x-fudrouter-provider missing (PRD §90)")
		}
		if _, err := strconv.Atoi(rec.Header().Get("x-fudrouter-latency")); err != nil {
			t.Errorf("x-fudrouter-latency = %q, want milliseconds", rec.Header().Get("x-fudrouter-latency"))
		}
		if rec.Header().Get("x-fudrouter-cost-micro") != "" {
			t.Error("cost metadata leaked with the flag off (PRD §90: default off)")
		}
	})
	t.Run("cost metadata behind its flag", func(t *testing.T) {
		t.Setenv("ROUTER_COST_HEADERS", "on")
		rec := call(t)
		if rec.Header().Get("x-fudrouter-cost-micro") == "" {
			t.Error("x-fudrouter-cost-micro missing with ROUTER_COST_HEADERS=on")
		}
	})
}

// §7: "/v1/models/{model} returns the same fields /v1/models returns, for one
// slug" — pinned as FIELD-SET equality between the detail object and its list
// entry, plus the truthful 404 for an unknown or unpublished slug.
func TestModelDetailMatchesListEntry(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := echoUpstream(t)
	env := tests.SeedEnv(t, dsn, up.URL)
	tests.SeedUnpublishedModel(t, dsn, env, env.Slug+"-hidden")
	mux := proxy.ServeMux(tests.NewProxy(t, dsn, up.URL), readyHealth{})
	get := func(path string) (int, []byte) {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil)) // public: no key
		return rec.Code, rec.Body.Bytes()
	}
	code, listBody := get("/v1/models")
	if code != http.StatusOK {
		t.Fatalf("GET /v1/models = %d", code)
	}
	var list struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(listBody, &list); err != nil {
		t.Fatalf("list not JSON: %s", listBody)
	}
	var entry map[string]any
	for _, m := range list.Data {
		if m["id"] == env.Slug {
			entry = m
		}
	}
	if entry == nil {
		t.Fatalf("seeded slug %s missing from the catalogue", env.Slug)
	}
	code, detailBody := get("/v1/models/" + env.Slug)
	if code != http.StatusOK {
		t.Fatalf("GET /v1/models/%s = %d body %s", env.Slug, code, detailBody)
	}
	var detail map[string]any
	if err := json.Unmarshal(detailBody, &detail); err != nil {
		t.Fatalf("detail not JSON: %s", detailBody)
	}
	// The literal P1 contract (spec §6 P1): exactly {id, object, owned_by,
	// context, pricing} — neither more nor less.
	for _, f := range []string{"id", "object", "owned_by", "context", "pricing"} {
		if _, ok := detail[f]; !ok {
			t.Errorf("detail object missing field %q (spec §6 P1 field set)", f)
		}
	}
	if len(detail) != 5 {
		t.Errorf("detail object has %d fields %v, want exactly the 5 P1 fields", len(detail), keysOf(detail))
	}
	if len(detail) != len(entry) {
		t.Errorf("field counts differ: detail %d vs list entry %d — same fields is the contract", len(detail), len(entry))
	}
	for k, v := range entry {
		dv, ok := detail[k]
		if !ok {
			t.Errorf("field %q in the list entry is missing from the detail object", k)
			continue
		}
		if !jsonEqual(dv, v) {
			t.Errorf("field %q differs: detail %v vs list %v", k, dv, v)
		}
	}
	// Unknown AND unpublished answer identically (spec §6 P1): a truthful 404
	// error body, and the public surface is not probed into disclosing which.
	for _, slug := range []string{"no-such-model", env.Slug + "-hidden"} {
		code, body := get("/v1/models/" + slug)
		if code != http.StatusNotFound {
			t.Errorf("GET /v1/models/%s = %d, want 404", slug, code)
			continue
		}
		var e taxError
		if err := json.Unmarshal(body, &e); err != nil || e.Error.Code != "MODEL_NOT_FOUND" {
			t.Errorf("404 for %s is not the taxonomy envelope: %s", slug, body)
		}
	}
}

// keysOf returns a map's keys for failure messages.
func keysOf(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// jsonEqual compares two decoded JSON values structurally (numbers decode as
// float64 on both sides, so == would compare equal-shaped values fine — but
// nested objects need the walk).
func jsonEqual(a, b any) bool {
	ab, err1 := json.Marshal(a)
	bb, err2 := json.Marshal(b)
	return err1 == nil && err2 == nil && string(ab) == string(bb)
}
