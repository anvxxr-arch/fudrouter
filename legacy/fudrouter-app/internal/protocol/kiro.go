package protocol

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// KiroRequestToOpenAI converts a generateAssistantResponse JSON body into OpenAI chat messages.
func KiroRequestToOpenAI(body []byte) (model string, messages []map[string]string, err error) {
	var root map[string]any
	if err = json.Unmarshal(body, &root); err != nil {
		// treat raw as user content
		return "kiro/auto", []map[string]string{{"role": "user", "content": string(body)}}, nil
	}
	model = "kiro/auto"
	if m, ok := root["modelId"].(string); ok && m != "" {
		model = m
	}
	if m, ok := root["model"].(string); ok && m != "" {
		model = m
	}
	// conversationState.currentMessage.userInputMessage.content
	cs, _ := root["conversationState"].(map[string]any)
	if cs == nil {
		cs = root
	}
	if hist, ok := cs["history"].([]any); ok {
		for _, h := range hist {
			hm, _ := h.(map[string]any)
			if hm == nil {
				continue
			}
			if u, ok := hm["userInputMessage"].(map[string]any); ok {
				if c := kiroContent(u); c != "" {
					messages = append(messages, map[string]string{"role": "user", "content": c})
				}
			}
			if a, ok := hm["assistantResponseMessage"].(map[string]any); ok {
				if c := kiroContent(a); c != "" {
					messages = append(messages, map[string]string{"role": "assistant", "content": c})
				}
			}
		}
	}
	if cur, ok := cs["currentMessage"].(map[string]any); ok {
		if u, ok := cur["userInputMessage"].(map[string]any); ok {
			if c := kiroContent(u); c != "" {
				messages = append(messages, map[string]string{"role": "user", "content": c})
			}
			if mid, ok := u["modelId"].(string); ok && mid != "" {
				model = mid
			}
		}
	}
	if len(messages) == 0 {
		// fallback scrape any "content" string
		if c, ok := root["content"].(string); ok && c != "" {
			messages = []map[string]string{{"role": "user", "content": c}}
		} else {
			messages = []map[string]string{{"role": "user", "content": string(body)}}
		}
	}
	return model, messages, nil
}

func kiroContent(m map[string]any) string {
	if c, ok := m["content"].(string); ok {
		return c
	}
	if c, ok := m["text"].(string); ok {
		return c
	}
	// userInputMessageContext?
	return ""
}

// OpenAIChatToKiroEventStream converts a non-stream OpenAI chat.completion JSON
// into concatenated EventStream frames Kiro clients accept.
func OpenAIChatToKiroEventStream(openaiJSON []byte) ([]byte, error) {
	var resp map[string]any
	if err := json.Unmarshal(openaiJSON, &resp); err != nil {
		return nil, err
	}
	content := extractAssistantText(resp)
	if content == "" {
		content = string(openaiJSON)
	}
	var buf bytes.Buffer
	// stream content in ~1k chunks like a real stream
	const chunk = 800
	for i := 0; i < len(content); i += chunk {
		end := i + chunk
		if end > len(content) {
			end = len(content)
		}
		part := content[i:end]
		if err := WriteJSONEvent(&buf, "assistantResponseEvent", map[string]any{
			"content": part,
		}); err != nil {
			return nil, err
		}
	}
	if err := WriteJSONEvent(&buf, "messageMetadataEvent", map[string]any{
		"conversationId": fmt.Sprintf("fudrouter-%d", len(content)),
	}); err != nil {
		return nil, err
	}
	if err := WriteJSONEvent(&buf, "messageStopEvent", map[string]any{
		"stopReason": "end_turn",
	}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func extractAssistantText(resp map[string]any) string {
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

// OpenAISSEToKiroEventStream converts text/event-stream OpenAI chunks into EventStream bytes.
func OpenAISSEToKiroEventStream(sse []byte) ([]byte, error) {
	var content strings.Builder
	for _, line := range bytes.Split(sse, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if !bytes.HasPrefix(line, []byte("data:")) {
			continue
		}
		data := bytes.TrimSpace(bytes.TrimPrefix(line, []byte("data:")))
		if bytes.Equal(data, []byte("[DONE]")) {
			break
		}
		var chunk map[string]any
		if json.Unmarshal(data, &chunk) != nil {
			continue
		}
		choices, _ := chunk["choices"].([]any)
		if len(choices) == 0 {
			continue
		}
		ch, _ := choices[0].(map[string]any)
		if ch == nil {
			continue
		}
		if delta, ok := ch["delta"].(map[string]any); ok {
			if c, ok := delta["content"].(string); ok {
				content.WriteString(c)
			}
		}
		if msg, ok := ch["message"].(map[string]any); ok {
			if c, ok := msg["content"].(string); ok {
				content.WriteString(c)
			}
		}
	}
	return OpenAIChatToKiroEventStream([]byte(`{"choices":[{"message":{"content":` + jsonString(content.String()) + `}}]}`))
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
