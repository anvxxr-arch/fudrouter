package proxy_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudrouter/services/router/internal/proxy"
	"github.com/anvxxr-arch/fudrouter/services/router/tests"
)

// A hostile or buggy upstream can report anything in its `usage` block, and the
// router does not count tokens itself — it bills what the upstream claims. A
// NEGATIVE count makes cost negative, which LOWERS the month's total and lets a
// key walk past its monthly_cost_micro cap. The clamp at the single billing
// funnel (proxy.go logRequest) is what defeats that, and until now it had no
// test at all: the one scenario it exists to stop was never exercised.
func TestClampTokensForTestBounds(t *testing.T) {
	cases := []struct {
		name string
		in   int64
		want int64
	}{
		{"negative is floored at zero", -5000, 0},
		{"max negative is floored", -9223372036854775808, 0},
		{"minus one is floored", -1, 0},
		{"zero stays zero", 0, 0},
		{"an ordinary count passes through", 1234, 1234},
		{"an oversized count is capped", 1_000_000_000, proxy.MaxTokensPerRequestForTest()},
		{"the ceiling itself passes", proxy.MaxTokensPerRequestForTest(), proxy.MaxTokensPerRequestForTest()},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := proxy.ClampTokensForTest(c.in); got != c.want {
				t.Errorf("clampTokens(%d) = %d, want %d", c.in, got, c.want)
			}
		})
	}
}

// The same attack through the real handler: an upstream that reports negative
// usage must not lower the month's spend. This is the regression test for the
// cap bypass, asserted on what actually landed in request_log.
func TestNegativeUpstreamUsageDoesNotLowerBilledCost(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// A negative prompt count is the payload: cost.Compute would return a
		// negative micro-cost, and the month's SUM would go DOWN.
		_, _ = w.Write([]byte(`{"id":"c1","object":"chat.completion","choices":[{"message":{"content":"hi"}}],
			"usage":{"prompt_tokens":-9999,"completion_tokens":-5000,"total_tokens":-14999}}`))
	}))
	defer up.Close()
	env := tests.SeedEnv(t, dsn, up.URL)
	p := tests.NewProxy(t, dsn, up.URL)

	rec := httptest.NewRecorder()
	body := `{"model":"` + env.Slug + `","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeCompletions(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}

	tin, tout, cost := proxy.BilledCostForTest(t, dsn, env.APIKeyID)
	if tin < 0 {
		t.Errorf("tokens_in stored as %d: a negative count must be clamped at the funnel", tin)
	}
	if tout < 0 {
		t.Errorf("tokens_out stored as %d: a negative count must be clamped at the funnel", tout)
	}
	if cost < 0 {
		t.Errorf("cost stored as %d: negative cost lowers the month total and walks the key past its cap", cost)
	}
	if tin != 0 || tout != 0 {
		t.Errorf("tokens_in=%d tokens_out=%d, want both 0 (the upstream's numbers are below the floor)", tin, tout)
	}
	if cost != 0 {
		t.Errorf("cost=%d, want 0 — clamped tokens must bill zero, not a negative amount", cost)
	}
}

// The cap's ceiling must survive: an absurdly large reported count is clamped
// rather than trusted, so a single request cannot overspend the cap by a
// magnitude the clamp was meant to exclude, and the big.Int multiply stays exact.
func TestOversizedUpstreamUsageIsCappedNotTrusted(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// 1e12 tokens — beyond any real request, and large enough that
		// tokens*price would overflow int64 without the clamp plus big.Int path.
		_, _ = w.Write([]byte(`{"id":"c1","object":"chat.completion","choices":[{"message":{"content":"hi"}}],
			"usage":{"prompt_tokens":1000000000000,"completion_tokens":1000000000000}}`))
	}))
	defer up.Close()
	env := tests.SeedEnv(t, dsn, up.URL)
	p := tests.NewProxy(t, dsn, up.URL)

	rec := httptest.NewRecorder()
	body := `{"model":"` + env.Slug + `","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeCompletions(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}

	tin, tout, cost := proxy.BilledCostForTest(t, dsn, env.APIKeyID)
	if want := proxy.MaxTokensPerRequestForTest(); tin != want || tout != want {
		t.Errorf("tokens_in=%d tokens_out=%d, want both %d (the ceiling)", tin, tout, want)
	}
	if cost <= 0 {
		t.Errorf("cost=%d, want a positive billed amount at the model's price", cost)
	}
}
