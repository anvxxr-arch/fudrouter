package protocol

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// RequestTransformer transforms OpenAI-format requests to provider-native formats.
type RequestTransformer struct {
	providerID string
}

// NewRequestTransformer creates a new RequestTransformer.
func NewRequestTransformer(providerID string) *RequestTransformer {
	return &RequestTransformer{providerID: providerID}
}

// Transform converts an OpenAI chat completion request to the provider's native format.
func (t *RequestTransformer) Transform(body []byte) ([]byte, error) {
	var req map[string]any
	if err := json.Unmarshal(body, &req); err != nil {
		return nil, err
	}

	switch t.providerID {
	case "anthropic":
		return t.transformAnthropic(req)
	case "google":
		return t.transformGoogle(req)
	default:
		// OpenAI format — pass through
		return body, nil
	}
}

func (t *RequestTransformer) transformAnthropic(req map[string]any) ([]byte, error) {
	out := map[string]any{
		"model":      req["model"],
		"max_tokens": 4096,
	}

	if v, ok := req["max_tokens"].(float64); ok && v > 0 {
		out["max_tokens"] = int(v)
	}
	if v, ok := req["temperature"].(float64); ok {
		out["temperature"] = v
	}
	if v, ok := req["top_p"].(float64); ok {
		out["top_p"] = v
	}
	if v, ok := req["stream"].(bool); ok {
		out["stream"] = v
	}

	// Transform messages
	if msgs, ok := req["messages"].([]any); ok {
		out["messages"] = transformAnthropicMessages(msgs)
	}

	// Transform tools
	if tools, ok := req["tools"].([]any); ok {
		out["tools"] = transformAnthropicTools(tools)
	}

	return json.Marshal(out)
}

func transformAnthropicMessages(msgs []any) []any {
	var out []any
	for _, m := range msgs {
		mm, ok := m.(map[string]any)
		if !ok {
			continue
		}
		role, _ := mm["role"].(string)
		content, _ := mm["content"].(string)

		// Anthropic doesn't support system role in messages — move to system param
		if role == "system" {
			// Skip, handled separately
			continue
		}

		out = append(out, map[string]any{
			"role":    role,
			"content": content,
		})
	}
	return out
}

func transformAnthropicTools(tools []any) []any {
	var out []any
	for _, t := range tools {
		tm, ok := t.(map[string]any)
		if !ok {
			continue
		}
		fn, _ := tm["function"].(map[string]any)
		if fn == nil {
			continue
		}
		out = append(out, map[string]any{
			"name":        fn["name"],
			"description": fn["description"],
			"input_schema": fn["parameters"],
		})
	}
	return out
}

func (t *RequestTransformer) transformGoogle(req map[string]any) ([]byte, error) {
	out := map[string]any{}

	// Transform messages to Google format
	if msgs, ok := req["messages"].([]any); ok {
		var contents []any
		for _, m := range msgs {
			mm, ok := m.(map[string]any)
			if !ok {
				continue
			}
			role, _ := mm["role"].(string)
			content, _ := mm["content"].(string)

			// Google uses "model" instead of "assistant"
			grole := role
			if role == "assistant" {
				grole = "model"
			}

			contents = append(contents, map[string]any{
				"role": grole,
				"parts": []map[string]any{
					{"text": content},
				},
			})
		}
		out["contents"] = contents
	}

	// Generation config
	genConfig := map[string]any{}
	if v, ok := req["temperature"].(float64); ok {
		genConfig["temperature"] = v
	}
	if v, ok := req["max_tokens"].(float64); ok {
		genConfig["maxOutputTokens"] = int(v)
	}
	if v, ok := req["top_p"].(float64); ok {
		genConfig["topP"] = v
	}
	if len(genConfig) > 0 {
		out["generationConfig"] = genConfig
	}

	return json.Marshal(out)
}

// ResponseTransformer transforms provider-native responses to OpenAI format.
type ResponseTransformer struct {
	providerID string
}

// NewResponseTransformer creates a new ResponseTransformer.
func NewResponseTransformer(providerID string) *ResponseTransformer {
	return &ResponseTransformer{providerID: providerID}
}

// Transform converts a provider response to OpenAI format.
func (t *ResponseTransformer) Transform(body []byte) ([]byte, error) {
	var resp map[string]any
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, err
	}

	switch t.providerID {
	case "anthropic":
		return t.transformAnthropic(resp)
	case "google":
		return t.transformGoogle(resp)
	default:
		// OpenAI format — pass through
		return body, nil
	}
}

func (t *ResponseTransformer) transformAnthropic(resp map[string]any) ([]byte, error) {
	out := map[string]any{
		"id":      resp["id"],
		"object":  "chat.completion",
		"created": 0,
		"model":   resp["model"],
	}

	// Extract content
	var content string
	if contentBlocks, ok := resp["content"].([]any); ok {
		for _, block := range contentBlocks {
			if bm, ok := block.(map[string]any); ok {
				if text, ok := bm["text"].(string); ok {
					content += text
				}
			}
		}
	}

	out["choices"] = []map[string]any{
		{
			"index": 0,
			"message": map[string]any{
				"role":    "assistant",
				"content": content,
			},
			"finish_reason": "stop",
		},
	}

	// Usage
	if usage, ok := resp["usage"].(map[string]any); ok {
		out["usage"] = map[string]any{
			"prompt_tokens":     usage["input_tokens"],
			"completion_tokens": usage["output_tokens"],
			"total_tokens":      usage["input_tokens"].(int) + usage["output_tokens"].(int),
		}
	}

	return json.Marshal(out)
}

func (t *ResponseTransformer) transformGoogle(resp map[string]any) ([]byte, error) {
	out := map[string]any{
		"id":      resp["id"],
		"object":  "chat.completion",
		"created": 0,
		"model":   resp["model"],
	}

	// Extract content
	var content string
	if candidates, ok := resp["candidates"].([]any); ok && len(candidates) > 0 {
		if cand, ok := candidates[0].(map[string]any); ok {
			if c, ok := cand["content"].(map[string]any); ok {
				if parts, ok := c["parts"].([]any); ok {
					for _, part := range parts {
						if pm, ok := part.(map[string]any); ok {
							if text, ok := pm["text"].(string); ok {
								content += text
							}
						}
					}
				}
			}
		}
	}

	out["choices"] = []map[string]any{
		{
			"index": 0,
			"message": map[string]any{
				"role":    "assistant",
				"content": content,
			},
			"finish_reason": "stop",
		},
	}

	return json.Marshal(out)
}

// TransformStream transforms a streaming response body.
func (t *ResponseTransformer) TransformStream(body []byte) ([]byte, error) {
	// For streaming, we use the SSE normalizer
	// This is a placeholder — actual streaming is handled by the proxy
	return body, nil
}

// ProviderFormat returns the content type and format for a provider.
func ProviderFormat(providerID string) (contentType string, format string) {
	switch providerID {
	case "anthropic":
		return "application/json", "anthropic"
	case "google":
		return "application/json", "google"
	default:
		return "application/json", "openai"
	}
}

// SupportedProviders returns the list of providers with custom transformers.
func SupportedProviders() []string {
	return []string{"anthropic", "google"}
}

// IsSupported returns true if the provider has a custom transformer.
func IsSupported(providerID string) bool {
	for _, p := range SupportedProviders() {
		if p == providerID {
			return true
		}
	}
	return false
}

// TransformRequest is a convenience function to transform a request.
func TransformRequest(providerID string, body []byte) ([]byte, error) {
	t := NewRequestTransformer(providerID)
	return t.Transform(body)
}

// TransformResponse is a convenience function to transform a response.
func TransformResponse(providerID string, body []byte) ([]byte, error) {
	t := NewResponseTransformer(providerID)
	return t.Transform(body)
}

var _ = fmt.Sprintf // keep import
var _ = bytes.NewReader // keep import
