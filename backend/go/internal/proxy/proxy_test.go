package proxy_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

func newUpstream(t *testing.T, chunks []string, gotAuth *string, gotBody *string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*gotAuth = r.Header.Get("Authorization")
		buf := make([]byte, 4096)
		n, _ := r.Body.Read(buf)
		*gotBody = string(buf[:n])
		w.Header().Set("Content-Type", "text/event-stream")
		fl := w.(http.Flusher)
		for _, c := range chunks {
			fmt.Fprintf(w, "data: %s\n\n", c)
			fl.Flush()
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
		fl.Flush()
	}))
}

func TestCompletionsStreamsAndLogs(t *testing.T) {
	dsn := tests.RequireDB(t)
	var gotAuth, gotBody string
	up := newUpstream(t, []string{
		`{"id":"c1","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hel"}}]}`,
		`{"id":"c1","object":"chat.completion.chunk","choices":[{"delta":{"content":"lo"}}]}`,
		`{"id":"c1","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}`,
	}, &gotAuth, &gotBody)
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL)
	p := tests.NewProxy(t, dsn, up.URL)

	rec := httptest.NewRecorder()
	body := `{"model":"` + env.Slug + `","stream":true,"messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeCompletions(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	out := rec.Body.String()
	if !strings.Contains(out, `"Hel"`) || !strings.Contains(out, `"lo"`) {
		t.Error("SSE chunks missing/corrupted")
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "data: [DONE]") {
		t.Error("D terminator not forwarded")
	}
	if gotAuth != "Bearer "+env.UpstreamKey {
		t.Errorf("upstream auth = %q", gotAuth)
	}
	if !strings.Contains(gotBody, `"stream_options":{"include_usage":true}`) {
		t.Error("stream_options not injected")
	}

	// request_log row must exist with exact tokens and cost
	log := tests.LastRequestLog(t, dsn, env.APIKeyID)
	if log.TokensIn != 11 || log.TokensOut != 7 {
		t.Errorf("tokens %d/%d", log.TokensIn, log.TokensOut)
	}
	// 11*150000/1e6 + 7*600000/1e6 = 1.65 + 4.2 = 5.85 -> 6 micro (half-up)
	if log.Cost != 6 {
		t.Errorf("cost %d, want 6", log.Cost)
	}
	if log.Status != "success" {
		t.Errorf("status %q", log.Status)
	}
}

// A client-supplied `stream_options` must be MERGED, not replaced, when the
// router injects `include_usage`. The contract (packages/contracts/openapi/
// inference.yaml:370-374) declares `stream_options` with
// `additionalProperties: true` and describes the body as "forwarded to the
// upstream provider essentially verbatim" with exactly ONE transformation —
// the include_usage injection (inference.yaml:126-137). The three OpenAI-shaped
// injection sites (proxy.go:296-308, generic.go:93-108, generic.go:118-141)
// used to overwrite the whole object, silently dropping every client field.
//
// The bug this prevents: a client that sends
// `stream_options: {"include_usage": false, "extra_field": "keepme"}` (or any
// provider-specific option) has its options silently discarded upstream. The
// request still succeeds and still bills, so nothing observable breaks — the
// loss is invisible until a client depends on a field the router ate.
//
// The assertion is on the UPSTREAM body, not the client response: the merge
// must survive the marshal that reaches the provider. `include_usage` is
// forced true even when the client asked for false, because billing depends
// on the usage block (PRD §87) — that part is deliberate, not a regression.
//
// Verified by mutation: reverting any one injection site to
// `req["stream_options"] = map[string]any{"include_usage": true}` drops
// extra_field and turns this test red.
func TestStreamOptionsMergedNotOverwritten(t *testing.T) {
	dsn := tests.RequireDB(t)
	var gotAuth, gotBody string
	up := newUpstream(t, []string{
		`{"id":"c1","object":"chat.completion.chunk","choices":[{"delta":{"content":"hi"}}]}`,
		`{"id":"c1","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}`,
	}, &gotAuth, &gotBody)
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL)
	p := tests.NewProxy(t, dsn, up.URL)

	rec := httptest.NewRecorder()
	body := `{"model":"` + env.Slug + `","stream":true,` +
		`"stream_options":{"include_usage":false,"extra_field":"keepme"},` +
		`"messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeCompletions(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}

	// The injection must land: include_usage forced true for billing.
	if !strings.Contains(gotBody, `"include_usage":true`) {
		t.Errorf("include_usage not injected upstream: %s", gotBody)
	}
	// The client's own field must survive the merge.
	if !strings.Contains(gotBody, `"extra_field":"keepme"`) {
		t.Errorf("client stream_options field dropped by overwrite: %s", gotBody)
	}
	// The client's explicit false must be overridden, not preserved.
	if strings.Contains(gotBody, `"include_usage":false`) {
		t.Errorf("client include_usage:false survived; billing needs it true: %s", gotBody)
	}
}

func TestRevokedKeyRejected(t *testing.T) {
	dsn := tests.RequireDB(t)
	var a, b string
	up := newUpstream(t, []string{`{}`}, &a, &b)
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL)
	tests.RevokeKey(t, dsn, env.APIKeyID)
	p := tests.NewProxy(t, dsn, up.URL)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"`+env.Slug+`","messages":[]}`))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeCompletions(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("revoked key: status %d, want 401", rec.Code)
	}
}

func TestBadKeyRejectedWithoutDBHit(t *testing.T) {
	dsn := tests.RequireDB(t)
	var a, b string
	up := newUpstream(t, []string{`{}`}, &a, &b)
	defer up.Close()
	p := tests.NewProxy(t, dsn, up.URL)

	for _, hdr := range []string{"", "Bearer wrong", "Bearer sk-ar-nosuchpr_0123456789abcdef0123456789abcdef"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
			strings.NewReader(`{"model":"x","messages":[]}`))
		if hdr != "" {
			req.Header.Set("Authorization", hdr)
		}
		p.ServeCompletions(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("hdr %q: status %d, want 401", hdr, rec.Code)
		}
	}
}

// A provider whose stored credentials carry default_headers must have them
// forwarded upstream — the xAI Grok CLI proxy rejects completions without
// `x-grok-client-version`, and no amount of valid auth changes that.
func TestDefaultHeadersForwarded(t *testing.T) {
	dsn := tests.RequireDB(t)
	var gotVersion string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotVersion = r.Header.Get("x-grok-client-version")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"usage":{"prompt_tokens":1,"completion_tokens":1}}`))
	}))
	defer up.Close()

	env := tests.SeedEnvWithHeaders(t, dsn, up.URL,
		map[string]string{"x-grok-client-version": "0.1.202", "Authorization": "Bearer should-not-win"})
	p := tests.NewProxy(t, dsn, up.URL)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"`+env.Slug+`","messages":[]}`))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeCompletions(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	if gotVersion != "0.1.202" {
		t.Errorf("default header not forwarded: %q", gotVersion)
	}
	_ = context.Background()
}

// A model that does not exist must 404 without ever reaching an upstream.
func TestUnknownModel404(t *testing.T) {
	dsn := tests.RequireDB(t)
	var a, b string
	up := newUpstream(t, []string{`{}`}, &a, &b)
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL)
	p := tests.NewProxy(t, dsn, up.URL)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"no-such-model","messages":[]}`))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeCompletions(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status %d, want 404", rec.Code)
	}
}
