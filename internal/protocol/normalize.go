package protocol

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// SSEEvent represents a Server-Sent Event.
type SSEEvent struct {
	Event string
	Data  string
	ID    string
	Retry int
}

// SSEReader reads SSE events from a stream.
type SSEReader struct {
	scanner *bufio.Scanner
}

// NewSSEReader creates a new SSEReader.
func NewSSEReader(r io.Reader) *SSEReader {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 10*1024*1024)
	return &SSEReader{scanner: scanner}
}

// ReadEvent reads the next SSE event.
func (r *SSEReader) ReadEvent() (*SSEEvent, error) {
	ev := &SSEEvent{}
	var dataLines []string
	for r.scanner.Scan() {
		line := r.scanner.Text()
		if line == "" {
			// End of event
			if len(dataLines) > 0 || ev.Event != "" || ev.ID != "" {
				ev.Data = strings.Join(dataLines, "\n")
				return ev, nil
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			// Comment, ignore
			continue
		}
		if idx := strings.Index(line, ":"); idx >= 0 {
			field := line[:idx]
			value := line[idx+1:]
			if strings.HasPrefix(value, " ") {
				value = value[1:]
			}
			switch field {
			case "event":
				ev.Event = value
			case "data":
				dataLines = append(dataLines, value)
			case "id":
				ev.ID = value
			case "retry":
				fmt.Sscanf(value, "%d", &ev.Retry)
			}
		} else {
			// Field with no value
			switch line {
			case "data":
				dataLines = append(dataLines, "")
			case "event":
				ev.Event = ""
			case "id":
				ev.ID = ""
			}
		}
	}
	if err := r.scanner.Err(); err != nil {
		return nil, err
	}
	if len(dataLines) > 0 || ev.Event != "" || ev.ID != "" {
		ev.Data = strings.Join(dataLines, "\n")
		return ev, nil
	}
	return nil, io.EOF
}

// OpenAIChunk represents an OpenAI-compatible streaming chunk.
type OpenAIChunk struct {
	ID      string         `json:"id"`
	Object  string         `json:"object"`
	Created int64          `json:"created"`
	Model   string         `json:"model"`
	Choices []ChunkChoice  `json:"choices"`
	Usage   *ChunkUsage    `json:"usage,omitempty"`
}

// ChunkChoice represents a choice in a streaming chunk.
type ChunkChoice struct {
	Index        int         `json:"index"`
	Delta        ChunkDelta  `json:"delta"`
	FinishReason *string     `json:"finish_reason"`
}

// ChunkDelta represents the delta content in a chunk.
type ChunkDelta struct {
	Role    string `json:"role,omitempty"`
	Content string `json:"content,omitempty"`
}

// ChunkUsage represents token usage in a chunk.
type ChunkUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// NormalizeSSE converts provider SSE events to OpenAI-compatible chunks.
// It handles multiple provider formats:
// - OpenAI: data: {"choices":[{"delta":{"content":"..."}}]}
// - Anthropic: event: content_block_delta, data: {"delta":{"text":"..."}}
// - Google: data: {"candidates":[{"content":{"parts":[{"text":"..."}]}}]}
func NormalizeSSE(reader io.Reader, providerID, model, id string, created int64) (<-chan OpenAIChunk, <-chan error) {
	chunks := make(chan OpenAIChunk)
	errs := make(chan error, 1)

	go func() {
		defer close(chunks)
		defer close(errs)

		sse := NewSSEReader(reader)
		var sentRole bool

		for {
			ev, err := sse.ReadEvent()
			if err == io.EOF {
				// Send final chunk with finish_reason
				finish := "stop"
				chunks <- OpenAIChunk{
					ID:      id,
					Object:  "chat.completion.chunk",
					Created: created,
					Model:   model,
					Choices: []ChunkChoice{{Index: 0, FinishReason: &finish}},
				}
				return
			}
			if err != nil {
				errs <- err
				return
			}

			if ev.Data == "" || ev.Data == "[DONE]" {
				continue
			}

			// Parse based on provider format
			switch providerID {
			case "anthropic":
				if ev.Event == "content_block_delta" {
					var data map[string]any
					if err := json.Unmarshal([]byte(ev.Data), &data); err != nil {
						continue
					}
					if delta, ok := data["delta"].(map[string]any); ok {
						if text, ok := delta["text"].(string); ok && text != "" {
							if !sentRole {
								chunks <- OpenAIChunk{
									ID:      id,
									Object:  "chat.completion.chunk",
									Created: created,
									Model:   model,
									Choices: []ChunkChoice{{Index: 0, Delta: ChunkDelta{Role: "assistant"}}},
								}
								sentRole = true
							}
							chunks <- OpenAIChunk{
								ID:      id,
								Object:  "chat.completion.chunk",
								Created: created,
								Model:   model,
								Choices: []ChunkChoice{{Index: 0, Delta: ChunkDelta{Content: text}}},
							}
						}
					}
				}
			case "google":
				var data map[string]any
				if err := json.Unmarshal([]byte(ev.Data), &data); err != nil {
					continue
				}
				if candidates, ok := data["candidates"].([]any); ok && len(candidates) > 0 {
					if cand, ok := candidates[0].(map[string]any); ok {
						if content, ok := cand["content"].(map[string]any); ok {
							if parts, ok := content["parts"].([]any); ok {
								for _, part := range parts {
									if pm, ok := part.(map[string]any); ok {
										if text, ok := pm["text"].(string); ok && text != "" {
											if !sentRole {
												chunks <- OpenAIChunk{
													ID:      id,
													Object:  "chat.completion.chunk",
													Created: created,
													Model:   model,
													Choices: []ChunkChoice{{Index: 0, Delta: ChunkDelta{Role: "assistant"}}},
												}
												sentRole = true
											}
											chunks <- OpenAIChunk{
												ID:      id,
												Object:  "chat.completion.chunk",
												Created: created,
												Model:   model,
												Choices: []ChunkChoice{{Index: 0, Delta: ChunkDelta{Content: text}}},
											}
										}
									}
								}
							}
						}
					}
				}
			default:
				// OpenAI format (default)
				var data map[string]any
				if err := json.Unmarshal([]byte(ev.Data), &data); err != nil {
					continue
				}
				if choices, ok := data["choices"].([]any); ok && len(choices) > 0 {
					if ch, ok := choices[0].(map[string]any); ok {
						if delta, ok := ch["delta"].(map[string]any); ok {
							role, _ := delta["role"].(string)
							content, _ := delta["content"].(string)
							if role != "" && !sentRole {
								chunks <- OpenAIChunk{
									ID:      id,
									Object:  "chat.completion.chunk",
									Created: created,
									Model:   model,
									Choices: []ChunkChoice{{Index: 0, Delta: ChunkDelta{Role: role}}},
								}
								sentRole = true
							}
							if content != "" {
								chunks <- OpenAIChunk{
									ID:      id,
									Object:  "chat.completion.chunk",
									Created: created,
									Model:   model,
									Choices: []ChunkChoice{{Index: 0, Delta: ChunkDelta{Content: content}}},
								}
							}
						}
						if fr, ok := ch["finish_reason"].(string); ok && fr != "" {
							chunks <- OpenAIChunk{
								ID:      id,
								Object:  "chat.completion.chunk",
								Created: created,
								Model:   model,
								Choices: []ChunkChoice{{Index: 0, FinishReason: &fr}},
							}
						}
					}
				}
				// Check for usage in final chunk
				if usage, ok := data["usage"].(map[string]any); ok {
					u := &ChunkUsage{}
					if v, ok := usage["prompt_tokens"].(float64); ok {
						u.PromptTokens = int(v)
					}
					if v, ok := usage["completion_tokens"].(float64); ok {
						u.CompletionTokens = int(v)
					}
					if v, ok := usage["total_tokens"].(float64); ok {
						u.TotalTokens = int(v)
					}
					chunks <- OpenAIChunk{
						ID:      id,
						Object:  "chat.completion.chunk",
						Created: created,
						Model:   model,
						Usage:   u,
					}
				}
			}
		}
	}()

	return chunks, errs
}

// WriteOpenAIChunk writes an OpenAI chunk as an SSE event.
func WriteOpenAIChunk(w io.Writer, chunk OpenAIChunk) error {
	data, err := json.Marshal(chunk)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "data: %s\n\n", data)
	return err
}

// WriteDone writes the [DONE] sentinel.
func WriteDone(w io.Writer) error {
	_, err := fmt.Fprint(w, "data: [DONE]\n\n")
	return err
}

// BufferToSSE converts a buffered response to SSE format.
func BufferToSSE(buf []byte, providerID, model, id string, created int64) ([]byte, error) {
	var out bytes.Buffer
	chunks, errs := NormalizeSSE(bytes.NewReader(buf), providerID, model, id, created)
	for chunk := range chunks {
		if err := WriteOpenAIChunk(&out, chunk); err != nil {
			return nil, err
		}
	}
	if err := <-errs; err != nil {
		return nil, err
	}
	WriteDone(&out)
	return out.Bytes(), nil
}
