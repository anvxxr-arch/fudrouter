package proxy_test

// The Anthropic Messages surface, end to end through the real route table: an
// Anthropic-shaped request must be admitted, routed, billed and answered like
// any other call, but in the Anthropic wire shape — buffered and streaming —
// and a rejection must arrive in the Anthropic error envelope.
//
// These are the integration half of anthropic_translate_test.go (which pins the
// pure mapping); here the lifecycle, the ledger and the mux are real.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudrouter/apps/router/internal/proxy"
	"github.com/anvxxr-arch/fudrouter/apps/router/tests"
)

// anthropicUpstream serves a fixed buffered [OI] chat completion.
func anthropicUpstream(t *testing.T, body string, gotPath, gotBody *string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if gotPath != nil {
			*gotPath = r.URL.Path
		}
		if gotBody != nil {
			buf := make([]byte, 8192)
			n, _ := r.Body.Read(buf)
			*gotBody = string(buf[:n])
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
}

// anthropicSSEUpstream streams fixed SSE data lines then [DONE].
func anthropicSSEUpstream(t *testing.T, chunks []string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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

type anthropicError struct {
	Type  string `json:"type"`
	Error struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}

func TestAnthropicMessagesNonStream(t *testing.T) {
	dsn := tests.RequireDB(t)
	var gotPath, gotBody string
	up := anthropicUpstream(t, `{
		"id":"chatcmpl-7",
		"choices":[{"message":{"role":"assistant","content":"hi from upstream"},"finish_reason":"stop"}],
		"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}
	}`, &gotPath, &gotBody)
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL)
	mux := proxy.ServeMux(tests.NewProxy(t, dsn, up.URL), readyHealth{})

	body := `{"model":"` + env.Slug + `","max_tokens":64,"system":"be brief","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body %s", rec.Code, rec.Body.String())
	}
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("response is not JSON: %v (%s)", err, rec.Body.String())
	}
	if m["type"] != "message" || m["role"] != "assistant" {
		t.Errorf("envelope = %v, want type:message role:assistant", m)
	}
	if m["model"] != env.Slug {
		t.Errorf("model = %v, want %q", m["model"], env.Slug)
	}
	if m["stop_reason"] != "end_turn" {
		t.Errorf("stop_reason = %v, want end_turn", m["stop_reason"])
	}
	blocks := m["content"].([]any)
	if blocks[0].(map[string]any)["text"] != "hi from upstream" {
		t.Errorf("content = %v", blocks)
	}
	u := m["usage"].(map[string]any)
	if u["input_tokens"].(float64) != 12 || u["output_tokens"].(float64) != 4 {
		t.Errorf("usage = %v, want in:12 out:4", u)
	}
	if !strings.HasPrefix(m["id"].(string), "msg_") {
		t.Errorf("id = %v, want msg_ prefix", m["id"])
	}
	// The identity headers are stamped exactly as on the native path.
	if rec.Header().Get("x-fudrouter-request-id") == "" {
		t.Error("x-fudrouter-request-id header missing")
	}
	// The upstream must have received the TRANSLATED [OI] body: the system
	// prompt becomes a system message, not an Anthropic `system` field.
	if gotPath != "/chat/completions" {
		t.Errorf("upstream path = %q, want /chat/completions", gotPath)
	}
	if !strings.Contains(gotBody, `"role":"system"`) || !strings.Contains(gotBody, `"be brief"`) {
		t.Errorf("upstream body missing the translated system message: %s", gotBody)
	}

	// The call is a real ledger row with the exact tokens.
	log := tests.LastRequestLog(t, dsn, env.APIKeyID)
	if log.TokensIn != 12 || log.TokensOut != 4 {
		t.Errorf("ledger tokens = %d/%d, want 12/4", log.TokensIn, log.TokensOut)
	}
	if log.Status != "success" {
		t.Errorf("ledger status = %q, want success", log.Status)
	}
}

func TestAnthropicMessagesStream(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := anthropicSSEUpstream(t, []string{
		`{"id":"c1","choices":[{"delta":{"content":"Hel"}}]}`,
		`{"id":"c1","choices":[{"delta":{"content":"lo"}}]}`,
		`{"id":"c1","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":5,"total_tokens":14}}`,
	})
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL)
	mux := proxy.ServeMux(tests.NewProxy(t, dsn, up.URL), readyHealth{})

	body := `{"model":"` + env.Slug + `","max_tokens":32,"stream":true,"messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body %s", rec.Code, rec.Body.String())
	}
	out := rec.Body.String()
	for _, want := range []string{
		"event: message_start",
		"event: content_block_start",
		"event: content_block_delta",
		`"type":"text_delta"`,
		`"text":"Hel"`,
		`"text":"lo"`,
		"event: content_block_stop",
		"event: message_delta",
		`"stop_reason":"end_turn"`,
		"event: message_stop",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("stream missing %q\n--- got ---\n%s", want, out)
		}
	}
	// The usage block rides the message_delta, as Anthropic clients expect.
	if !strings.Contains(out, `"input_tokens":9`) || !strings.Contains(out, `"output_tokens":5`) {
		t.Errorf("stream usage missing from message_delta:\n%s", out)
	}
	// The [OI] [DONE] sentinel must NOT leak into the Anthropic stream.
	if strings.Contains(out, "[DONE]") {
		t.Error("[DONE] leaked into the Anthropic stream")
	}

	log := tests.LastRequestLog(t, dsn, env.APIKeyID)
	if log.TokensIn != 9 || log.TokensOut != 5 {
		t.Errorf("ledger tokens = %d/%d, want 9/5", log.TokensIn, log.TokensOut)
	}
	if log.Status != "success" {
		t.Errorf("ledger status = %q, want success", log.Status)
	}
}

func TestAnthropicMessagesToolUse(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := anthropicUpstream(t, `{
		"id":"c2",
		"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[
			{"id":"call_9","type":"function","function":{"name":"weather","arguments":"{\"city\":\"jakarta\"}"}}
		]},"finish_reason":"tool_calls"}],
		"usage":{"prompt_tokens":20,"completion_tokens":8}
	}`, nil, nil)
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL)
	mux := proxy.ServeMux(tests.NewProxy(t, dsn, up.URL), readyHealth{})

	body := `{"model":"` + env.Slug + `","max_tokens":32,"messages":[{"role":"user","content":"weather?"}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body %s", rec.Code, rec.Body.String())
	}
	var m map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &m)
	if m["stop_reason"] != "tool_use" {
		t.Errorf("stop_reason = %v, want tool_use", m["stop_reason"])
	}
	blocks := m["content"].([]any)
	found := false
	for _, b := range blocks {
		blk := b.(map[string]any)
		if blk["type"] == "tool_use" && blk["name"] == "weather" {
			found = true
			if blk["input"].(map[string]any)["city"] != "jakarta" {
				t.Errorf("tool input = %v", blk["input"])
			}
		}
	}
	if !found {
		t.Errorf("no tool_use block in %v", blocks)
	}
}

func TestAnthropicCountTokens(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1") // never dialed
	mux := proxy.ServeMux(tests.NewProxy(t, dsn, "http://127.0.0.1:1"), readyHealth{})

	body := `{"model":"` + env.Slug + `","messages":[{"role":"user","content":"aaaa bbbb cccc dddd"}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/messages/count_tokens", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body %s", rec.Code, rec.Body.String())
	}
	var out struct {
		InputTokens int64 `json:"input_tokens"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("not JSON: %v (%s)", err, rec.Body.String())
	}
	if out.InputTokens <= 0 {
		t.Errorf("input_tokens = %d, want a positive estimate", out.InputTokens)
	}
}

func TestAnthropicAuthRejectionUsesAnthropicEnvelope(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	mux := proxy.ServeMux(tests.NewProxy(t, dsn, "http://127.0.0.1:1"), readyHealth{})

	body := `{"model":"` + env.Slug + `","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer sk-ar-totally-invalid")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body %s", rec.Code, rec.Body.String())
	}
	var e anthropicError
	if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil {
		t.Fatalf("rejection is not JSON: %v (%s)", err, rec.Body.String())
	}
	if e.Type != "error" {
		t.Errorf("envelope type = %q, want error", e.Type)
	}
	if e.Error.Type != "authentication_error" {
		t.Errorf("error.type = %q, want authentication_error", e.Error.Type)
	}
	if e.Error.Message == "" {
		t.Error("error.message is empty")
	}
}

func TestAnthropicUnknownModelUsesAnthropicEnvelope(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	mux := proxy.ServeMux(tests.NewProxy(t, dsn, "http://127.0.0.1:1"), readyHealth{})

	body := `{"model":"no-such-model","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body %s", rec.Code, rec.Body.String())
	}
	var e anthropicError
	if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil {
		t.Fatalf("rejection is not JSON: %v (%s)", err, rec.Body.String())
	}
	if e.Error.Type != "not_found_error" {
		t.Errorf("error.type = %q, want not_found_error", e.Error.Type)
	}
}

// TestAnthropicRouteNotSwallowedByGeneric pins the route registration: /v1/messages
// must hit ServeMessages, not the /v1/ catch-all (which would forward the
// Anthropic body to the upstream verbatim and return the wrong shape).
func TestAnthropicRouteNotSwallowedByGeneric(t *testing.T) {
	dsn := tests.RequireDB(t)
	var gotPath string
	up := anthropicUpstream(t, `{"choices":[{"message":{"content":"x"},"finish_reason":"stop"}]}`, &gotPath, nil)
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL)
	mux := proxy.ServeMux(tests.NewProxy(t, dsn, up.URL), readyHealth{})

	body := `{"model":"` + env.Slug + `","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body %s", rec.Code, rec.Body.String())
	}
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("not JSON: %v", err)
	}
	if m["type"] != "message" {
		t.Errorf("response is not an Anthropic Message (type=%v) — the route was swallowed by the generic catch-all", m["type"])
	}
}
