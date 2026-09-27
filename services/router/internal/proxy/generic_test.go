package proxy_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudrouter/services/router/tests"
)

// jsonUpstream answers every request with a fixed JSON body, status and headers.
func jsonUpstream(t *testing.T, body string, headers map[string]string, status int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for k, v := range headers {
			w.Header().Set(k, v)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
}

// The generic /v1/* passthrough used to write NO request_log row on success, so
// every embeddings/rerank call was unbilled and invisible to usage and limits.
func TestGenericEndpointIsBilled(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := jsonUpstream(t, `{"object":"list","data":[{"embedding":[0.1]}],"usage":{"prompt_tokens":42,"total_tokens":42}}`, nil, 200)
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL)
	p := tests.NewProxy(t, dsn, up.URL)

	before := tests.RequestLogCount(t, dsn, env.APIKeyID)
	rec := httptest.NewRecorder()
	body := `{"model":"` + env.Slug + `","input":"hello"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/embeddings", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeGeneric(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	after := tests.RequestLogCount(t, dsn, env.APIKeyID)
	if after != before+1 {
		t.Fatalf("generic path wrote no request_log row (before=%d after=%d) — the call is unbilled", before, after)
	}
	last := tests.LastRequestLog(t, dsn, env.APIKeyID)
	if last.TokensIn != 42 {
		t.Errorf("tokens_in = %d, want 42", last.TokensIn)
	}
	if last.Status != "success" {
		t.Errorf("status = %q, want success", last.Status)
	}
}

// The generic path copied EVERY upstream response header, leaking the upstream's
// cookies, CDN identity and CORS headers to the client.
func TestGenericStripsUpstreamHeaders(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := jsonUpstream(t, `{"ok":true}`, map[string]string{
		"Set-Cookie":                  "__cf_bm=abc; Domain=openrouter.ai",
		"Server":                      "ESA",
		"Via":                         "ens-cache7",
		"Cf-Ray":                      "abc123-SIN",
		"Access-Control-Allow-Origin": "*",
		"X-Unikey-Request-Id":         "123",
	}, 200)
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL)
	p := tests.NewProxy(t, dsn, up.URL)

	rec := httptest.NewRecorder()
	body := `{"model":"` + env.Slug + `","input":"hi"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/embeddings", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeGeneric(rec, req)

	var leaked []string
	for _, h := range []string{"Set-Cookie", "Server", "Via", "Cf-Ray", "Access-Control-Allow-Origin", "X-Unikey-Request-Id"} {
		if rec.Header().Get(h) != "" {
			leaked = append(leaked, h)
		}
	}
	if len(leaked) > 0 {
		t.Errorf("upstream headers leaked to the client: %v", leaked)
	}
	if rec.Header().Get("Content-Type") != "application/json" {
		t.Errorf("content-type not relayed: %q", rec.Header().Get("Content-Type"))
	}
}

// The generic path picked ONE credential and forwarded it; a dead token in the
// pool reached the client even when healthy accounts remained.
func TestGenericFailsOverOn401(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.Header.Get("Authorization"), "good") {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"bad key"}`))
	}))
	defer up.Close()

	// Round-robin starts at index 0, so the first Pick is the bad token.
	env := tests.SeedEnvAccounts(t, dsn, up.URL, []string{"bad", "good"})
	p := tests.NewProxy(t, dsn, up.URL)

	rec := httptest.NewRecorder()
	body := `{"model":"` + env.Slug + `","input":"hi"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/embeddings", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeGeneric(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s — did not fail over to the healthy account", rec.Code, rec.Body.String())
	}
}

// api_key.limits (rpm) was written by the admin console and never read by the
// data plane, so a key could hammer the shared pool unbounded.
func TestRPMLimitIsEnforced(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := jsonUpstream(t, `{"ok":true}`, nil, 200)
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL)
	tests.SetKeyLimits(t, dsn, env.APIKeyID, `{"rpm":1}`)
	p := tests.NewProxy(t, dsn, up.URL)

	call := func() int {
		rec := httptest.NewRecorder()
		body := `{"model":"` + env.Slug + `","input":"hi"}`
		req := httptest.NewRequest(http.MethodPost, "/v1/embeddings", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+env.Key)
		p.ServeGeneric(rec, req)
		return rec.Code
	}
	if code := call(); code != http.StatusOK {
		t.Fatalf("first request: status %d, want 200", code)
	}
	if code := call(); code != http.StatusTooManyRequests {
		t.Fatalf("second request: status %d, want 429 (rpm=1 not enforced)", code)
	}
}

// A monthly cost cap must reject a key whose month-to-date cost has reached it.
func TestMonthlyCostCapIsEnforced(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := jsonUpstream(t, `{"ok":true}`, nil, 200)
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL)
	// Cap of 1 micro-USD, plus a log row that already costs 2 micro-USD this month.
	tests.SetKeyLimits(t, dsn, env.APIKeyID, `{"monthly_cost_micro":"1"}`)
	tests.InsertRequestLogRow(t, dsn, env, 2)

	p := tests.NewProxy(t, dsn, up.URL)
	rec := httptest.NewRecorder()
	body := `{"model":"` + env.Slug + `","input":"hi"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/embeddings", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeGeneric(rec, req)

	if rec.Code != http.StatusPaymentRequired {
		t.Fatalf("status %d, want 402 (monthly cap not enforced)", rec.Code)
	}
}
