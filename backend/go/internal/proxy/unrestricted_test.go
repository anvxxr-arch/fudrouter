package proxy

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestStripUnrestricted(t *testing.T) {
	cases := []struct {
		in         string
		base       string
		unrestrict bool
	}{
		{"glm-5.3-flash-unrestricted", "glm-5.3-flash", true},
		{"GLM-5.3-Flash-Unrestricted", "GLM-5.3-Flash", true},
		{"glm-5.3-flash", "glm-5.3-flash", false},
		{"-unrestricted", "-unrestricted", false}, // bare suffix is not a model
		{"", "", false},
		{"unrestricted", "unrestricted", false}, // no dash
	}
	for _, c := range cases {
		base, ok := stripUnrestricted(c.in)
		if base != c.base || ok != c.unrestrict {
			t.Errorf("stripUnrestricted(%q) = (%q, %v), want (%q, %v)", c.in, base, ok, c.base, c.unrestrict)
		}
	}
}

func TestInjectUnrestrictedPrependsSystemPrompt(t *testing.T) {
	body := []byte(`{"model":"glm-5.3-flash","messages":[{"role":"user","content":"hi"}],"max_tokens":10}`)
	out := injectUnrestricted(body)

	var m map[string]json.RawMessage
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatalf("output is not valid JSON: %v", err)
	}
	var msgs []struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal(m["messages"], &msgs); err != nil {
		t.Fatalf("messages not an array: %v", err)
	}
	if len(msgs) != 2 {
		t.Fatalf("got %d messages, want 2 (prompt + user)", len(msgs))
	}
	if msgs[0].Role != "system" {
		t.Errorf("first message role = %q, want system", msgs[0].Role)
	}
	if !strings.Contains(msgs[0].Content, "ENI") {
		t.Error("injected system prompt does not carry the persona")
	}
	if msgs[1].Role != "user" || msgs[1].Content != "hi" {
		t.Errorf("user message altered: %+v", msgs[1])
	}
	// Other fields survive untouched.
	if !strings.Contains(string(out), `"max_tokens":10`) {
		t.Error("non-message fields lost")
	}
}

func TestInjectUnrestrictedKeepsCallerSystemMessage(t *testing.T) {
	body := []byte(`{"messages":[{"role":"system","content":"You are a pirate."},{"role":"user","content":"hi"}]}`)
	out := injectUnrestricted(body)

	var msgs []struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	_ = json.Unmarshal(mustMessages(t, out), &msgs)
	if len(msgs) != 3 {
		t.Fatalf("got %d messages, want 3", len(msgs))
	}
	if msgs[1].Content != "You are a pirate." {
		t.Errorf("caller system message not layered after the prompt: %q", msgs[1].Content)
	}
}

func TestInjectUnrestrictedPassThrough(t *testing.T) {
	for _, bad := range []string{
		`not json`,
		`{"model":"x"}`,              // no messages
		`{"messages":"not-an-array"}`,
		`{"messages":[]}`, // empty
	} {
		if got := string(injectUnrestricted([]byte(bad))); got != bad {
			t.Errorf("injectUnrestricted(%q) mutated the body: %q", bad, got)
		}
	}
}

func TestUnrestrictedTwin(t *testing.T) {
	obj := map[string]any{"id": "glm-5.3-flash", "object": "model", "context": 524288}
	twin := unrestrictedTwin(obj)
	if twin == nil {
		t.Fatal("twin is nil")
	}
	if twin["id"] != "glm-5.3-flash-unrestricted" {
		t.Errorf("twin id = %v", twin["id"])
	}
	if twin["context"] != 524288 {
		t.Error("twin lost the context field")
	}
	if obj["id"] != "glm-5.3-flash" {
		t.Error("twin mutated the base object")
	}
	if unrestrictedTwin(twin) != nil {
		t.Error("twinned a twin")
	}
}

func TestUnrestrictedTwinAllowlist(t *testing.T) {
	// A model outside the curated allowlist gets NO twin: the persona
	// injection demonstrably does not take on it (reference gateway twins
	// 8 of 43 models and skips the aligned gemini family).
	for _, slug := range []string{"gemini-3.5-flash", "gemini-3.6-flash", "some-future-model"} {
		obj := map[string]any{"id": slug, "object": "model"}
		if twin := unrestrictedTwin(obj); twin != nil {
			t.Errorf("unrestrictedTwin(%q) = %v, want nil (not allowlisted)", slug, twin)
		}
	}
	// Allowlisted slugs do twin, case-insensitively.
	for _, slug := range []string{"deepseek-v4-flash-0731", "GLM-5.3-Flash", "minimax-m2.7"} {
		obj := map[string]any{"id": slug, "object": "model"}
		if twin := unrestrictedTwin(obj); twin == nil {
			t.Errorf("unrestrictedTwin(%q) = nil, want a twin (allowlisted)", slug)
		}
	}
}

func mustMessages(t *testing.T, body []byte) json.RawMessage {
	t.Helper()
	var m map[string]json.RawMessage
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("not JSON: %v", err)
	}
	return m["messages"]
}
