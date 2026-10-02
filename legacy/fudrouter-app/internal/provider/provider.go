package provider

import (
	"context"
	"time"
)

// AuthType represents the authentication method for a provider.
type AuthType string

const (
	AuthTypeAPIKey AuthType = "apikey"
	AuthTypeOAuth AuthType = "oauth"
)

// Credentials holds the resolved credentials for a provider connection.
type Credentials struct {
	BaseURL string
	APIKey  string
	// OAuth-specific
	AccessToken  string
	RefreshToken string
	ExpiresAt    time.Time
	// Extra data from connection config
	Data map[string]any
}

// ChatRequest is a normalized request for chat completion.
type ChatRequest struct {
	Model       string
	Messages    []Message
	Stream      bool
	Temperature float64
	MaxTokens   int
	Tools       []Tool
	// Provider-specific metadata
	Metadata map[string]any
}

// Message is a normalized chat message.
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// Tool is a normalized tool definition.
type Tool struct {
	Type   string         `json:"type"`
	Function ToolFunction `json:"function"`
}

// ToolFunction is a normalized tool function.
type ToolFunction struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Parameters  any    `json:"parameters"`
}

// ChatResponse is a normalized chat completion response.
type ChatResponse struct {
	ID      string
	Model   string
	Content string
	Usage   Usage
	// Raw provider response for debugging
	Raw any
}

// Usage holds token usage information.
type Usage struct {
	PromptTokens     int
	CompletionTokens int
	TotalTokens      int
}

// Model represents an available model from a provider.
type Model struct {
	ID          string
	Name        string
	Description string
	ContextWindow int
	MaxOutput   int
	// Capabilities
	SupportsStreaming bool
	SupportsTools     bool
	SupportsVision    bool
}

// Provider is the interface that all AI providers must implement.
type Provider interface {
	// ID returns the unique provider identifier (e.g., "openai", "anthropic").
	ID() string
	// Name returns the human-readable provider name.
	Name() string
	// AuthTypes returns the supported authentication types.
	AuthTypes() []AuthType
	// Chat performs a chat completion request.
	Chat(ctx context.Context, req *ChatRequest, creds *Credentials) (*ChatResponse, error)
	// Models returns the list of available models.
	Models(ctx context.Context, creds *Credentials) ([]Model, error)
	// SupportsStreaming returns true if the provider supports streaming responses.
	SupportsStreaming() bool
	// SupportsTools returns true if the provider supports tool/function calling.
	SupportsTools() bool
	// SupportsVision returns true if the provider supports vision/multimodal.
	SupportsVision() bool
	// HealthCheck performs a health check on the provider.
	HealthCheck(ctx context.Context, creds *Credentials) error
}
