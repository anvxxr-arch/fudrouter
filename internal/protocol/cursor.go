package protocol

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

// CursorRequestToOpenAI extracts chat text from Cursor connect/proto or JSON bodies.
// Full protobuf schema is proprietary; we use printable UTF-8 string scraping as a practical MITM bridge.
func CursorRequestToOpenAI(body []byte, path string) (model string, messages []map[string]string, err error) {
	model = "cursor/auto"
	path = strings.ToLower(path)

	// JSON fallback (some debug/tooling paths)
	var root map[string]any
	if json.Unmarshal(body, &root) == nil {
		if m, ok := root["model"].(string); ok && m != "" {
			model = m
		}
		if msgs, ok := root["messages"].([]any); ok && len(msgs) > 0 {
			for _, it := range msgs {
				if mm, ok := it.(map[string]any); ok {
					role, _ := mm["role"].(string)
					content, _ := mm["content"].(string)
					if role == "" {
						role = "user"
					}
					if content != "" {
						messages = append(messages, map[string]string{"role": role, "content": content})
					}
				}
			}
			if len(messages) > 0 {
				return model, messages, nil
			}
		}
		if c, ok := root["prompt"].(string); ok && c != "" {
			return model, []map[string]string{{"role": "user", "content": c}}, nil
		}
	}

	// scrape longest printable runs from binary protobuf
	candidates := extractPrintableRuns(body, 24)
	var best string
	for _, c := range candidates {
		// skip obvious noise
		if strings.HasPrefix(c, "connect-") || strings.Contains(c, "aiserver.v1") {
			continue
		}
		if len(c) > len(best) {
			best = c
		}
	}
	if best == "" {
		best = fmt.Sprintf("[cursor mitm] intercepted %s (%d bytes binary) — no text payload extracted", path, len(body))
	}
	return model, []map[string]string{{"role": "user", "content": best}}, nil
}

func extractPrintableRuns(b []byte, minLen int) []string {
	var out []string
	var cur strings.Builder
	flush := func() {
		s := strings.TrimSpace(cur.String())
		cur.Reset()
		if len(s) >= minLen && utf8.ValidString(s) {
			out = append(out, s)
		}
	}
	for i := 0; i < len(b); {
		r, size := utf8.DecodeRune(b[i:])
		if r == utf8.RuneError && size == 1 {
			flush()
			i++
			continue
		}
		if r == '\n' || r == '\r' || r == '\t' || unicode.IsPrint(r) {
			cur.WriteRune(r)
		} else {
			flush()
		}
		i += size
	}
	flush()
	return out
}

// OpenAIChatToCursorSSE builds a text/event-stream response suitable for RunSSE-like clients.
func OpenAIChatToCursorSSE(openaiJSON []byte) []byte {
	content := extractAssistantTextFromOpenAI(openaiJSON)
	var buf bytes.Buffer
	// simple OpenAI-compatible SSE many tools accept
	chunk := map[string]any{
		"id":      "chatcmpl-cursor-mitm",
		"object":  "chat.completion.chunk",
		"choices": []map[string]any{{"index": 0, "delta": map[string]string{"role": "assistant", "content": content}, "finish_reason": nil}},
	}
	b, _ := json.Marshal(chunk)
	buf.WriteString("data: ")
	buf.Write(b)
	buf.WriteString("\n\n")
	fin := map[string]any{
		"id":      "chatcmpl-cursor-mitm",
		"object":  "chat.completion.chunk",
		"choices": []map[string]any{{"index": 0, "delta": map[string]any{}, "finish_reason": "stop"}},
	}
	b2, _ := json.Marshal(fin)
	buf.WriteString("data: ")
	buf.Write(b2)
	buf.WriteString("\n\n")
	buf.WriteString("data: [DONE]\n\n")
	return buf.Bytes()
}

func extractAssistantTextFromOpenAI(openaiJSON []byte) string {
	var resp map[string]any
	if json.Unmarshal(openaiJSON, &resp) != nil {
		return string(openaiJSON)
	}
	return extractAssistantText(resp)
}

// OpenAIChatToCursorJSON returns a non-stream JSON body for /Run style endpoints.
func OpenAIChatToCursorJSON(openaiJSON []byte) []byte {
	content := extractAssistantTextFromOpenAI(openaiJSON)
	out, _ := json.Marshal(map[string]any{
		"ok":      true,
		"runtime": "go",
		"result":  content,
		"message": map[string]any{"role": "assistant", "content": content},
		"choices": []map[string]any{{"message": map[string]string{"role": "assistant", "content": content}}},
	})
	return out
}
