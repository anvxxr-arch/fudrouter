package proxy

// The Anthropic Messages translation is pure: an inbound Anthropic body becomes
// the [OI] chat body the upstreams speak, and an upstream answer becomes an
// Anthropic Message. These tests pin the mapping both ways — the surface tests
// in anthropic_surface_test.go then prove the lifecycle wires it end to end.

import (
	"encoding/json"
	"strings"
	"testing"
)

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

// decodeOI decodes a translated [OI] body into a generic map.
func decodeOI(t *testing.T, b []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("translated body is not JSON: %v (%s)", err, b)
	}
	return m
}

func TestTranslateAnthropicRequestBasics(t *testing.T) {
	body := []byte(`{
		"model": "gpt-x",
		"max_tokens": 256,
		"temperature": 0.5,
		"top_p": 0.9,
		"stop_sequences": ["END"],
		"system": "be terse",
		"messages": [{"role":"user","content":"hi"}]
	}`)

	slug, oi, stream, apiErr := translateAnthropicRequest(body)
	if apiErr != nil {
		t.Fatalf("unexpected rejection: %+v", apiErr)
	}
	if slug != "gpt-x" {
		t.Errorf("slug = %q, want gpt-x", slug)
	}
	if stream {
		t.Error("stream = true, want false")
	}
	m := decodeOI(t, oi)
	if m["model"] != "gpt-x" {
		t.Errorf("model = %v", m["model"])
	}
	if m["max_tokens"].(float64) != 256 {
		t.Errorf("max_tokens = %v, want 256", m["max_tokens"])
	}
	if m["temperature"].(float64) != 0.5 {
		t.Errorf("temperature = %v", m["temperature"])
	}
	if m["top_p"].(float64) != 0.9 {
		t.Errorf("top_p = %v", m["top_p"])
	}
	stop, ok := m["stop"].([]any)
	if !ok || len(stop) != 1 || stop[0] != "END" {
		t.Errorf("stop = %v, want [END]", m["stop"])
	}
	// The system prompt must be the FIRST message, role "system".
	msgs := m["messages"].([]any)
	if len(msgs) != 2 {
		t.Fatalf("messages len = %d, want 2 (system + user)", len(msgs))
	}
	first := msgs[0].(map[string]any)
	if first["role"] != "system" || first["content"] != "be terse" {
		t.Errorf("first message = %v, want system/be terse", first)
	}
	if msgs[1].(map[string]any)["role"] != "user" {
		t.Errorf("second message role = %v", msgs[1])
	}
}

func TestTranslateAnthropicRequestSystemBlocks(t *testing.T) {
	// Anthropic also allows `system` as an array of text blocks.
	body := []byte(`{
		"model":"m","max_tokens":1,
		"system":[{"type":"text","text":"a"},{"type":"text","text":"b"}],
		"messages":[{"role":"user","content":"x"}]
	}`)
	_, oi, _, apiErr := translateAnthropicRequest(body)
	if apiErr != nil {
		t.Fatalf("unexpected rejection: %+v", apiErr)
	}
	msgs := decodeOI(t, oi)["messages"].([]any)
	first := msgs[0].(map[string]any)
	if first["content"] != "ab" {
		t.Errorf("system content = %v, want ab (blocks joined)", first["content"])
	}
}

func TestTranslateAnthropicRequestStreamingRequestsUsage(t *testing.T) {
	body := []byte(`{"model":"m","max_tokens":1,"stream":true,"messages":[{"role":"user","content":"x"}]}`)
	_, oi, stream, apiErr := translateAnthropicRequest(body)
	if apiErr != nil {
		t.Fatalf("unexpected rejection: %+v", apiErr)
	}
	if !stream {
		t.Fatal("stream = false, want true")
	}
	m := decodeOI(t, oi)
	if m["stream"] != true {
		t.Errorf("stream = %v, want true", m["stream"])
	}
	// Billing needs the usage block, exactly as the native chat path injects it.
	so, ok := m["stream_options"].(map[string]any)
	if !ok || so["include_usage"] != true {
		t.Errorf("stream_options = %v, want include_usage true", m["stream_options"])
	}
}

func TestTranslateAnthropicRequestRejectsBadInput(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"invalid json", `{`},
		{"missing model", `{"max_tokens":1,"messages":[]}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, _, _, apiErr := translateAnthropicRequest([]byte(tc.body))
			if apiErr == nil {
				t.Fatal("expected a rejection, got none")
			}
			if apiErr.Status != 400 {
				t.Errorf("status = %d, want 400", apiErr.Status)
			}
		})
	}
}

func TestTranslateAnthropicToolUseAndResults(t *testing.T) {
	// A full agentic turn: assistant tool_use, then a user tool_result. The
	// tool result must become its own role:"tool" message.
	body := []byte(`{
		"model":"m","max_tokens":1,
		"messages":[
			{"role":"user","content":"what is 2+2"},
			{"role":"assistant","content":[
				{"type":"text","text":"let me check"},
				{"type":"tool_use","id":"tu_1","name":"calc","input":{"expr":"2+2"}}
			]},
			{"role":"user","content":[
				{"type":"tool_result","tool_use_id":"tu_1","content":[{"type":"text","text":"4"}]}
			]}
		]
	}`)
	_, oi, _, apiErr := translateAnthropicRequest(body)
	if apiErr != nil {
		t.Fatalf("unexpected rejection: %+v", apiErr)
	}
	msgs := decodeOI(t, oi)["messages"].([]any)
	// Three turns: the user question, the assistant turn carrying the
	// tool_call, and the tool result. The tool_result-only message used to
	// also emit a trailing empty role:"user" placeholder, because the
	// converter appended the results before a mutually-exclusive switch that
	// still ran its default branch — a phantom turn upstreams have to ignore.
	if len(msgs) != 3 {
		t.Fatalf("messages len = %d, want 3 (user, assistant+toolcall, tool)", len(msgs))
	}
	asst := msgs[1].(map[string]any)
	if asst["role"] != "assistant" {
		t.Errorf("msgs[1].role = %v", asst["role"])
	}
	if asst["content"] != "let me check" {
		t.Errorf("assistant content = %v", asst["content"])
	}
	tcs, ok := asst["tool_calls"].([]any)
	if !ok || len(tcs) != 1 {
		t.Fatalf("tool_calls = %v, want 1 entry", asst["tool_calls"])
	}
	fn := tcs[0].(map[string]any)["function"].(map[string]any)
	if fn["name"] != "calc" {
		t.Errorf("tool name = %v", fn["name"])
	}
	if fn["arguments"] != `{"expr":"2+2"}` {
		t.Errorf("tool arguments = %v, want the input JSON", fn["arguments"])
	}
	toolMsg := msgs[2].(map[string]any)
	if toolMsg["role"] != "tool" || toolMsg["tool_call_id"] != "tu_1" || toolMsg["content"] != "4" {
		t.Errorf("tool result message = %v, want role:tool id:tu_1 content:4", toolMsg)
	}
}

func TestTranslateAnthropicToolsDeclarations(t *testing.T) {
	body := []byte(`{
		"model":"m","max_tokens":1,
		"messages":[{"role":"user","content":"x"}],
		"tools":[{"name":"calc","description":"math","input_schema":{"type":"object","properties":{"expr":{"type":"string"}}}}],
		"tool_choice":{"type":"tool","name":"calc"}
	}`)
	_, oi, _, apiErr := translateAnthropicRequest(body)
	if apiErr != nil {
		t.Fatalf("unexpected rejection: %+v", apiErr)
	}
	m := decodeOI(t, oi)
	tools := m["tools"].([]any)
	fn := tools[0].(map[string]any)["function"].(map[string]any)
	if fn["name"] != "calc" || fn["description"] != "math" {
		t.Errorf("tool = %v", fn)
	}
	if _, ok := fn["parameters"].(map[string]any); !ok {
		t.Errorf("parameters missing: %v", fn["parameters"])
	}
	tc := m["tool_choice"].(map[string]any)
	if tc["type"] != "function" {
		t.Errorf("tool_choice = %v, want a function object", tc)
	}
}

func TestTranslateAnthropicImageBlock(t *testing.T) {
	body := []byte(`{
		"model":"m","max_tokens":1,
		"messages":[{"role":"user","content":[
			{"type":"text","text":"what is this"},
			{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}
		]}]
	}`)
	_, oi, _, apiErr := translateAnthropicRequest(body)
	if apiErr != nil {
		t.Fatalf("unexpected rejection: %+v", apiErr)
	}
	msgs := decodeOI(t, oi)["messages"].([]any)
	content := msgs[0].(map[string]any)["content"].([]any)
	if len(content) != 2 {
		t.Fatalf("content parts = %d, want 2", len(content))
	}
	if content[0].(map[string]any)["type"] != "text" {
		t.Errorf("part 0 = %v", content[0])
	}
	img := content[1].(map[string]any)
	if img["type"] != "image_url" {
		t.Fatalf("part 1 = %v, want image_url", img)
	}
	url := img["image_url"].(map[string]any)["url"].(string)
	if !strings.HasPrefix(url, "data:image/png;base64,") {
		t.Errorf("image url = %q, want a data URL", url)
	}
}

func TestOpenAIToAnthropicTextAndUsage(t *testing.T) {
	up := []byte(`{
		"id":"chatcmpl-9",
		"choices":[{"message":{"role":"assistant","content":"hello there"},"finish_reason":"stop"}],
		"usage":{"prompt_tokens":11,"completion_tokens":3}
	}`)
	out, apiErr := openAIToAnthropic(up, "gpt-x")
	if apiErr != nil {
		t.Fatalf("unexpected error: %+v", apiErr)
	}
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatalf("out is not JSON: %v", err)
	}
	if m["type"] != "message" || m["role"] != "assistant" {
		t.Errorf("envelope = %v", m)
	}
	if m["model"] != "gpt-x" {
		t.Errorf("model = %v, want the requested slug", m["model"])
	}
	if m["stop_reason"] != "end_turn" {
		t.Errorf("stop_reason = %v, want end_turn", m["stop_reason"])
	}
	blocks := m["content"].([]any)
	if len(blocks) != 1 || blocks[0].(map[string]any)["type"] != "text" {
		t.Fatalf("content = %v, want one text block", blocks)
	}
	if blocks[0].(map[string]any)["text"] != "hello there" {
		t.Errorf("text = %v", blocks[0])
	}
	u := m["usage"].(map[string]any)
	if u["input_tokens"].(float64) != 11 || u["output_tokens"].(float64) != 3 {
		t.Errorf("usage = %v, want in:11 out:3", u)
	}
	if !strings.HasPrefix(m["id"].(string), "msg_") {
		t.Errorf("id = %v, want an msg_ prefix", m["id"])
	}
}

func TestOpenAIToAnthropicToolCalls(t *testing.T) {
	up := []byte(`{
		"id":"chatcmpl-9",
		"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[
			{"id":"call_1","type":"function","function":{"name":"calc","arguments":"{\"expr\":\"2+2\"}"}}
		]},"finish_reason":"tool_calls"}],
		"usage":{"prompt_tokens":5,"completion_tokens":7}
	}`)
	out, apiErr := openAIToAnthropic(up, "m")
	if apiErr != nil {
		t.Fatalf("unexpected error: %+v", apiErr)
	}
	var m map[string]any
	_ = json.Unmarshal(out, &m)
	if m["stop_reason"] != "tool_use" {
		t.Errorf("stop_reason = %v, want tool_use", m["stop_reason"])
	}
	blocks := m["content"].([]any)
	if len(blocks) != 1 {
		t.Fatalf("content = %v, want one tool_use block", blocks)
	}
	tu := blocks[0].(map[string]any)
	if tu["type"] != "tool_use" || tu["id"] != "call_1" || tu["name"] != "calc" {
		t.Errorf("tool_use block = %v", tu)
	}
	input := tu["input"].(map[string]any)
	if input["expr"] != "2+2" {
		t.Errorf("input = %v, want the parsed arguments", input)
	}
}

func TestOpenAIToAnthropicErrors(t *testing.T) {
	if _, apiErr := openAIToAnthropic([]byte(`not json`), "m"); apiErr == nil {
		t.Error("non-JSON upstream must error")
	}
	if _, apiErr := openAIToAnthropic([]byte(`{"choices":[]}`), "m"); apiErr == nil {
		t.Error("no choices must error")
	}
}

func TestAnthropicStopReason(t *testing.T) {
	cases := map[string]string{
		"stop":           "end_turn",
		"length":         "max_tokens",
		"tool_calls":     "tool_use",
		"function_call":  "tool_use",
		"content_filter": "refusal",
		"":               "end_turn",
	}
	for in, want := range cases {
		if got := anthropicStopReason(in); got != want {
			t.Errorf("anthropicStopReason(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestAnthropicErrorType(t *testing.T) {
	cases := map[string]string{
		"AUTHENTICATION_ERROR": "authentication_error",
		"AUTHORIZATION_ERROR":  "permission_error",
		"CONTENT_REJECTED":     "permission_error",
		"RATE_LIMITED":         "rate_limit_error",
		"MODEL_NOT_FOUND":      "not_found_error",
		"CIRCUIT_OPEN":         "overloaded_error",
		"PROVIDER_TIMEOUT":     "api_error",
		"UPSTREAM_ERROR":       "api_error",
		"INTERNAL_ERROR":       "api_error",
		"INVALID_REQUEST":      "invalid_request_error",
		"SOMETHING_UNKNOWN":    "invalid_request_error",
	}
	for in, want := range cases {
		if got := anthropicErrorType(in); got != want {
			t.Errorf("anthropicErrorType(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestEstimateInputTokens(t *testing.T) {
	body := mustJSON(t, map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": "aaaa bbbb cccc dddd"},
		},
	})
	n := estimateInputTokens(body)
	// 19 runes / 4 = 4, plus 4 per message = 8.
	if n != 8 {
		t.Errorf("estimateInputTokens = %d, want 8", n)
	}
}

func TestToolChoiceToChat(t *testing.T) {
	cases := []struct {
		raw  string
		want any
	}{
		{`{"type":"auto"}`, "auto"},
		{`{"type":"any"}`, "required"},
		{`{"type":"none"}`, "none"},
		{``, nil},
	}
	for _, tc := range cases {
		got := toolChoiceToOpenAI(json.RawMessage(tc.raw))
		if got != tc.want {
			t.Errorf("toolChoiceToOpenAI(%s) = %v, want %v", tc.raw, got, tc.want)
		}
	}
	if got := toolChoiceToOpenAI(json.RawMessage(`{"type":"tool","name":"x"}`)); got == nil {
		t.Error("a named tool_choice must map to a function object")
	}
}

// TestTranslateAnthropicRejectsToolResultWithoutID pins that a tool_result
// block with no usable tool_use_id is REJECTED at translation time.
//
// The converter used to read the field with a bare type assertion and forward
// whatever it got, so a missing or non-string id produced
// `{"role":"tool","tool_call_id":""}` — which every [OI] upstream rejects with
// a 400 the client cannot act on, because the client never sent an empty id.
// Rejecting here names the malformed block in the router's own envelope.
func TestTranslateAnthropicRejectsToolResultWithoutID(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
	}{
		{"missing id", `{
			"model":"m","max_tokens":1,
			"messages":[
				{"role":"user","content":"go"},
				{"role":"assistant","content":[
					{"type":"tool_use","id":"tu_1","name":"calc","input":{"x":1}}
				]},
				{"role":"user","content":[
					{"type":"tool_result","content":"orphan"}
				]}
			]
		}`},
		{"non-string id", `{
			"model":"m","max_tokens":1,
			"messages":[
				{"role":"user","content":"go"},
				{"role":"assistant","content":[
					{"type":"tool_use","id":"tu_1","name":"calc","input":{"x":1}}
				]},
				{"role":"user","content":[
					{"type":"tool_result","tool_use_id":7,"content":"orphan"}
				]}
			]
		}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, _, _, apiErr := translateAnthropicRequest([]byte(tc.body))
			if apiErr == nil {
				t.Fatal("a tool_result with no usable tool_use_id must be rejected, not forwarded")
			}
			if apiErr.Status != 400 {
				t.Errorf("status = %d, want 400", apiErr.Status)
			}
			if !strings.Contains(apiErr.Message, "tool_use_id") {
				t.Errorf("message = %q, want it to name tool_use_id", apiErr.Message)
			}
		})
	}
}

// TestTranslateAnthropicToolResultsFollowTheirToolCalls pins emission ORDER.
//
// A single Anthropic message may legally carry text + tool_use + tool_result.
// The converter used to append every collected tool_result BEFORE the assistant
// message that declares the matching tool_calls, so the [OI] body arrived with
// role:"tool" messages ahead of the assistant turn they answer — an ordering
// every [OI] upstream rejects. Tool results must be emitted after the assistant
// message carrying the tool_calls they reference.
func TestTranslateAnthropicToolResultsFollowTheirToolCalls(t *testing.T) {
	body := []byte(`{
		"model":"m","max_tokens":1,
		"messages":[
			{"role":"user","content":"go"},
			{"role":"assistant","content":[
				{"type":"text","text":"checking"},
				{"type":"tool_use","id":"tu_1","name":"calc","input":{"x":1}}
			]},
			{"role":"user","content":[
				{"type":"text","text":"here you go"},
				{"type":"tool_use","id":"tu_2","name":"calc","input":{"x":2}},
				{"type":"tool_result","tool_use_id":"tu_1","content":"one"},
				{"type":"tool_result","tool_use_id":"tu_2","content":"two"}
			]}
		]
	}`)
	_, oi, _, apiErr := translateAnthropicRequest(body)
	if apiErr != nil {
		t.Fatalf("unexpected rejection: %+v", apiErr)
	}
	msgs := decodeOI(t, oi)["messages"].([]any)

	// Every role:"tool" message must come after an assistant message that
	// declares a tool_call with that id.
	declared := map[string]bool{}
	for i, raw := range msgs {
		m, ok := raw.(map[string]any)
		if !ok {
			t.Fatalf("msgs[%d] is not an object", i)
		}
		role, _ := m["role"].(string)
		if role == "assistant" {
			if tcs, ok := m["tool_calls"].([]any); ok {
				for _, tc := range tcs {
					if id, ok := tc.(map[string]any)["id"].(string); ok {
						declared[id] = true
					}
				}
			}
			continue
		}
		if role != "tool" {
			continue
		}
		id, _ := m["tool_call_id"].(string)
		if id == "" {
			t.Errorf("msgs[%d] role:tool has an empty tool_call_id", i)
			continue
		}
		if !declared[id] {
			t.Errorf("msgs[%d] role:tool tool_call_id=%q precedes the assistant message that declares it", i, id)
		}
	}
}
