package proxy

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// streamSSE copies the upstream SSE to the client line-group by line-group,
// capturing the usage object from the final data chunk (PRD §87: usage is
// billed whenever the provider reports it, and `stream_options.include_usage`
// is injected so it does report).
//
// Timing (spec §8): ttft_ms is the first event's arrival; stream duration and
// `client_disconnected` come from the relay itself. The ledger row is written
// when the stream ENDS — detached from the request context, because a client
// that disconnects mid-stream cancels r.Context() and the row must survive the
// client.
func (lc *lifecycle) streamSSE(w http.ResponseWriter, body io.Reader) {
	flusher, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	lc.setResponseHeaders()
	w.WriteHeader(http.StatusOK)

	var usage usageCounts
	usageSeen := false
	ttft := 0
	generationStart := time.Now()
	streamStart := generationStart

	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		if _, err := fmt.Fprintln(w, line); err != nil {
			// The write failed: the client is gone. Record the disconnect and
			// stop — the usage reported so far is still billed (PRD §87).
			lc.clientDisconnected = true
			break
		}
		if flusher != nil {
			flusher.Flush()
		}
		if ttft == 0 {
			ttft = int(time.Since(streamStart).Milliseconds())
		}
		if strings.HasPrefix(line, "data: ") {
			payload := strings.TrimPrefix(line, "data: ")
			if payload == "[DONE]" {
				continue
			}
			// A token chunk is `{"id":…,"choices":[…]}`; only the provider's
			// final chunk carries `usage`. The substring test is a NECESSARY
			// condition for the parse below to find anything (a JSON key can
			// only be spelled out or \u-escaped, and the escape contains a
			// backslash), so skipping the parse when it fails changes nothing
			// observable — it just stops the relay from paying a full JSON
			// unmarshal per token chunk.
			if !strings.Contains(payload, `"usage"`) && !strings.Contains(payload, `\`) {
				continue
			}
			var chunk struct {
				Usage *struct {
					PromptTokens     int64 `json:"prompt_tokens"`
					CompletionTokens int64 `json:"completion_tokens"`
					TotalTokens      int64 `json:"total_tokens"`
					InputTokens      int64 `json:"input_tokens"`
					OutputTokens     int64 `json:"output_tokens"`
					PromptDetails    struct {
						CachedTokens int64 `json:"cached_tokens"`
					} `json:"prompt_tokens_details"`
					CompletionDetails struct {
						ReasoningTokens int64 `json:"reasoning_tokens"`
					} `json:"completion_tokens_details"`
				} `json:"usage"`
			}
			if err := json.Unmarshal([]byte(payload), &chunk); err == nil && chunk.Usage != nil {
				usage = usageCounts{
					TokensIn:          chunk.Usage.PromptTokens,
					TokensOut:         chunk.Usage.CompletionTokens,
					TotalTokens:       chunk.Usage.TotalTokens,
					CachedInputTokens: chunk.Usage.PromptDetails.CachedTokens,
					ReasoningTokens:   chunk.Usage.CompletionDetails.ReasoningTokens,
				}
				if usage.TokensIn == 0 {
					usage.TokensIn = chunk.Usage.InputTokens
				}
				if usage.TokensOut == 0 {
					usage.TokensOut = chunk.Usage.OutputTokens
				}
				usageSeen = true
			}
		}
	}
	if err := sc.Err(); err != nil && !lc.clientDisconnected {
		lc.rawErr = "stream: " + err.Error()
	}
	lc.timing["generation"] = time.Since(generationStart).Milliseconds()
	if ttft > 0 {
		t := ttft
		lc.streamTTFT = &t
	}
	if usageSeen {
		lc.usage, lc.usageSeen = usage, true
	}
	if lc.status == "" && lc.rawErr == "" {
		lc.status = "success"
	}
	lc.finish()
}
