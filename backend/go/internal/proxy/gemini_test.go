package proxy

import (
	"encoding/json"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/routing"
)

// The /v1beta surface is a pure translation layer, so it is tested as one:
// request in → [OI] out, [OI] in → Gemini out. No upstream is involved.

func TestTranslateGeminiRequest(t *testing.T) {
	body := []byte(`{
	  "systemInstruction": {"parts": [{"text": "be brief"}]},
	  "contents": [
	    {"role": "user", "parts": [{"text": "hello"}]},
	    {"role": "model", "parts": [{"text": "hi there"}]},
	    {"role": "user", "parts": [{"text": "again"}]}
	  ],
	  "generationConfig": {
	    "maxOutputTokens": 256, "temperature": 0.3, "topP": 0.9,
	    "stopSequences": ["END"], "responseMimeType": "application/json"
	  },
	  "tools": [{"functionDeclarations": [{
	    "name": "get_weather", "description": "weather",
	    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}}
	  }]}]
	}`)

	out, apiErr := translateGeminiRequest(body, "gemini-3.5-flash", false)
	if apiErr != nil {
		t.Fatalf("unexpected error: %+v", apiErr)
	}
	var got struct {
		Model       string           `json:"model"`
		Messages    []map[string]any `json:"messages"`
		MaxTokens   int64            `json:"max_tokens"`
		Temperature float64          `json:"temperature"`
		TopP        float64          `json:"top_p"`
		Stop        []string         `json:"stop"`
		Format      struct {
			Type string `json:"type"`
		} `json:"response_format"`
		Tools []struct {
			Type     string `json:"type"`
			Function struct {
				Name string `json:"name"`
			} `json:"function"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("encoder emitted invalid JSON: %v", err)
	}

	if got.Model != "gemini-3.5-flash" {
		t.Errorf("model = %q, want the path slug (Gemini bodies carry no model field)", got.Model)
	}
	if len(got.Messages) != 4 {
		t.Fatalf("messages = %d, want 4 (system + 3 turns)", len(got.Messages))
	}
	if got.Messages[0]["role"] != "system" || got.Messages[0]["content"] != "be brief" {
		t.Errorf("systemInstruction must become a system message, got %v", got.Messages[0])
	}
	if got.Messages[2]["role"] != "assistant" {
		t.Errorf("Gemini 'model' role must become 'assistant', got %v", got.Messages[2]["role"])
	}
	if got.MaxTokens != 256 || got.Temperature != 0.3 || got.TopP != 0.9 {
		t.Errorf("generationConfig not mapped: %+v", got)
	}
	if len(got.Stop) != 1 || got.Stop[0] != "END" {
		t.Errorf("stopSequences = %v", got.Stop)
	}
	if got.Format.Type != "json_object" {
		t.Errorf("responseMimeType json must map to response_format=json_object, got %q", got.Format.Type)
	}
	if len(got.Tools) != 1 || got.Tools[0].Function.Name != "get_weather" {
		t.Errorf("functionDeclarations not flattened into tools: %+v", got.Tools)
	}
}

func TestTranslateGeminiIncludesMapsToText(t *testing.T) {
	body := []byte(`{"contents":[{"role":"user","parts":[
	  {"text":"what is this"},{"inlineData":{"mimeType":"image/png","data":"QUJD"}}]}]}`)
	out, apiErr := translateGeminiRequest(body, "m", false)
	if apiErr != nil {
		t.Fatalf("unexpected error: %+v", apiErr)
	}
	var got struct {
		Messages []struct {
			Role    string `json:"role"`
			Content []struct {
				Type     string `json:"type"`
				Text     string `json:"text"`
				ImageURL struct {
					URL string `json:"url"`
				} `json:"image_url"`
			} `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("messages content should be a part array when an image is present: %v", err)
	}
	if len(got.Messages) != 1 || len(got.Messages[0].Content) != 2 {
		t.Fatalf("want 2 parts (text + image), got %+v", got.Messages)
	}
	if got.Messages[0].Content[1].ImageURL.URL != "data:image/png;base64,QUJD" {
		t.Errorf("inlineData must become a data: URI, got %q", got.Messages[0].Content[1].ImageURL.URL)
	}
}

func TestTranslateGeminiRejectsEmptyContents(t *testing.T) {
	if _, apiErr := translateGeminiRequest([]byte(`{"contents":[]}`), "m", false); apiErr == nil {
		t.Fatal("empty contents must be refused")
	}
}

func TestOpenAIToGemini(t *testing.T) {
	body := []byte(`{
	  "choices": [{"message": {"role":"assistant","content":"pong"},
	    "finish_reason": "length"}],
	  "usage": {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18}
	}`)
	out, apiErr := openAIToGemini(body, "gemini-3.5-flash")
	if apiErr != nil {
		t.Fatalf("unexpected error: %+v", apiErr)
	}
	var got struct {
		Candidates []struct {
			Content struct {
				Role  string `json:"role"`
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
			FinishReason string `json:"finishReason"`
		} `json:"candidates"`
		Usage struct {
			Prompt     int64 `json:"promptTokenCount"`
			Candidates int64 `json:"candidatesTokenCount"`
			Total      int64 `json:"totalTokenCount"`
		} `json:"usageMetadata"`
		ModelVersion string `json:"modelVersion"`
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("encoder emitted invalid JSON: %v", err)
	}
	if len(got.Candidates) != 1 {
		t.Fatalf("want 1 candidate, got %d", len(got.Candidates))
	}
	if got.Candidates[0].Content.Role != "model" {
		t.Errorf("role = %q, want model", got.Candidates[0].Content.Role)
	}
	if got.Candidates[0].Content.Parts[0].Text != "pong" {
		t.Errorf("text not carried over: %+v", got.Candidates[0].Content.Parts)
	}
	if got.Candidates[0].FinishReason != "MAX_TOKENS" {
		t.Errorf("finishReason = %q, want MAX_TOKENS", got.Candidates[0].FinishReason)
	}
	if got.Usage.Prompt != 11 || got.Usage.Candidates != 7 || got.Usage.Total != 18 {
		t.Errorf("usage not carried over: %+v", got.Usage)
	}
	if got.ModelVersion != "gemini-3.5-flash" {
		t.Errorf("modelVersion = %q", got.ModelVersion)
	}
}

func TestGeminiErrorEnvelopeAndStatus(t *testing.T) {
	env := geminiErrorBody(routing.ErrCodeAuthError, "invalid key")
	errObj, _ := env["error"].(map[string]any)
	if errObj["status"] != "UNAUTHENTICATED" {
		t.Errorf("auth_error must map to UNAUTHENTICATED, got %v", errObj["status"])
	}
	if errObj["code"] != 401 {
		t.Errorf("code = %v, want 401", errObj["code"])
	}
	cases := map[string]string{
		routing.ErrCodeRateLimited:         "RESOURCE_EXHAUSTED",
		routing.ErrCodeInsufficientCredits: "RESOURCE_EXHAUSTED",
		routing.ErrCodeModelNotFound:       "NOT_FOUND",
		routing.ErrCodeInvalidRequest:      "INVALID_ARGUMENT",
		routing.ErrCodeContextTooLong:      "INVALID_ARGUMENT",
		routing.ErrCodeProviderUnavailable: "UNAVAILABLE",
		routing.ErrCodeCircuitOpen:         "UNAVAILABLE",
		routing.ErrCodeProviderTimeout:     "DEADLINE_EXCEEDED",
	}
	for code, want := range cases {
		if got := geminiStatus(code); got != want {
			t.Errorf("geminiStatus(%q) = %q, want %q", code, got, want)
		}
	}
}
