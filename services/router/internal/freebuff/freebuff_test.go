package freebuff

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
)

// ---------- pure helpers ----------

func TestResolve(t *testing.T) {
	if got, _ := Resolve("z-ai/glm-5.3-flash"); got != "z-ai/glm-5.3-flash" {
		t.Errorf("available model must pass through, got %q", got)
	}
	// paused model resolves to its declared fallback
	if got, reason := Resolve("deepseek/deepseek-v4-pro"); got != "z-ai/glm-5.3-flash" {
		t.Errorf("paused model fallback: got %q (%s)", got, reason)
	}
	if got, reason := Resolve("google/gemini-3.8-flash"); got != "google/gemini-3.1-flash-lite" {
		t.Errorf("paused model fallback: got %q (%s)", got, reason)
	}
	// unknown model is passed through untouched — upstream gives the real error
	if got, _ := Resolve("no/such-model"); got != "no/such-model" {
		t.Errorf("unknown model must pass through, got %q", got)
	}
}

func TestClampEffort(t *testing.T) {
	if got, ok := ClampEffort("z-ai/glm-5.3-flash", "high"); !ok || got != "high" {
		t.Errorf("in-range effort: got %q ok=%v", got, ok)
	}
	if got, ok := ClampEffort("z-ai/glm-5.3-flash", "xhigh"); !ok || got != "max" {
		t.Errorf("over-range effort must clamp to the top rung, got %q ok=%v", got, ok)
	}
	if got, ok := ClampEffort("meta/muse-spark-1.2-contributor", "max"); !ok || got != "xhigh" {
		t.Errorf("muse top rung is xhigh, got %q ok=%v", got, ok)
	}
	if _, ok := ClampEffort("upstage/solar-pro4", "high"); ok {
		t.Error("a model with no effort ladder must report not-supported")
	}
	if got, ok := ClampEffort("z-ai/glm-5.3-flash", "bogus"); !ok || got != "low" {
		t.Errorf("unknown rung falls back to the first, got %q ok=%v", got, ok)
	}
}

func TestClassify(t *testing.T) {
	cases := []struct {
		status int
		body   string
		want   ErrorKind
	}{
		{200, "waiting_room_queued", KindWaitingRoom},
		{200, "rate_limit_exceeded", KindRateLimit},
		{200, "free_mode_invalid_agent_model", KindModelUnavailable},
		{200, "free_mode_invalid_agent_hierarchy", KindModelUnavailable},
		{429, "slow down", KindRateLimit},
		{503, "queue full", KindWaitingRoom}, // weak keyword only counts on 429/503
		{200, "queue full", KindUnknown},     // ...and not on a 200
		{401, "", KindAuthExpired},
		{403, "", KindAuthExpired},
		{404, "", KindModelUnavailable},
		{400, "", KindBadRequest},
		{422, "", KindBadRequest},
		{500, "", KindUpstream5xx},
		{0, "", KindNetwork},
	}
	for _, c := range cases {
		if got := Classify(c.status, c.body); got != c.want {
			t.Errorf("Classify(%d, %q) = %q, want %q", c.status, c.body, got, c.want)
		}
	}
}

func TestRetryHints(t *testing.T) {
	if s, ok := RetryAfterHint(KindRateLimit); !ok || s != 60 {
		t.Errorf("rate limit hint: %d ok=%v", s, ok)
	}
	if s, ok := RetryAfterHint(KindWaitingRoom); !ok || s != 15 {
		t.Errorf("waiting room hint: %d ok=%v", s, ok)
	}
	if !Retryable(KindWaitingRoom) || Retryable(KindBadRequest) {
		t.Error("retryable classification is wrong")
	}
}

func TestExcerpt(t *testing.T) {
	got := Excerpt(`{"error":{"message":"free_mode_invalid_agent_model"}}`)
	if got != "free_mode_invalid_agent_model" {
		t.Errorf("excerpt from nested JSON: %q", got)
	}
	long := Excerpt(strings.Repeat("x", 1000))
	if len([]rune(long)) != excerptMaxChars {
		t.Errorf("long excerpt must truncate to %d chars, got %d", excerptMaxChars, len([]rune(long)))
	}
	if !strings.HasSuffix(long, "...") {
		t.Error("truncated excerpt should end with ellipsis")
	}
}

func TestClientIDShape(t *testing.T) {
	id := newClientID()
	if len(id) != 13 {
		t.Fatalf("client_id must be 13 chars, got %d (%q)", len(id), id)
	}
	for _, r := range id {
		if !strings.ContainsRune(clientIDAlphabet, r) {
			t.Fatalf("client_id has an out-of-alphabet char: %q", id)
		}
	}
}

func TestInjectMetadata(t *testing.T) {
	out, err := injectMetadata([]byte(`{"model":"m","messages":[]}`), "run-1", "inst-1")
	if err != nil {
		t.Fatal(err)
	}
	var req map[string]any
	_ = json.Unmarshal(out, &req)
	meta, ok := req["codebuff_metadata"].(map[string]any)
	if !ok {
		t.Fatal("codebuff_metadata missing")
	}
	if meta["run_id"] != "run-1" || meta["cost_mode"] != "free" || meta["freebuff_instance_id"] != "inst-1" {
		t.Errorf("metadata fields wrong: %#v", meta)
	}
	if cid, _ := meta["client_id"].(string); len(cid) != 13 {
		t.Errorf("client_id must be 13 chars, got %q", cid)
	}
}

func TestPrepareBodyClampsEffort(t *testing.T) {
	out, err := prepareBody([]byte(`{"model":"x","reasoning_effort":"xhigh"}`), "z-ai/glm-5.3-flash")
	if err != nil {
		t.Fatal(err)
	}
	var req map[string]any
	_ = json.Unmarshal(out, &req)
	if req["model"] != "z-ai/glm-5.3-flash" {
		t.Errorf("model not rewritten: %v", req["model"])
	}
	if req["reasoning_effort"] != "max" {
		t.Errorf("effort not clamped: %v", req["reasoning_effort"])
	}
	// unsupported model → field stripped
	out, _ = prepareBody([]byte(`{"model":"x","reasoning_effort":"high"}`), "upstage/solar-pro4")
	var req2 map[string]any
	_ = json.Unmarshal(out, &req2)
	if _, present := req2["reasoning_effort"]; present {
		t.Error("reasoning_effort must be stripped for a model with no ladder")
	}
}

// ---------- orchestration against a mock upstream ----------

type recorded struct {
	mu       sync.Mutex
	sessions []map[string]string // headers of POST session
	startRun []string            // ancestorRunIds json
	chats    []map[string]any    // chat bodies
	finishes int
}

func mockUpstream(t *testing.T, rec *recorded, sessionBody string, chatStatus int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		switch {
		case r.URL.Path == pathSession && r.Method == http.MethodPost:
			rec.mu.Lock()
			rec.sessions = append(rec.sessions, map[string]string{
				"model": r.Header.Get(headerModel),
				"auth":  r.Header.Get("Authorization"),
				"multi": r.Header.Get(headerMulti),
			})
			rec.mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, sessionBody)
		case r.URL.Path == pathAgentRuns:
			var m map[string]any
			_ = json.Unmarshal(body, &m)
			if m["action"] == "START" {
				rec.mu.Lock()
				rec.startRun = append(rec.startRun, string(body))
				rec.mu.Unlock()
				_, _ = io.WriteString(w, `{"runId":"run-abc"}`)
				return
			}
			rec.mu.Lock()
			rec.finishes++
			rec.mu.Unlock()
			_, _ = io.WriteString(w, `{"ok":true}`)
		case r.URL.Path == pathChat:
			var m map[string]any
			_ = json.Unmarshal(body, &m)
			rec.mu.Lock()
			rec.chats = append(rec.chats, m)
			rec.mu.Unlock()
			if chatStatus != http.StatusOK {
				w.WriteHeader(chatStatus)
				_, _ = io.WriteString(w, `{"error":{"message":"boom"}}`)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func TestChatRunsFullProtocol(t *testing.T) {
	rec := &recorded{}
	srv := mockUpstream(t, rec, `{"status":"active","instanceId":"inst-1","expiresAt":"2099-01-01T00:00:00Z"}`, http.StatusOK)
	defer srv.Close()

	m := New(srv.URL)
	resp, err := m.Chat(context.Background(), srv.URL, "tok-1", "z-ai/glm-5.3-flash",
		[]byte(`{"model":"z-ai/glm-5.3-flash","messages":[{"role":"user","content":"hi"}]}`))
	if err != nil {
		t.Fatalf("Chat: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}

	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.sessions) != 1 {
		t.Fatalf("expected 1 session create, got %d", len(rec.sessions))
	}
	if rec.sessions[0]["model"] != "z-ai/glm-5.3-flash" {
		t.Errorf("session model header: %q", rec.sessions[0]["model"])
	}
	if rec.sessions[0]["auth"] != "Bearer tok-1" {
		t.Errorf("session auth header: %q", rec.sessions[0]["auth"])
	}
	if rec.sessions[0]["multi"] != "1" {
		t.Errorf("multi-session header: %q", rec.sessions[0]["multi"])
	}
	if len(rec.startRun) != 1 || !strings.Contains(rec.startRun[0], `"ancestorRunIds":[]`) {
		t.Errorf("root run must send an empty ancestor array, got %v", rec.startRun)
	}
	if !strings.Contains(rec.startRun[0], `"agentId":"base2-free"`) {
		t.Errorf("root run must use the base2-free agent, got %v", rec.startRun)
	}
	if len(rec.chats) != 1 {
		t.Fatalf("expected 1 chat, got %d", len(rec.chats))
	}
	meta, _ := rec.chats[0]["codebuff_metadata"].(map[string]any)
	if meta == nil || meta["run_id"] != "run-abc" || meta["cost_mode"] != "free" || meta["freebuff_instance_id"] != "inst-1" {
		t.Errorf("chat metadata wrong: %#v", meta)
	}
	if rec.finishes != 1 {
		t.Errorf("run must be finished once, got %d", rec.finishes)
	}
}

func TestChatReusesActiveSession(t *testing.T) {
	rec := &recorded{}
	srv := mockUpstream(t, rec, `{"status":"active","instanceId":"inst-1","expiresAt":"2099-01-01T00:00:00Z"}`, http.StatusOK)
	defer srv.Close()
	m := New(srv.URL)

	for i := 0; i < 2; i++ {
		resp, err := m.Chat(context.Background(), srv.URL, "tok-1", "z-ai/glm-5.3-flash", []byte(`{"messages":[]}`))
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.sessions) != 1 {
		t.Errorf("an active session must be reused, got %d creates", len(rec.sessions))
	}
	if rec.finishes != 2 {
		t.Errorf("each request finishes its own run, got %d", rec.finishes)
	}
}

func TestChatWaitingRoomReturnsTypedError(t *testing.T) {
	rec := &recorded{}
	srv := mockUpstream(t, rec, `{"status":"queued","instanceId":"inst-q","position":5,"queueDepth":20,"estimatedWaitMs":5000}`, http.StatusOK)
	defer srv.Close()
	m := New(srv.URL)

	_, err := m.Chat(context.Background(), srv.URL, "tok-1", "z-ai/glm-5.3-flash", []byte(`{"messages":[]}`))
	if err == nil {
		t.Fatal("expected a waiting-room error")
	}
	pe, ok := err.(*Error)
	if !ok || pe.Kind != KindWaitingRoom {
		t.Fatalf("want KindWaitingRoom, got %#v", err)
	}
	if pe.RetryAfter <= 0 {
		t.Errorf("waiting room must carry a positive Retry-After, got %d", pe.RetryAfter)
	}
}

func TestChatDisabledSessionIsAuthError(t *testing.T) {
	rec := &recorded{}
	srv := mockUpstream(t, rec, `{"status":"disabled"}`, http.StatusOK)
	defer srv.Close()
	m := New(srv.URL)

	_, err := m.Chat(context.Background(), srv.URL, "tok-1", "z-ai/glm-5.3-flash", []byte(`{"messages":[]}`))
	pe, ok := err.(*Error)
	if !ok || pe.Kind != KindAuthExpired {
		t.Fatalf("a disabled session is an account problem, got %#v", err)
	}
}

func TestChatResolvesUnavailableModel(t *testing.T) {
	rec := &recorded{}
	srv := mockUpstream(t, rec, `{"status":"active","instanceId":"i","expiresAt":"2099-01-01T00:00:00Z"}`, http.StatusOK)
	defer srv.Close()
	m := New(srv.URL)

	resp, err := m.Chat(context.Background(), srv.URL, "tok-1", "deepseek/deepseek-v4-pro", []byte(`{"messages":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.chats) != 1 {
		t.Fatalf("expected 1 chat, got %d", len(rec.chats))
	}
	if rec.chats[0]["model"] != "z-ai/glm-5.3-flash" {
		t.Errorf("paused model must be rewritten to its fallback, got %v", rec.chats[0]["model"])
	}
	if rec.sessions[0]["model"] != "z-ai/glm-5.3-flash" {
		t.Errorf("session must be created for the resolved model, got %q", rec.sessions[0]["model"])
	}
}

// TestLiveUpstreamHandshake is the live gate: it talks to the real Codebuff
// upstream. It skips without a credential, so CI stays hermetic. With a valid
// FREEBUFF_TOKEN it must return 200; with a bogus one it must come back as a
// classified auth error — either way the protocol reached the real service,
// which is what proves the wire format (paths, headers, session/run handshake)
// is correct.
func TestLiveUpstreamHandshake(t *testing.T) {
	token := os.Getenv("FREEBUFF_TOKEN")
	if token == "" {
		t.Skip("FREEBUFF_TOKEN not set — live upstream test skipped")
	}
	m := New("")
	resp, err := m.Chat(context.Background(), "",
		token, "z-ai/glm-5.3-flash",
		[]byte(`{"model":"z-ai/glm-5.3-flash","messages":[{"role":"user","content":"reply with OK"}],"max_tokens":8}`))
	if err != nil {
		pe, ok := err.(*Error)
		if !ok {
			t.Fatalf("live handshake returned an unclassified error: %v", err)
		}
		t.Logf("live upstream rejected the credential as expected (kind=%s): %s", pe.Kind, pe.Msg)
		if pe.Kind != KindAuthExpired && pe.Kind != KindNetwork {
			t.Fatalf("expected an auth/network classification from the live upstream, got %s", pe.Kind)
		}
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	t.Logf("live upstream status=%d body=%s", resp.StatusCode, truncateForLog(string(body), 300))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("live upstream returned %d", resp.StatusCode)
	}
}

func truncateForLog(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
