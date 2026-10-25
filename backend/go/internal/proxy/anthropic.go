// anthropic.go — the Anthropic Messages API as a NATIVE inbound surface.
//
// The data plane speaks [OI] chat completions to its upstreams. This file adds
// POST /v1/messages (and POST /v1/messages/count_tokens) so Anthropic-shaped
// clients — [CC], the Anthropic SDKs, Cursor's Anthropic mode, Zed — can point
// at the router unchanged, without a translator in front.
//
// The translation is stateless and WRAPS the shared lifecycle: the inbound body
// is rewritten to an [OI] chat request, the request runs through begin/dispatch
// (auth → limits → budget → routing → failover → billing) exactly like the
// native chat path, and the upstream answer is rewritten back to the Anthropic
// wire shape (JSON or SSE). Nothing about billing, the ledger or the error
// taxonomy is re-implemented here — a /v1/messages call is billed, logged and
// limited like any other.
package proxy

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/ids"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/routing"
)

// --- request shapes (the subset the router models) ---

// anthropicRequest is the subset of the Anthropic Messages request the router
// translates. Fields the router does not model (metadata, thinking, …) are
// ignored rather than rejected, so a client that sends more than this still
// works.
type anthropicRequest struct {
	Model         string             `json:"model"`
	MaxTokens     int64              `json:"max_tokens"`
	System        json.RawMessage    `json:"system"`
	Messages      []anthropicMessage `json:"messages"`
	Stream        bool               `json:"stream"`
	Temperature   *float64           `json:"temperature"`
	TopP          *float64           `json:"top_p"`
	StopSequences []string           `json:"stop_sequences"`
	Tools         []anthropicTool    `json:"tools"`
	ToolChoice    json.RawMessage    `json:"tool_choice"`
}

type anthropicMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

type anthropicTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"input_schema"`
}

// oiUsage is the [OI]-shaped usage block, tolerating the prompt/completion and
// input/output spellings (the same tolerance parseUsage has).
type oiUsage struct {
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
}

func (u *oiUsage) counts() usageCounts {
	c := usageCounts{
		TokensIn:          u.PromptTokens,
		TokensOut:         u.CompletionTokens,
		TotalTokens:       u.TotalTokens,
		CachedInputTokens: u.PromptDetails.CachedTokens,
		ReasoningTokens:   u.CompletionDetails.ReasoningTokens,
	}
	if c.TokensIn == 0 {
		c.TokensIn = u.InputTokens
	}
	if c.TokensOut == 0 {
		c.TokensOut = u.OutputTokens
	}
	return c
}

// --- entry points ---

// ServeMessages handles POST /v1/messages: the Anthropic Messages API.
func (h *Handler) ServeMessages(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	body, err := io.ReadAll(io.LimitReader(r.Body, 10<<20))
	if err != nil {
		writeAnthropicError(w, routing.ErrCodeInvalidRequest, "cannot read body", 0)
		return
	}

	var oiBody []byte
	var stream bool
	validate := func(b []byte) (string, *apiError) {
		slug, oi, st, apiErr := translateAnthropicRequest(b)
		if apiErr != nil {
			return "", apiErr
		}
		oiBody, stream = oi, st
		return slug, nil
	}

	lc, ok := h.begin(w, r, start, "/v1/messages", body, validate, true)
	if !ok {
		return
	}
	defer lc.finish()

	lc.stream = stream
	upCtx := lc.upstreamContext(r, stream)
	resp, err := lc.dispatch(upCtx, oiBody, http.MethodPost, "", "/chat/completions")
	if err != nil || resp == nil {
		lc.fail(err)
		return
	}
	defer resp.Body.Close()
	lc.logTarget(resp.StatusCode)

	if stream {
		lc.anthropicStreamSSE(w, resp.Body, lc.requested)
		return
	}

	respBody, err := lc.readUpstreamBody(resp)
	if err != nil {
		lc.fail(fmt.Errorf("read upstream: %w", err))
		return
	}
	lc.serveAnthropicBuffered(w, respBody, lc.requested)
}

// ServeCountTokens handles POST /v1/messages/count_tokens.
//
// No upstream in the pool exposes an Anthropic tokenizer, so this is a
// documented ESTIMATE over the [OI] request the call would be sent as (~4
// characters per token plus a small per-message overhead). It exists so
// Anthropic clients that probe the endpoint get an answer in the right shape
// instead of a 404; it is never used for billing (the ledger bills what the
// provider reports).
func (h *Handler) ServeCountTokens(w http.ResponseWriter, r *http.Request) {
	if _, err := h.authenticate(r); err != nil {
		writeAnthropicError(w, routing.ErrCodeAuthError, err.Error(), 0)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 10<<20))
	if err != nil {
		writeAnthropicError(w, routing.ErrCodeInvalidRequest, "cannot read body", 0)
		return
	}
	_, oi, _, apiErr := translateAnthropicRequest(body)
	if apiErr != nil {
		writeAnthropicError(w, apiErr.Code, apiErr.Message, apiErr.Status)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"input_tokens": estimateInputTokens(oi),
	})
}

// --- Anthropic → [OI] ---

// translateAnthropicRequest rewrites an Anthropic Messages body into the [OI]
// chat body the upstreams speak. It returns the routing slug (the model), the
// translated body, whether the call is streaming, and a rejection for a body it
// cannot translate.
func translateAnthropicRequest(body []byte) (slug string, oi []byte, stream bool, apiErr *apiError) {
	var req anthropicRequest
	if err := json.Unmarshal(body, &req); err != nil {
		return "", nil, false, invalidRequest("invalid JSON body")
	}
	if req.Model == "" {
		return "", nil, false, invalidRequest("missing model")
	}

	msgs := make([]any, 0, len(req.Messages)+1)
	if sys := rawText(req.System); sys != "" {
		msgs = append(msgs, map[string]any{"role": "system", "content": sys})
	}
	for _, m := range req.Messages {
		converted, err := anthropicMessageToOpenAI(m)
		if err != nil {
			return "", nil, false, invalidRequest(err.Error())
		}
		msgs = append(msgs, converted...)
	}

	out := map[string]any{
		"model":    req.Model,
		"messages": msgs,
	}
	// Anthropic requires max_tokens; forward it when present so the TPM window
	// and the upstream both see the client's own bound.
	if req.MaxTokens > 0 {
		out["max_tokens"] = req.MaxTokens
	}
	if req.Temperature != nil {
		out["temperature"] = *req.Temperature
	}
	if req.TopP != nil {
		out["top_p"] = *req.TopP
	}
	if len(req.StopSequences) > 0 {
		out["stop"] = req.StopSequences
	}
	if len(req.Tools) > 0 {
		tools := make([]any, 0, len(req.Tools))
		for _, t := range req.Tools {
			var params any = map[string]any{"type": "object"}
			if len(t.InputSchema) > 0 {
				_ = json.Unmarshal(t.InputSchema, &params)
			}
			fn := map[string]any{"name": t.Name, "parameters": params}
			if t.Description != "" {
				fn["description"] = t.Description
			}
			tools = append(tools, map[string]any{"type": "function", "function": fn})
		}
		out["tools"] = tools
		if tc := toolChoiceToOpenAI(req.ToolChoice); tc != nil {
			out["tool_choice"] = tc
		}
	}
	if req.Stream {
		out["stream"] = true
		// Billing needs the usage block, exactly as the native chat path
		// injects it (PRD §87).
		out["stream_options"] = map[string]any{"include_usage": true}
	}

	encoded, err := json.Marshal(out)
	if err != nil {
		return "", nil, false, invalidRequest("cannot encode request")
	}
	return req.Model, encoded, req.Stream, nil
}

// anthropicMessageToOpenAI converts ONE Anthropic message into one or more [OI]
// messages. Anthropic packs tool results INTO a user turn; [OI] carries them as
// their own `role:"tool"` messages, so the order is preserved by emitting the
// tool results first.
func anthropicMessageToOpenAI(m anthropicMessage) ([]any, error) {
	// A plain string content is the common case.
	var s string
	if json.Unmarshal(m.Content, &s) == nil {
		return []any{map[string]any{"role": m.Role, "content": s}}, nil
	}
	var blocks []map[string]any
	if err := json.Unmarshal(m.Content, &blocks); err != nil {
		return nil, fmt.Errorf("message content must be a string or an array of content blocks")
	}

	var textParts []string
	var images []any
	var toolCalls []any
	var toolResults []any
	for _, b := range blocks {
		switch b["type"] {
		case "text":
			if t, ok := b["text"].(string); ok {
				textParts = append(textParts, t)
			}
		case "image":
			if url := anthropicImageURL(b); url != "" {
				images = append(images, map[string]any{
					"type": "image_url", "image_url": map[string]any{"url": url},
				})
			}
		case "tool_use":
			args := "{}"
			if raw, err := json.Marshal(b["input"]); err == nil && string(raw) != "null" {
				args = string(raw)
			}
			id, _ := b["id"].(string)
			name, _ := b["name"].(string)
			toolCalls = append(toolCalls, map[string]any{
				"id": id, "type": "function",
				"function": map[string]any{"name": name, "arguments": args},
			})
		case "tool_result":
			id, _ := b["tool_use_id"].(string)
			// An absent or non-string tool_use_id used to pass through as
			// `tool_call_id: ""`, which every [OI] upstream rejects with a 400
			// the client cannot act on — it never sent an empty id. Reject here
			// so the router names the malformed block in its own envelope.
			if id == "" {
				return nil, fmt.Errorf("tool_result block is missing a string tool_use_id")
			}
			result := ""
			if raw, err := json.Marshal(b["content"]); err == nil {
				result = rawText(raw)
			}
			toolResults = append(toolResults, map[string]any{
				"role": "tool", "tool_call_id": id, "content": result,
			})
		}
	}

	var out []any
	switch {
	case len(toolCalls) > 0:
		// The assistant turn declaring the tool_calls MUST be emitted before
		// the role:"tool" messages that answer them: [OI] upstreams reject a
		// tool message whose tool_call_id no preceding assistant turn declared.
		// One Anthropic message may legally carry tool_use and tool_result
		// together, so the order cannot rely on the blocks arriving apart.
		msg := map[string]any{"role": "assistant", "tool_calls": toolCalls}
		if len(textParts) > 0 {
			msg["content"] = strings.Join(textParts, "\n")
		} else {
			msg["content"] = nil
		}
		out = append(out, msg)
		out = append(out, toolResults...)
	case len(images) > 0:
		content := make([]any, 0, len(images)+1)
		if len(textParts) > 0 {
			content = append(content, map[string]any{"type": "text", "text": strings.Join(textParts, "\n")})
		}
		content = append(content, images...)
		out = append(out, map[string]any{"role": m.Role, "content": content})
		out = append(out, toolResults...)
	case len(textParts) > 0:
		out = append(out, map[string]any{"role": m.Role, "content": strings.Join(textParts, "\n")})
		out = append(out, toolResults...)
	default:
		// A turn carrying only tool_result blocks still has to emit them: the
		// switch above is mutually exclusive, so falling through to the empty
		// placeholder would silently drop the results.
		if len(toolResults) > 0 {
			out = append(out, toolResults...)
		} else {
			// An empty turn still needs its role for some upstreams.
			out = append(out, map[string]any{"role": m.Role, "content": ""})
		}
	}
	return out, nil
}

// anthropicImageURL turns an Anthropic image block into an [OI] image URL,
// handling both the base64 and the url source shapes.
func anthropicImageURL(b map[string]any) string {
	src, _ := b["source"].(map[string]any)
	if src == nil {
		return ""
	}
	switch src["type"] {
	case "base64":
		media, _ := src["media_type"].(string)
		data, _ := src["data"].(string)
		if data == "" {
			return ""
		}
		if media == "" {
			media = "image/png"
		}
		return "data:" + media + ";base64," + data
	case "url":
		u, _ := src["url"].(string)
		return u
	}
	return ""
}

// toolChoiceToOpenAI maps the Anthropic tool_choice onto the [OI] spelling.
func toolChoiceToOpenAI(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	var tc struct {
		Type string `json:"type"`
		Name string `json:"name"`
	}
	if json.Unmarshal(raw, &tc) != nil {
		return nil
	}
	switch tc.Type {
	case "auto":
		return "auto"
	case "any":
		return "required"
	case "none":
		return "none"
	case "tool":
		if tc.Name == "" {
			return nil
		}
		return map[string]any{"type": "function", "function": map[string]any{"name": tc.Name}}
	}
	return nil
}

// --- [OI] → Anthropic ---

// openAIToAnthropic rewrites a buffered [OI] chat response into an Anthropic
// Message object.
func openAIToAnthropic(body []byte, model string) ([]byte, *apiError) {
	var resp struct {
		ID      string `json:"id"`
		Choices []struct {
			Message struct {
				Content   any `json:"content"`
				ToolCalls []struct {
					ID       string `json:"id"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage *oiUsage `json:"usage"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, &apiError{Code: routing.ErrCodeUpstreamError, Status: 502,
			Type: "api_error", Message: "upstream returned a non-JSON response"}
	}
	if len(resp.Choices) == 0 {
		return nil, &apiError{Code: routing.ErrCodeUpstreamError, Status: 502,
			Type: "api_error", Message: "upstream returned no choices"}
	}
	ch := resp.Choices[0]

	blocks := make([]any, 0, 1+len(ch.Message.ToolCalls))
	if text := contentString(ch.Message.Content); text != "" {
		blocks = append(blocks, map[string]any{"type": "text", "text": text})
	}
	for _, tc := range ch.Message.ToolCalls {
		var input any = map[string]any{}
		if tc.Function.Arguments != "" {
			if json.Unmarshal([]byte(tc.Function.Arguments), &input) != nil {
				input = map[string]any{}
			}
		}
		blocks = append(blocks, map[string]any{
			"type": "tool_use", "id": tc.ID, "name": tc.Function.Name, "input": input,
		})
	}
	if len(blocks) == 0 {
		blocks = append(blocks, map[string]any{"type": "text", "text": ""})
	}

	usage := map[string]any{"input_tokens": 0, "output_tokens": 0}
	if resp.Usage != nil {
		u := resp.Usage.counts()
		usage["input_tokens"] = u.TokensIn
		usage["output_tokens"] = u.TokensOut
	}

	stop := anthropicStopReason(ch.FinishReason)
	if stop == "end_turn" && len(ch.Message.ToolCalls) > 0 {
		stop = "tool_use"
	}

	out := map[string]any{
		"id":            anthropicMessageID(resp.ID),
		"type":          "message",
		"role":          "assistant",
		"model":         model,
		"content":       blocks,
		"stop_reason":   stop,
		"stop_sequence": nil,
		"usage":         usage,
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		return nil, &apiError{Code: routing.ErrCodeInternalError, Status: 500,
			Type: "api_error", Message: "cannot encode response"}
	}
	return encoded, nil
}

// serveAnthropicBuffered writes a buffered Anthropic answer and records usage.
func (lc *lifecycle) serveAnthropicBuffered(w http.ResponseWriter, oiBody []byte, model string) {
	lc.usage, lc.usageSeen = parseUsage(oiBody)

	translated, apiErr := openAIToAnthropic(oiBody, model)
	if apiErr != nil {
		lc.errCode, lc.errMsg = apiErr.Code, apiErr.Message
		lc.status = statusForErrCode(apiErr.Code)
		lc.httpStat = apiErr.Status
		lc.setResponseHeaders()
		lc.writeAnthropicError(apiErr.Code, apiErr.Message, apiErr.Status)
		lc.finish()
		return
	}
	if lc.usageSeen {
		lc.errCode, lc.status = "", "success"
	} else {
		lc.status = "success"
	}
	lc.setResponseHeaders()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(translated)
	lc.finish()
}

// oiStreamChunk is the slice of an [OI] streaming chunk the translator reads.
type oiStreamChunk struct {
	Choices []struct {
		Delta struct {
			Content   string `json:"content"`
			ToolCalls []struct {
				Index    int    `json:"index"`
				ID       string `json:"id"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
	Usage *oiUsage `json:"usage"`
}

// anthropicStreamSSE relays an [OI] SSE stream as an Anthropic SSE stream.
//
// The [OI] protocol is a flat list of `delta` chunks; the Anthropic protocol is
// a block-oriented event stream (message_start → content_block_* → message_delta
// → message_stop). This holds the small state machine that bridges them and
// captures the usage block for billing.
func (lc *lifecycle) anthropicStreamSSE(w http.ResponseWriter, body io.Reader, model string) {
	flusher, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	lc.setResponseHeaders()
	w.WriteHeader(http.StatusOK)

	msgID := "msg_" + strings.TrimPrefix(lc.requestID, "req_")
	emit := func(event string, payload any) bool {
		b, _ := json.Marshal(payload)
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b); err != nil {
			return false
		}
		if flusher != nil {
			flusher.Flush()
		}
		return true
	}

	streamStart := time.Now()
	generationStart := streamStart
	ttft := 0

	if !emit("message_start", map[string]any{
		"type": "message_start",
		"message": map[string]any{
			"id": msgID, "type": "message", "role": "assistant", "model": model,
			"content": []any{}, "stop_reason": nil, "stop_sequence": nil,
			"usage": map[string]any{"input_tokens": 0, "output_tokens": 0},
		},
	}) {
		lc.clientDisconnected = true
		lc.finish()
		return
	}

	var (
		usage       usageCounts
		usageSeen   bool
		stopReason  string
		nextIndex   int
		textIndex   = -1
		textOpen    bool
		openBlocks  []int
		toolBlocks  = map[int]int{} // [OI] tool index → anthropic block index
		interrupted bool
	)

	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		// H5: ttft is stamped on the first content_block_delta EMIT below,
		// not on the first non-empty line — message_start and
		// content_block_start are protocol framing the client receives before
		// any token exists, and stamping them reported ttft_ms ≈ 0.
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		payload := strings.TrimPrefix(line, "data: ")
		if payload == "[DONE]" {
			continue
		}
		var chunk oiStreamChunk
		if json.Unmarshal([]byte(payload), &chunk) != nil {
			continue
		}
		if chunk.Usage != nil {
			usage, usageSeen = chunk.Usage.counts(), true
		}
		if len(chunk.Choices) == 0 {
			continue
		}
		ch := chunk.Choices[0]

		if ch.Delta.Content != "" {
			if !textOpen {
				textIndex = nextIndex
				nextIndex++
				openBlocks = append(openBlocks, textIndex)
				if !emit("content_block_start", map[string]any{
					"type": "content_block_start", "index": textIndex,
					"content_block": map[string]any{"type": "text", "text": ""},
				}) {
					interrupted = true
					break
				}
				textOpen = true
			}
			if !emit("content_block_delta", map[string]any{
				"type": "content_block_delta", "index": textIndex,
				"delta": map[string]any{"type": "text_delta", "text": ch.Delta.Content},
			}) {
				interrupted = true
				break
			}
			if ttft == 0 {
				ttft = int(time.Since(streamStart).Milliseconds())
			}
		}

		for _, tc := range ch.Delta.ToolCalls {
			ai, ok := toolBlocks[tc.Index]
			if !ok {
				if textOpen {
					if !emit("content_block_stop", map[string]any{
						"type": "content_block_stop", "index": textIndex,
					}) {
						interrupted = true
						break
					}
					textOpen = false
				}
				ai = nextIndex
				nextIndex++
				toolBlocks[tc.Index] = ai
				openBlocks = append(openBlocks, ai)
				if !emit("content_block_start", map[string]any{
					"type": "content_block_start", "index": ai,
					"content_block": map[string]any{
						"type": "tool_use", "id": tc.ID, "name": tc.Function.Name,
						"input": map[string]any{},
					},
				}) {
					interrupted = true
					break
				}
			}
			if tc.Function.Arguments != "" {
				if !emit("content_block_delta", map[string]any{
					"type": "content_block_delta", "index": ai,
					"delta": map[string]any{"type": "input_json_delta", "partial_json": tc.Function.Arguments},
				}) {
					interrupted = true
					break
				}
				if ttft == 0 {
					ttft = int(time.Since(streamStart).Milliseconds())
				}
			}
		}
		if interrupted {
			break
		}
		if ch.FinishReason != nil && *ch.FinishReason != "" {
			stopReason = anthropicStopReason(*ch.FinishReason)
		}
	}

	if interrupted {
		lc.clientDisconnected = true
	} else if err := sc.Err(); err != nil {
		lc.rawErr = "stream: " + err.Error()
	}

	// Close every block still open, in the order they were opened (Anthropic
	// requires content_block_stop in index order).
	if !lc.clientDisconnected {
		sort.Ints(openBlocks)
		for _, idx := range openBlocks {
			emit("content_block_stop", map[string]any{"type": "content_block_stop", "index": idx})
		}
		if stopReason == "" {
			if len(toolBlocks) > 0 {
				stopReason = "tool_use"
			} else {
				stopReason = "end_turn"
			}
		}
		emit("message_delta", map[string]any{
			"type":  "message_delta",
			"delta": map[string]any{"stop_reason": stopReason, "stop_sequence": nil},
			"usage": map[string]any{"input_tokens": usage.TokensIn, "output_tokens": usage.TokensOut},
		})
		emit("message_stop", map[string]any{"type": "message_stop"})
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

// --- helpers ---

// writeAnthropicError answers with the Anthropic error envelope
// ({"type":"error","error":{"type","message"}}), used before a lifecycle
// exists. A zero status is derived from the taxonomy code.
func writeAnthropicError(w http.ResponseWriter, code, message string, status int) {
	if status == 0 {
		status = statusCodeFor(code)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"type":  "error",
		"error": map[string]string{"type": anthropicErrorType(code), "message": message},
	})
}

// writeAnthropicError is the lifecycle-aware form (it also stamps the identity
// headers the caller already armed).
func (lc *lifecycle) writeAnthropicError(code, message string, status int) {
	if status == 0 {
		status = statusCodeFor(code)
	}
	lc.w.Header().Set("Content-Type", "application/json")
	lc.w.WriteHeader(status)
	_ = json.NewEncoder(lc.w).Encode(map[string]any{
		"type":  "error",
		"error": map[string]string{"type": anthropicErrorType(code), "message": message},
	})
}

// anthropicErrorType maps the platform taxonomy onto the Anthropic error class.
func anthropicErrorType(code string) string {
	switch code {
	case routing.ErrCodeAuthError:
		return "authentication_error"
	case routing.ErrCodeAuthorization, routing.ErrCodeContentRejected:
		return "permission_error"
	case routing.ErrCodeRateLimited:
		return "rate_limit_error"
	case routing.ErrCodeModelNotFound:
		return "not_found_error"
	case routing.ErrCodeCircuitOpen:
		return "overloaded_error"
	case routing.ErrCodeProviderTimeout, routing.ErrCodeProviderUnavailable,
		routing.ErrCodeUpstreamError, routing.ErrCodeInternalError:
		return "api_error"
	}
	return "invalid_request_error"
}

// anthropicStopReason maps an [OI] finish_reason onto an Anthropic stop_reason.
func anthropicStopReason(finish string) string {
	switch finish {
	case "length":
		return "max_tokens"
	case "tool_calls", "function_call":
		return "tool_use"
	case "content_filter":
		return "refusal"
	}
	return "end_turn"
}

// anthropicMessageID gives the answer an Anthropic-shaped id.
func anthropicMessageID(upstream string) string {
	upstream = strings.TrimSpace(upstream)
	if upstream == "" {
		return ids.New("msg")
	}
	return "msg_" + upstream
}

// contentString flattens an [OI] message content (a string, or the multimodal
// part array) into text.
func contentString(c any) string {
	switch v := c.(type) {
	case string:
		return v
	case []any:
		var sb strings.Builder
		for _, part := range v {
			if m, ok := part.(map[string]any); ok {
				if s, ok := m["text"].(string); ok {
					sb.WriteString(s)
				}
			}
		}
		return sb.String()
	}
	return ""
}

// rawText flattens an Anthropic `system`/`tool_result` content value (a string,
// or an array of blocks) into text.
func rawText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []map[string]any
	if json.Unmarshal(raw, &blocks) == nil {
		var sb strings.Builder
		for _, b := range blocks {
			if t, ok := b["text"].(string); ok {
				sb.WriteString(t)
			}
		}
		return sb.String()
	}
	return ""
}

// estimateInputTokens is the documented character-based estimate used by
// count_tokens (~4 characters per token plus a small per-message overhead).
func estimateInputTokens(oiBody []byte) int64 {
	var req struct {
		Messages []struct {
			Content any `json:"content"`
		} `json:"messages"`
	}
	if json.Unmarshal(oiBody, &req) != nil {
		return 0
	}
	chars := 0
	for _, m := range req.Messages {
		chars += len([]rune(contentString(m.Content)))
	}
	return int64(chars/charsPerToken + 4*len(req.Messages))
}

// invalidRequest is the shorthand for a 400 INVALID_REQUEST rejection.
func invalidRequest(msg string) *apiError {
	return &apiError{Code: routing.ErrCodeInvalidRequest, Status: http.StatusBadRequest,
		Type: "invalid_request_error", Message: msg}
}
