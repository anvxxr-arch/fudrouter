// gemini.go — the Google Gemini API (/v1beta) as a NATIVE inbound surface.
//
// The data plane speaks [OI] chat completions upstream. This file adds
//
//	GET  /v1beta/models                              catalogue
//	GET  /v1beta/models/{model}                       one model
//	POST /v1beta/models/{model}:generateContent       buffered answer
//	POST /v1beta/models/{model}:streamGenerateContent SSE answer
//	POST /v1beta/models/{model}:countTokens           estimate
//
// so a client built on the Google SDKs — google-generativeai, @google/genai,
// Gemini CLI, anything that reads GEMINI_API_KEY — can point its base URL at
// the router unchanged, the same way anthropic.go serves /v1/messages.
//
// The translation is stateless and WRAPS the shared lifecycle: the Gemini body
// is rewritten to an [OI] chat request, the request runs through
// begin/dispatch (auth → limits → budget → routing → failover → billing)
// exactly like the native chat path, and the upstream answer is rewritten back
// into the Gemini wire shape. Billing, the ledger and the error taxonomy are
// NOT re-implemented: a generateContent call is billed and logged like any
// other chat. Rejections are shaped by lifecycle.wire == "gemini".
package proxy

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/routing"
)

// --- request shapes (the subset the router models) ---

// geminiRequest is the subset of a Gemini generateContent body the router
// translates. Unknown fields (safetySettings, cachedContent, thinkingConfig…)
// are ignored rather than rejected, so a client that sends more still works.
type geminiRequest struct {
	Contents           []geminiContent  `json:"contents"`
	SystemInstruction  *geminiContent   `json:"systemInstruction"`
	SystemInstruction2 *geminiContent   `json:"system_instruction"` // v1 spelling
	GenerationConfig   *geminiGenConfig `json:"generationConfig"`
	Tools              []geminiTool     `json:"tools"`
	ToolConfig         json.RawMessage  `json:"toolConfig"`
}

type geminiContent struct {
	Role  string       `json:"role"`
	Parts []geminiPart `json:"parts"`
}

type geminiPart struct {
	Text             string                `json:"text"`
	InlineData       *geminiBlob           `json:"inlineData"`
	InlineDataSnake  *geminiBlob           `json:"inline_data"`
	FileData         *geminiFile           `json:"fileData"`
	FunctionCall     *geminiFunctionCall   `json:"functionCall"`
	FunctionResponse *geminiFunctionResult `json:"functionResponse"`
}

type geminiBlob struct {
	MimeType string `json:"mimeType"`
	Data     string `json:"data"`
}

type geminiFile struct {
	MimeType string `json:"mimeType"`
	FileURI  string `json:"fileUri"`
}

type geminiFunctionCall struct {
	Name string          `json:"name"`
	Args json.RawMessage `json:"args"`
}

type geminiFunctionResult struct {
	Name     string          `json:"name"`
	Response json.RawMessage `json:"response"`
}

type geminiGenConfig struct {
	MaxOutputTokens  int64    `json:"maxOutputTokens"`
	Temperature      *float64 `json:"temperature"`
	TopP             *float64 `json:"topP"`
	TopK             *int     `json:"topK"`
	StopSequences    []string `json:"stopSequences"`
	CandidateCount   int      `json:"candidateCount"`
	ResponseMimeType string   `json:"responseMimeType"`
}

type geminiTool struct {
	FunctionDeclarations []geminiFunctionDecl `json:"functionDeclarations"`
}

type geminiFunctionDecl struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

// --- entry points ---

// ServeGemini dispatches everything under /v1beta/models/.
//
// Gemini puts the verb in the path segment ("models/gemini-x:generateContent")
// rather than in a separate route, so one handler parses the suffix. Methods
// other than the five below answer 404 with the Google error envelope, so an
// SDK probing an unimplemented verb fails loudly instead of silently.
func (h *Handler) ServeGemini(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/v1beta/models/")
	if rest == "" || rest == r.URL.Path {
		writeGeminiError(w, routing.ErrCodeInvalidRequest, "missing model", 0)
		return
	}
	model, verb := rest, ""
	if i := strings.LastIndex(rest, ":"); i > 0 {
		model, verb = rest[:i], rest[i+1:]
	}
	model = strings.TrimPrefix(model, "models/")
	if model == "" {
		writeGeminiError(w, routing.ErrCodeInvalidRequest, "missing model", 0)
		return
	}

	switch {
	case r.Method == http.MethodPost && verb == "generateContent":
		h.serveGeminiGenerate(w, r, model, false)
	case r.Method == http.MethodPost && verb == "streamGenerateContent":
		// Gemini's own streaming default is a JSON array on one response; SSE is
		// the `alt=sse` form and the only one every SDK accepts, so the router
		// always answers SSE regardless of the alt parameter.
		h.serveGeminiGenerate(w, r, model, true)
	case r.Method == http.MethodPost && verb == "countTokens":
		h.serveGeminiCountTokens(w, r, model)
	case r.Method == http.MethodGet && verb == "":
		h.serveGeminiModel(w, r, model)
	default:
		writeGeminiError(w, routing.ErrCodeInvalidRequest,
			fmt.Sprintf("unsupported method %s %s on /v1beta/models", r.Method, verb), 0)
	}
}

// ServeGeminiModels answers GET /v1beta/models with the published catalogue in
// the Gemini list shape.
func (h *Handler) ServeGeminiModels(w http.ResponseWriter, r *http.Request) {
	body, ok := h.renderedModels(r.Context())
	if !ok {
		writeGeminiError(w, routing.ErrCodeInternalError, "database error", 0)
		return
	}
	var list struct {
		Data []map[string]any `json:"data"`
	}
	if json.Unmarshal(body, &list) != nil {
		writeGeminiError(w, routing.ErrCodeInternalError, "cannot render catalogue", 0)
		return
	}
	models := make([]any, 0, len(list.Data))
	for _, m := range list.Data {
		slug, _ := m["id"].(string)
		if slug == "" {
			continue
		}
		models = append(models, geminiModelObject(slug, m))
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"models": models})
}

// serveGeminiModel answers GET /v1beta/models/{model} for a published slug.
func (h *Handler) serveGeminiModel(w http.ResponseWriter, r *http.Request, model string) {
	body, ok := h.renderedModels(r.Context())
	if !ok {
		writeGeminiError(w, routing.ErrCodeInternalError, "database error", 0)
		return
	}
	var list struct {
		Data []map[string]any `json:"data"`
	}
	if json.Unmarshal(body, &list) != nil {
		writeGeminiError(w, routing.ErrCodeInternalError, "cannot render catalogue", 0)
		return
	}
	for _, m := range list.Data {
		if slug, _ := m["id"].(string); slug == model {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(geminiModelObject(slug, m))
			return
		}
	}
	writeGeminiError(w, routing.ErrCodeModelNotFound, "model not found: "+model, 0)
}

// geminiModelObject maps one [OI] model object onto the Gemini model shape.
func geminiModelObject(slug string, m map[string]any) map[string]any {
	display := slug
	if n, ok := m["name"].(string); ok && n != "" {
		display = n
	}
	obj := map[string]any{
		"name":                       "models/" + slug,
		"displayName":                display,
		"description":                "",
		"supportedGenerationMethods": []string{"generateContent", "streamGenerateContent", "countTokens"},
	}
	if ctx, ok := m["context_window"]; ok {
		obj["inputTokenLimit"] = ctx
	}
	if out, ok := m["max_output_tokens"]; ok {
		obj["outputTokenLimit"] = out
	}
	return obj
}

// serveGeminiGenerate handles :generateContent and :streamGenerateContent.
func (h *Handler) serveGeminiGenerate(w http.ResponseWriter, r *http.Request, model string, stream bool) {
	start := time.Now()

	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBytes))
	if err != nil {
		writeGeminiError(w, routing.ErrCodeInvalidRequest, "cannot read body", 0)
		return
	}

	var oiBody []byte
	validate := func(b []byte) (string, *apiError) {
		oi, apiErr := translateGeminiRequest(b, model, stream)
		if apiErr != nil {
			return "", apiErr
		}
		oiBody = oi
		return model, nil
	}

	lc, ok := h.begin(w, r, start, "/v1beta/models/"+model+":generateContent", body, validate, "gemini")
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
		lc.geminiStreamSSE(w, resp.Body, model)
		return
	}

	respBody, err := lc.readUpstreamBody(resp)
	if err != nil {
		lc.fail(fmt.Errorf("read upstream: %w", err))
		return
	}
	lc.serveGeminiBuffered(w, respBody, model)
}

// serveGeminiCountTokens answers :countTokens with the same documented estimate
// the Anthropic surface uses (no upstream in the pool ships a Gemini tokenizer,
// and billing never reads this number).
func (h *Handler) serveGeminiCountTokens(w http.ResponseWriter, r *http.Request, model string) {
	if _, err := h.authenticate(r); err != nil {
		writeGeminiError(w, routing.ErrCodeAuthError, err.Error(), 0)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBytes))
	if err != nil {
		writeGeminiError(w, routing.ErrCodeInvalidRequest, "cannot read body", 0)
		return
	}
	oi, apiErr := translateGeminiRequest(body, model, false)
	if apiErr != nil {
		writeGeminiError(w, apiErr.Code, apiErr.Message, apiErr.Status)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"totalTokens": estimateInputTokens(oi),
	})
}

// --- Gemini → [OI] ---

// translateGeminiRequest rewrites a Gemini generateContent body into the [OI]
// chat body the upstreams speak. `model` is the slug from the path; the body
// carries no model field, which is the one structural difference from the
// Anthropic surface.
func translateGeminiRequest(body []byte, model string, stream bool) ([]byte, *apiError) {
	var req geminiRequest
	if err := json.Unmarshal(body, &req); err != nil {
		return nil, invalidRequest("invalid JSON body")
	}
	if len(req.Contents) == 0 {
		return nil, invalidRequest("contents is required")
	}

	msgs := make([]any, 0, len(req.Contents)+1)
	sys := req.SystemInstruction
	if sys == nil {
		sys = req.SystemInstruction2
	}
	if sys != nil {
		if text := geminiPartsText(sys.Parts); text != "" {
			msgs = append(msgs, map[string]any{"role": "system", "content": text})
		}
	}

	for _, c := range req.Contents {
		converted, apiErr := geminiContentToOpenAI(c)
		if apiErr != nil {
			return nil, apiErr
		}
		msgs = append(msgs, converted...)
	}

	out := map[string]any{"model": model, "messages": msgs}
	if gc := req.GenerationConfig; gc != nil {
		if gc.MaxOutputTokens > 0 {
			out["max_tokens"] = gc.MaxOutputTokens
		}
		if gc.Temperature != nil {
			out["temperature"] = *gc.Temperature
		}
		if gc.TopP != nil {
			out["top_p"] = *gc.TopP
		}
		// topK has no [OI] spelling on most upstreams; forwarding it as an
		// unknown field is safer than dropping the client's intent silently
		// only where the upstream models it — so it is passed through.
		if gc.TopK != nil {
			out["top_k"] = *gc.TopK
		}
		if len(gc.StopSequences) > 0 {
			out["stop"] = gc.StopSequences
		}
		// responseMimeType application/json is the Gemini way of asking for a
		// JSON object; [OI] spells that response_format.
		if strings.Contains(gc.ResponseMimeType, "json") {
			out["response_format"] = map[string]any{"type": "json_object"}
		}
	}

	// Declarations from every tools[] entry are merged: Gemini groups them per
	// tool, [OI] carries one flat list.
	var tools []any
	for _, t := range req.Tools {
		for _, fd := range t.FunctionDeclarations {
			params := any(map[string]any{"type": "object"})
			if len(fd.Parameters) > 0 {
				_ = json.Unmarshal(fd.Parameters, &params)
			}
			fn := map[string]any{"name": fd.Name, "parameters": params}
			if fd.Description != "" {
				fn["description"] = fd.Description
			}
			tools = append(tools, map[string]any{"type": "function", "function": fn})
		}
	}
	if len(tools) > 0 {
		out["tools"] = tools
	}

	if stream {
		// Gemini streaming is per-verb, so the body has no stream flag of its
		// own: the router asks the upstream to stream and for the trailing
		// usage chunk, which becomes the final event's usageMetadata.
		out["stream"] = true
		out["stream_options"] = map[string]any{"include_usage": true}
	}

	encoded, err := json.Marshal(out)
	if err != nil {
		return nil, invalidRequest("cannot encode request")
	}
	return encoded, nil
}

// geminiContentToOpenAI converts ONE Gemini content object into one or more
// [OI] messages. A functionResponse turn becomes a `role:"tool"` message and a
// functionCall turn becomes an assistant `tool_calls` message, mirroring how
// anthropicMessageToOpenAI keeps the declaration before its answer.
func geminiContentToOpenAI(c geminiContent) ([]any, *apiError) {
	role := c.Role
	switch role {
	case "model":
		role = "assistant"
	case "", "user":
		role = "user"
	case "function", "tool":
		role = "tool"
	}

	var textParts []string
	var images []any
	var toolCalls []any
	var toolResults []any
	for _, p := range c.Parts {
		if p.Text != "" {
			textParts = append(textParts, p.Text)
		}
		blob := p.InlineData
		if blob == nil {
			blob = p.InlineDataSnake
		}
		if blob != nil && blob.Data != "" {
			mime := blob.MimeType
			if mime == "" {
				mime = "image/png"
			}
			images = append(images, map[string]any{
				"type":      "image_url",
				"image_url": map[string]any{"url": "data:" + mime + ";base64," + blob.Data},
			})
		}
		if p.FileData != nil && p.FileData.FileURI != "" {
			images = append(images, map[string]any{
				"type":      "image_url",
				"image_url": map[string]any{"url": p.FileData.FileURI},
			})
		}
		if p.FunctionCall != nil {
			args := "{}"
			if len(p.FunctionCall.Args) > 0 {
				args = string(p.FunctionCall.Args)
			}
			toolCalls = append(toolCalls, map[string]any{
				"id": "call_" + p.FunctionCall.Name, "type": "function",
				"function": map[string]any{"name": p.FunctionCall.Name, "arguments": args},
			})
		}
		if p.FunctionResponse != nil {
			content := "{}"
			if len(p.FunctionResponse.Response) > 0 {
				content = string(p.FunctionResponse.Response)
			}
			toolResults = append(toolResults, map[string]any{
				"role": "tool", "tool_call_id": "call_" + p.FunctionResponse.Name, "content": content,
			})
		}
	}

	var out []any
	switch {
	case len(toolCalls) > 0:
		msg := map[string]any{"role": "assistant", "tool_calls": toolCalls}
		if len(textParts) > 0 {
			msg["content"] = strings.Join(textParts, "")
		} else {
			msg["content"] = nil
		}
		out = append(out, msg)
		out = append(out, toolResults...)
	case len(images) > 0:
		content := make([]any, 0, len(images)+1)
		if len(textParts) > 0 {
			content = append(content, map[string]any{"type": "text", "text": strings.Join(textParts, "")})
		}
		content = append(content, images...)
		out = append(out, map[string]any{"role": role, "content": content})
		out = append(out, toolResults...)
	case len(toolResults) > 0:
		out = append(out, toolResults...)
	case len(textParts) > 0:
		out = append(out, map[string]any{"role": role, "content": strings.Join(textParts, "")})
	default:
		out = append(out, map[string]any{"role": role, "content": ""})
	}
	return out, nil
}

// geminiPartsText flattens a parts array into plain text (systemInstruction
// carries no other part type that maps onto [OI]).
func geminiPartsText(parts []geminiPart) string {
	var sb strings.Builder
	for _, p := range parts {
		sb.WriteString(p.Text)
	}
	return sb.String()
}

// --- [OI] → Gemini ---

// openAIToGemini rewrites a buffered [OI] chat response into a Gemini
// GenerateContentResponse.
func openAIToGemini(body []byte, model string) ([]byte, *apiError) {
	var resp struct {
		Choices []struct {
			Message struct {
				Content   any `json:"content"`
				ToolCalls []struct {
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

	parts := make([]any, 0, 1+len(ch.Message.ToolCalls))
	if text := contentString(ch.Message.Content); text != "" {
		parts = append(parts, map[string]any{"text": text})
	}
	for _, tc := range ch.Message.ToolCalls {
		var args any = map[string]any{}
		if tc.Function.Arguments != "" {
			if json.Unmarshal([]byte(tc.Function.Arguments), &args) != nil {
				args = map[string]any{}
			}
		}
		parts = append(parts, map[string]any{
			"functionCall": map[string]any{"name": tc.Function.Name, "args": args},
		})
	}
	if len(parts) == 0 {
		parts = append(parts, map[string]any{"text": ""})
	}

	usage := map[string]any{"promptTokenCount": 0, "candidatesTokenCount": 0, "totalTokenCount": 0}
	if resp.Usage != nil {
		u := resp.Usage.counts()
		usage["promptTokenCount"] = u.TokensIn
		usage["candidatesTokenCount"] = u.TokensOut
		total := u.TotalTokens
		if total == 0 {
			total = u.TokensIn + u.TokensOut
		}
		usage["totalTokenCount"] = total
	}

	out := map[string]any{
		"candidates": []any{map[string]any{
			"content":      map[string]any{"parts": parts, "role": "model"},
			"finishReason": geminiFinishReason(ch.FinishReason),
			"index":        0,
		}},
		"usageMetadata": usage,
		"modelVersion":  model,
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		return nil, &apiError{Code: routing.ErrCodeInternalError, Status: 500,
			Type: "api_error", Message: "cannot encode response"}
	}
	return encoded, nil
}

// serveGeminiBuffered writes a buffered Gemini answer and records usage.
func (lc *lifecycle) serveGeminiBuffered(w http.ResponseWriter, oiBody []byte, model string) {
	lc.usage, lc.usageSeen = parseUsage(oiBody)

	translated, apiErr := openAIToGemini(oiBody, model)
	if apiErr != nil {
		lc.errCode, lc.errMsg = apiErr.Code, apiErr.Message
		lc.status = statusForErrCode(apiErr.Code)
		lc.httpStat = apiErr.Status
		lc.setResponseHeaders()
		lc.writeGeminiError(apiErr.Code, apiErr.Message, apiErr.Status)
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

// geminiStreamSSE relays an [OI] SSE stream as a Gemini SSE stream.
//
// Gemini sends one GenerateContentResponse per event with a partial candidate;
// the last event carries finishReason and usageMetadata. Readers concatenate
// candidates[0].content.parts[*].text, which is exactly what this emits.
func (lc *lifecycle) geminiStreamSSE(w http.ResponseWriter, body io.Reader, model string) {
	flusher, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	lc.setResponseHeaders()
	w.WriteHeader(http.StatusOK)

	emit := func(payload any) bool {
		b, _ := json.Marshal(payload)
		if _, err := fmt.Fprintf(w, "data: %s\n\n", b); err != nil {
			return false
		}
		if flusher != nil {
			flusher.Flush()
		}
		return true
	}

	streamStart := time.Now()
	var (
		usage       usageCounts
		usageSeen   bool
		finish      string
		toolNames   []string
		interrupted bool
		ttft        int
	)

	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		line := sc.Text()
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

		parts := make([]any, 0, 1+len(ch.Delta.ToolCalls))
		if ch.Delta.Content != "" {
			parts = append(parts, map[string]any{"text": ch.Delta.Content})
		}
		for _, tc := range ch.Delta.ToolCalls {
			if tc.Function.Name != "" {
				toolNames = append(toolNames, tc.Function.Name)
			}
			args := any(map[string]any{})
			if tc.Function.Arguments != "" {
				if json.Unmarshal([]byte(tc.Function.Arguments), &args) != nil {
					args = map[string]any{}
				}
			}
			parts = append(parts, map[string]any{
				"functionCall": map[string]any{"name": tc.Function.Name, "args": args},
			})
		}
		if len(parts) == 0 {
			continue
		}
		if !emit(map[string]any{
			"candidates": []any{map[string]any{
				"content": map[string]any{"parts": parts, "role": "model"},
				"index":   0,
			}},
			"modelVersion": model,
		}) {
			interrupted = true
			break
		}
		if ttft == 0 {
			ttft = int(time.Since(streamStart).Milliseconds())
		}
		if ch.FinishReason != nil && *ch.FinishReason != "" {
			finish = *ch.FinishReason
		}
	}

	if interrupted {
		lc.clientDisconnected = true
	} else if err := sc.Err(); err != nil {
		lc.rawErr = "stream: " + err.Error()
	}

	if !lc.clientDisconnected {
		final := map[string]any{
			"candidates": []any{map[string]any{
				"content":      map[string]any{"parts": []any{}, "role": "model"},
				"finishReason": geminiFinishReason(finish),
				"index":        0,
			}},
			"modelVersion": model,
		}
		if usageSeen {
			total := usage.TotalTokens
			if total == 0 {
				total = usage.TokensIn + usage.TokensOut
			}
			final["usageMetadata"] = map[string]any{
				"promptTokenCount":     usage.TokensIn,
				"candidatesTokenCount": usage.TokensOut,
				"totalTokenCount":      total,
			}
		}
		emit(final)
	}

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

// geminiFinishReason maps an [OI] finish_reason onto the Gemini enum.
func geminiFinishReason(finish string) string {
	switch finish {
	case "length":
		return "MAX_TOKENS"
	case "content_filter":
		return "SAFETY"
	case "":
		return ""
	}
	return "STOP"
}

// geminiStatus maps the platform taxonomy onto the Google RPC status string.
func geminiStatus(code string) string {
	switch code {
	case routing.ErrCodeAuthError:
		return "UNAUTHENTICATED"
	case routing.ErrCodeAuthorization, routing.ErrCodeContentRejected:
		return "PERMISSION_DENIED"
	case routing.ErrCodeRateLimited:
		return "RESOURCE_EXHAUSTED"
	case routing.ErrCodeModelNotFound:
		return "NOT_FOUND"
	case routing.ErrCodeCircuitOpen, routing.ErrCodeProviderUnavailable:
		return "UNAVAILABLE"
	case routing.ErrCodeProviderTimeout:
		return "DEADLINE_EXCEEDED"
	case routing.ErrCodeInvalidRequest, routing.ErrCodeContextTooLong,
		routing.ErrCodeUnsupportedParam:
		return "INVALID_ARGUMENT"
	case routing.ErrCodeInsufficientCredits:
		// Google has no "pay me" status; RESOURCE_EXHAUSTED is the one a Gemini
		// SDK surfaces as a retryable quota problem rather than a crash.
		return "RESOURCE_EXHAUSTED"
	}
	return "INTERNAL"
}

// geminiErrorBody is the Google error envelope body.
func geminiErrorBody(code, message string) map[string]any {
	return map[string]any{
		"error": map[string]any{
			"code":    geminiHTTPStatus(code),
			"message": message,
			"status":  geminiStatus(code),
		},
	}
}

// geminiHTTPStatus is the numeric HTTP code the envelope repeats.
func geminiHTTPStatus(code string) int {
	return statusCodeFor(code)
}

// writeGeminiError answers in the Google error envelope before a lifecycle
// exists (a zero status is derived from the taxonomy code).
func writeGeminiError(w http.ResponseWriter, code, message string, status int) {
	if status == 0 {
		status = statusCodeFor(code)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(geminiErrorBody(code, message))
}

// writeGeminiError is the lifecycle-aware form.
func (lc *lifecycle) writeGeminiError(code, message string, status int) {
	if status == 0 {
		status = statusCodeFor(code)
	}
	lc.w.Header().Set("Content-Type", "application/json")
	lc.w.WriteHeader(status)
	_ = json.NewEncoder(lc.w).Encode(geminiErrorBody(code, message))
}
