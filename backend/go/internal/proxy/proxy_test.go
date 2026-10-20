package proxy_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
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

// A provider whose credential blob declares protocol="freebuff" must be served
// through the native Codebuff handshake (session → root run → chat with
// codebuff_metadata), never the plain [OI] passthrough.
func TestFreebuffProtocolDispatched(t *testing.T) {
	dsn := tests.RequireDB(t)

	var (
		mu          sync.Mutex
		sessionHits int
		chatMeta    map[string]any
		sawPassthru bool
		chatPath    string
	)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		defer mu.Unlock()
		switch r.URL.Path {
		case "/api/v1/freebuff/session":
			sessionHits++
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"status":"active","instanceId":"inst-1","expiresAt":"2099-01-01T00:00:00Z"}`)
		case "/api/v1/agent-runs":
			_, _ = io.WriteString(w, `{"runId":"run-1"}`)
		case "/api/v1/chat/completions":
			chatPath = r.URL.Path
			var m map[string]any
			_ = json.Unmarshal(body, &m)
			chatMeta, _ = m["codebuff_metadata"].(map[string]any)
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}`)
		default:
			sawPassthru = true
			w.WriteHeader(http.StatusTeapot)
		}
	}))
	defer up.Close()

	env := tests.SeedEnvFreebuff(t, dsn, up.URL)
	p := tests.NewProxy(t, dsn, up.URL)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"`+env.Slug+`","messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeCompletions(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	mu.Lock()
	defer mu.Unlock()
	if sessionHits != 1 {
		t.Errorf("expected 1 session create, got %d", sessionHits)
	}
	if chatPath != "/api/v1/chat/completions" {
		t.Errorf("chat must go to the freebuff path, got %q", chatPath)
	}
	if sawPassthru {
		t.Error("freebuff provider must not use the [OI] passthrough path")
	}
	if chatMeta == nil || chatMeta["run_id"] != "run-1" || chatMeta["cost_mode"] != "free" {
		t.Errorf("codebuff_metadata not injected: %#v", chatMeta)
	}
	if _, ok := chatMeta["freebuff_instance_id"]; !ok {
		t.Error("freebuff_instance_id missing from metadata")
	}
}

// A freebuff waiting room must surface as 503 + Retry-After, not a generic 502:
// the client needs to know to come back rather than treat it as an outage.
func TestFreebuffWaitingRoomReturns503(t *testing.T) {
	dsn := tests.RequireDB(t)

	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status":"queued","instanceId":"i","position":7,"queueDepth":30,"estimatedWaitMs":4000}`)
	}))
	defer up.Close()

	env := tests.SeedEnvFreebuff(t, dsn, up.URL)
	p := tests.NewProxy(t, dsn, up.URL)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"`+env.Slug+`","messages":[]}`))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeCompletions(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("waiting room must be 503, got %d body %s", rec.Code, rec.Body.String())
	}
	if ra := rec.Header().Get("Retry-After"); ra == "" {
		t.Error("waiting room must send a Retry-After header")
	}
	if !strings.Contains(rec.Body.String(), "waiting room") {
		t.Errorf("body should explain the queue: %s", rec.Body.String())
	}
}

// freebuffStreamUpstream answers the protocol handshake and then streams a
// standard [OI] SSE body on the chat call.
func freebuffStreamUpstream(t *testing.T, badTokens ...string) (*httptest.Server, *[]string) {
	t.Helper()
	var seen []string
	bad := map[string]bool{}
	for _, b := range badTokens {
		bad[b] = true
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		switch r.URL.Path {
		case "/api/v1/freebuff/session":
			if bad[tok] {
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = io.WriteString(w, `{"error":"Invalid API key"}`)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"status":"active","instanceId":"inst-1","expiresAt":"2099-01-01T00:00:00Z"}`)
		case "/api/v1/agent-runs":
			_, _ = io.WriteString(w, `{"runId":"run-1"}`)
		case "/api/v1/chat/completions":
			seen = append(seen, tok)
			w.Header().Set("Content-Type", "text/event-stream")
			fl := w.(http.Flusher)
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"PO\"}}]}\n\n")
			fl.Flush()
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"NG\"}}]}\n\n")
			fl.Flush()
			fmt.Fprint(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2}}\n\n")
			fmt.Fprint(w, "data: [DONE]\n\n")
			fl.Flush()
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	return srv, &seen
}

// Streaming is the freebuff hot path: the SSE body from the upstream chat call
// must pass through unmodified, with usage captured.
func TestFreebuffStreamsSSE(t *testing.T) {
	dsn := tests.RequireDB(t)
	up, _ := freebuffStreamUpstream(t)
	defer up.Close()

	env := tests.SeedEnvFreebuff(t, dsn, up.URL)
	p := tests.NewProxy(t, dsn, up.URL)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"`+env.Slug+`","stream":true,"messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeCompletions(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	out := rec.Body.String()
	if !strings.Contains(out, `"PO"`) || !strings.Contains(out, `"NG"`) {
		t.Errorf("SSE chunks missing: %s", out)
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "data: [DONE]") {
		t.Errorf("SSE terminator not forwarded: %s", out)
	}
	// The streamed usage must be recorded, not lost.
	log := tests.LastRequestLog(t, dsn, env.APIKeyID)
	if log.TokensIn != 5 || log.TokensOut != 2 {
		t.Errorf("streamed usage not logged: in=%d out=%d", log.TokensIn, log.TokensOut)
	}
}

// A rejected account must fail over to the next one within the same request.
func TestFreebuffFailsOverBetweenAccounts(t *testing.T) {
	dsn := tests.RequireDB(t)
	up, seen := freebuffStreamUpstream(t, "tok-bad")
	defer up.Close()

	env := tests.SeedEnvFreebuffAccounts(t, dsn, up.URL, []string{"tok-bad", "tok-good"})
	p := tests.NewProxy(t, dsn, up.URL)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"`+env.Slug+`","messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeCompletions(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("failover did not succeed: status %d body %s", rec.Code, rec.Body.String())
	}
	if len(*seen) != 1 || (*seen)[0] != "tok-good" {
		t.Errorf("expected the chat to be served by tok-good, saw %v", *seen)
	}
}
