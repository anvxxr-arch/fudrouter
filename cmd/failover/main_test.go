package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestDetectProvider(t *testing.T) {
	cases := map[string]string{
		"openai/gpt-4o":        "openai",
		"anthropic/claude-3":   "anthropic",
		"claude-3-5-sonnet":    "anthropic",
		"gpt-4.1":              "openai",
		"o3-mini":              "openai",
		"gemini-2.0-flash":     "google",
		"deepseek-chat":        "deepseek",
		"qwen2.5-coder":        "qwen",
		"mistral-large":        "mistral",
		"grok-2":               "xai",
		"kimi-k2":              "moonshot",
		"glm-4":                "zhipu",
		"":                     "",
		"unknown-model-xyz":    "",
	}
	for in, want := range cases {
		if got := detectProvider(in); got != want {
			t.Fatalf("detectProvider(%q)=%q want %q", in, got, want)
		}
	}
}

func TestChatCompletionsURL(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"https://api.openai.com", "https://api.openai.com/v1/chat/completions"},
		{"https://api.openai.com/", "https://api.openai.com/v1/chat/completions"},
		{"https://api.openai.com/v1", "https://api.openai.com/v1/v1/chat/completions"},
		{"https://api.openai.com/v1/chat/completions", "https://api.openai.com/v1/chat/completions"},
	}
	for _, c := range cases {
		got, err := chatCompletionsURL(c.in)
		if err != nil {
			t.Fatalf("chatCompletionsURL(%q) err=%v", c.in, err)
		}
		if got != c.want {
			t.Fatalf("chatCompletionsURL(%q)=%q want %q", c.in, got, c.want)
		}
	}
}

func TestTrackerCooldown(t *testing.T) {
	s := &server{
		cfg: config{
			DisableCooldown: 50 * time.Millisecond,
		},
		track: map[string]*tracker{},
	}
	s.markFailed("a", 429, 0)
	if !s.isDisabled("a") {
		t.Fatal("expected disabled after 429")
	}
	time.Sleep(60 * time.Millisecond)
	if s.isDisabled("a") {
		t.Fatal("expected re-enabled after cooldown")
	}
	s.markHealthy("a")
	s.markFailed("b", 401, 0)
	if !s.isDisabled("b") {
		t.Fatal("expected auth disable")
	}
}

func TestRaceFirstWinner(t *testing.T) {
	var slowHits, fastHits atomic.Int32

	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		slowHits.Add(1)
		time.Sleep(200 * time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"slow"}`))
	}))
	defer slow.Close()

	fast := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fastHits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"fast"}`))
	}))
	defer fast.Close()

	fail := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusTooManyRequests)
	}))
	defer fail.Close()

	s := &server{
		cfg: config{
			ConnTimeout: 2 * time.Second,
			RaceTimeout: 2 * time.Second,
			MaxRace:     4,
		},
		client: &http.Client{Timeout: 2 * time.Second},
		track:  map[string]*tracker{},
	}

	conns := []connection{
		{ID: "slow", BaseURL: slow.URL, APIKey: "k1"},
		{ID: "fast", BaseURL: fast.URL, APIKey: "k2"},
		{ID: "fail", BaseURL: fail.URL, APIKey: "k3"},
	}
	body := []byte(`{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`)
	res, err := s.race(context.Background(), conns, body, "test")
	if err != nil {
		t.Fatalf("race err: %v", err)
	}
	defer res.body.Close()
	if res.connID != "fast" {
		t.Fatalf("winner=%s want fast", res.connID)
	}
	b, _ := io.ReadAll(res.body)
	if !strings.Contains(string(b), "fast") {
		t.Fatalf("body=%s", b)
	}
	if fastHits.Load() < 1 {
		t.Fatal("fast not hit")
	}
}

func TestHandleRaceChatPassthroughWhenNoConns(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Fatalf("path=%s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer backend.Close()

	dir := t.TempDir()
	dbPath := filepath.Join(dir, "data.sqlite")
	// empty sqlite with schema
	db, err := openDB(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE providerConnections (
		id TEXT PRIMARY KEY,
		provider TEXT,
		name TEXT,
		priority INTEGER,
		isActive INTEGER,
		data TEXT,
		base_url TEXT,
		api_key TEXT
	)`)
	if err != nil {
		t.Fatal(err)
	}
	_ = db.Close()

	s, err := newServer(config{
		Port:        0,
		Mode:        "race",
		Backend:     backend.URL,
		DBPath:      dbPath,
		ConnTimeout: 2 * time.Second,
		RaceTimeout: 2 * time.Second,
		MaxRace:     4,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()

	body := `{"model":"openai/gpt-4o","messages":[{"role":"user","content":"x"}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	s.handleRaceChat(rr, req)
	if rr.Code != 200 {
		t.Fatalf("code=%d body=%s", rr.Code, rr.Body.String())
	}
	if rr.Header().Get("X-Failover-Mode") != "passthrough-fallback" {
		t.Fatalf("mode header=%s", rr.Header().Get("X-Failover-Mode"))
	}
}

func TestHealthEndpoint(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "data.sqlite")
	db, err := openDB(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = db.Exec(`CREATE TABLE providerConnections (
		id TEXT, provider TEXT, name TEXT, priority INTEGER, isActive INTEGER, data TEXT, base_url TEXT, api_key TEXT
	)`)
	_ = db.Close()

	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	defer backend.Close()

	s, err := newServer(config{
		Mode:    "passthrough",
		Backend: backend.URL,
		DBPath:  dbPath,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()

	ts := httptest.NewServer(s.routes())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/_failover_health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var m map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
		t.Fatal(err)
	}
	if m["runtime"] != "go" || m["status"] != "ok" {
		t.Fatalf("health=%v", m)
	}
}

func TestLoadConfigDefaults(t *testing.T) {
	keys := []string{
		"FAILOVER_PORT", "FAILOVER_MODE", "FAILOVER_BACKEND", "DATA_DIR",
		"FAILOVER_DB_PATH", "FAILOVER_TIMEOUT", "FAILOVER_RACE_TIMEOUT",
		"FAILOVER_COOLDOWN", "FAILOVER_MAX_RACE",
	}
	for _, k := range keys {
		_ = os.Unsetenv(k)
	}
	cfg := loadConfig()
	if cfg.Port != 20126 {
		t.Fatalf("port=%d", cfg.Port)
	}
	if cfg.Mode != "passthrough" {
		t.Fatalf("mode=%s", cfg.Mode)
	}
	if cfg.Backend != "http://127.0.0.1:20128" {
		t.Fatalf("backend=%s", cfg.Backend)
	}
	if cfg.MaxRace != 4 {
		t.Fatalf("maxRace=%d", cfg.MaxRace)
	}
}
