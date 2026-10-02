package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ConnectionProvider implements the Provider interface by routing through
// stored connections (db.Connection). This is the default provider implementation
// that uses the existing connection-based routing logic.
type ConnectionProvider struct {
	id       string
	name     string
	authTypes []AuthType
	client   *http.Client
}

// NewConnectionProvider creates a new ConnectionProvider.
func NewConnectionProvider(id, name string, authTypes []AuthType) *ConnectionProvider {
	return &ConnectionProvider{
		id:        id,
		name:      name,
		authTypes: authTypes,
		client: &http.Client{
			Timeout: 60 * time.Second,
			Transport: &http.Transport{
				Proxy: http.ProxyFromEnvironment,
				DialContext: (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
				MaxIdleConns:        100,
				IdleConnTimeout:     90 * time.Second,
				TLSHandshakeTimeout: 5 * time.Second,
				ForceAttemptHTTP2:   true,
			},
		},
	}
}

func (p *ConnectionProvider) ID() string        { return p.id }
func (p *ConnectionProvider) Name() string      { return p.name }
func (p *ConnectionProvider) AuthTypes() []AuthType { return p.authTypes }

func (p *ConnectionProvider) SupportsStreaming() bool { return true }
func (p *ConnectionProvider) SupportsTools() bool     { return true }
func (p *ConnectionProvider) SupportsVision() bool    { return false }

// Chat performs a chat completion by routing through stored connections.
func (p *ConnectionProvider) Chat(ctx context.Context, req *ChatRequest, creds *Credentials) (*ChatResponse, error) {
	// Build the OpenAI-compatible request body
	body := map[string]any{
		"model":    req.Model,
		"messages": req.Messages,
		"stream":   req.Stream,
	}
	if req.Temperature > 0 {
		body["temperature"] = req.Temperature
	}
	if req.MaxTokens > 0 {
		body["max_tokens"] = req.MaxTokens
	}
	if len(req.Tools) > 0 {
		body["tools"] = req.Tools
	}
	if req.Metadata != nil {
		for k, v := range req.Metadata {
			body[k] = v
		}
	}

	rawBody, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	// Resolve endpoint
	endpoint := creds.BaseURL
	if endpoint == "" {
		return nil, fmt.Errorf("missing baseUrl")
	}
	u, err := url.Parse(endpoint)
	if err != nil {
		return nil, err
	}
	path := strings.TrimRight(u.Path, "/")
	if !strings.HasSuffix(path, "/v1/chat/completions") {
		path += "/v1/chat/completions"
	}
	u.Path = path
	endpoint = u.String()

	// Make request
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(rawBody))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+creds.APIKey)
	httpReq.Header.Set("Accept", "application/json, text/event-stream")
	httpReq.Header.Set("User-Agent", "fudrouter-go/0.1")

	resp, err := p.client.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(b))
	}

	// Parse response
	var rawResp map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&rawResp); err != nil {
		return nil, err
	}

	// Extract content
	content := extractContent(rawResp)

	return &ChatResponse{
		ID:      getString(rawResp, "id"),
		Model:   getString(rawResp, "model"),
		Content: content,
		Usage: Usage{
			PromptTokens:     getInt(rawResp, "usage.prompt_tokens"),
			CompletionTokens: getInt(rawResp, "usage.completion_tokens"),
			TotalTokens:      getInt(rawResp, "usage.total_tokens"),
		},
		Raw: rawResp,
	}, nil
}

// Models returns available models from the catalog.
func (p *ConnectionProvider) Models(ctx context.Context, creds *Credentials) ([]Model, error) {
	// This would query the provider's /models endpoint
	// For now, return empty — the catalog handles this
	return nil, nil
}

// HealthCheck performs a simple health check.
func (p *ConnectionProvider) HealthCheck(ctx context.Context, creds *Credentials) error {
	if creds.BaseURL == "" {
		return fmt.Errorf("missing baseUrl")
	}
	// Try to hit the /models endpoint
	u, err := url.Parse(creds.BaseURL)
	if err != nil {
		return err
	}
	path := strings.TrimRight(u.Path, "/") + "/models"
	u.Path = path

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	if creds.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+creds.APIKey)
	}

	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}

// Helper functions
func extractContent(resp map[string]any) string {
	choices, _ := resp["choices"].([]any)
	if len(choices) == 0 {
		if s, ok := resp["content"].(string); ok {
			return s
		}
		return ""
	}
	ch, _ := choices[0].(map[string]any)
	if ch == nil {
		return ""
	}
	if msg, ok := ch["message"].(map[string]any); ok {
		switch c := msg["content"].(type) {
		case string:
			return c
		case []any:
			var b strings.Builder
			for _, p := range c {
				if pm, ok := p.(map[string]any); ok {
					if t, ok := pm["text"].(string); ok {
						b.WriteString(t)
					}
				}
			}
			return b.String()
		}
	}
	if t, ok := ch["text"].(string); ok {
		return t
	}
	return ""
}

func getString(m map[string]any, key string) string {
	parts := strings.Split(key, ".")
	var cur any = m
	for _, p := range parts {
		mm, ok := cur.(map[string]any)
		if !ok {
			return ""
		}
		cur = mm[p]
	}
	if s, ok := cur.(string); ok {
		return s
	}
	return ""
}

func getInt(m map[string]any, key string) int {
	parts := strings.Split(key, ".")
	var cur any = m
	for _, p := range parts {
		mm, ok := cur.(map[string]any)
		if !ok {
			return 0
		}
		cur = mm[p]
	}
	switch v := cur.(type) {
	case float64:
		return int(v)
	case int:
		return v
	}
	return 0
}

// Ensure ConnectionProvider implements Provider
var _ Provider = (*ConnectionProvider)(nil)
