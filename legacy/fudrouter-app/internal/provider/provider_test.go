package provider

import (
	"context"
	"testing"
)

func TestConnectionProvider_ID(t *testing.T) {
	p := NewConnectionProvider("test", "Test Provider", []AuthType{AuthTypeAPIKey})
	if p.ID() != "test" {
		t.Errorf("expected ID 'test', got '%s'", p.ID())
	}
}

func TestConnectionProvider_Name(t *testing.T) {
	p := NewConnectionProvider("test", "Test Provider", []AuthType{AuthTypeAPIKey})
	if p.Name() != "Test Provider" {
		t.Errorf("expected Name 'Test Provider', got '%s'", p.Name())
	}
}

func TestConnectionProvider_AuthTypes(t *testing.T) {
	p := NewConnectionProvider("test", "Test Provider", []AuthType{AuthTypeAPIKey, AuthTypeOAuth})
	types := p.AuthTypes()
	if len(types) != 2 {
		t.Fatalf("expected 2 auth types, got %d", len(types))
	}
	if types[0] != AuthTypeAPIKey {
		t.Errorf("expected first auth type to be 'apikey', got '%s'", types[0])
	}
	if types[1] != AuthTypeOAuth {
		t.Errorf("expected second auth type to be 'oauth', got '%s'", types[1])
	}
}

func TestConnectionProvider_SupportsStreaming(t *testing.T) {
	p := NewConnectionProvider("test", "Test Provider", []AuthType{AuthTypeAPIKey})
	if !p.SupportsStreaming() {
		t.Error("expected SupportsStreaming to return true")
	}
}

func TestConnectionProvider_SupportsTools(t *testing.T) {
	p := NewConnectionProvider("test", "Test Provider", []AuthType{AuthTypeAPIKey})
	if !p.SupportsTools() {
		t.Error("expected SupportsTools to return true")
	}
}

func TestConnectionProvider_SupportsVision(t *testing.T) {
	p := NewConnectionProvider("test", "Test Provider", []AuthType{AuthTypeAPIKey})
	if p.SupportsVision() {
		t.Error("expected SupportsVision to return false")
	}
}

func TestConnectionProvider_Chat_MissingBaseURL(t *testing.T) {
	p := NewConnectionProvider("test", "Test Provider", []AuthType{AuthTypeAPIKey})
	_, err := p.Chat(context.Background(), &ChatRequest{Model: "test-model"}, &Credentials{})
	if err == nil {
		t.Error("expected error for missing BaseURL")
	}
}

func TestConnectionProvider_HealthCheck_MissingBaseURL(t *testing.T) {
	p := NewConnectionProvider("test", "Test Provider", []AuthType{AuthTypeAPIKey})
	err := p.HealthCheck(context.Background(), &Credentials{})
	if err == nil {
		t.Error("expected error for missing BaseURL")
	}
}

func TestRegistry_RegisterAndGet(t *testing.T) {
	p := NewConnectionProvider("test-reg", "Test Registry", []AuthType{AuthTypeAPIKey})
	Register(p)

	got, ok := Get("test-reg")
	if !ok {
		t.Fatal("expected to find provider 'test-reg'")
	}
	if got.ID() != "test-reg" {
		t.Errorf("expected ID 'test-reg', got '%s'", got.ID())
	}

	// Cleanup
	Unregister("test-reg")
}

func TestRegistry_Get_NotFound(t *testing.T) {
	_, ok := Get("nonexistent-provider-xyz")
	if ok {
		t.Error("expected not to find provider 'nonexistent-provider-xyz'")
	}
}

func TestRegistry_List(t *testing.T) {
	p1 := NewConnectionProvider("test-list-1", "Test List 1", []AuthType{AuthTypeAPIKey})
	p2 := NewConnectionProvider("test-list-2", "Test List 2", []AuthType{AuthTypeOAuth})
	Register(p1)
	Register(p2)

	list := List()
	if len(list) < 2 {
		t.Fatalf("expected at least 2 providers, got %d", len(list))
	}

	// Cleanup
	Unregister("test-list-1")
	Unregister("test-list-2")
}

func TestResolveProvider_Unknown(t *testing.T) {
	_, err := ResolveProvider("totally-unknown-provider")
	if err == nil {
		t.Error("expected error for unknown provider")
	}
}

func TestDetectProviderModel(t *testing.T) {
	tests := []struct {
		model    string
		expected string
	}{
		{"openai/gpt-4", "openai"},
		{"anthropic/claude-3", "anthropic"},
		{"google/gemini-pro", "google"},
		{"gpt-4", ""},
		{"", ""},
	}

	for _, tt := range tests {
		got := DetectProviderModel(tt.model)
		if got != tt.expected {
			t.Errorf("DetectProviderModel(%q) = %q, want %q", tt.model, got, tt.expected)
		}
	}
}
