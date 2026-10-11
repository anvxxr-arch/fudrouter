package proxy

import (
	"encoding/json"
	"testing"
)

// referenceRewrite is the pre-optimisation implementation: always unmarshal,
// always re-marshal. It is the oracle for the byte-level behaviour of
// rewriteModelField, because the function's contract is not "replace the model
// value" — it is "return the map round trip of the body with the model
// replaced", and that round trip NORMALISES the body (keys sorted, HTML
// escaped, \u escapes decoded). Any optimisation must preserve those bytes
// exactly, not merely preserve the parsed JSON.
func referenceRewrite(body []byte, name string) []byte {
	if name == "" {
		return body
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(body, &m); err != nil {
		return body
	}
	if _, ok := m["model"]; !ok {
		return body
	}
	enc, err := json.Marshal(name)
	if err != nil {
		return body
	}
	m["model"] = enc
	out, err := json.Marshal(m)
	if err != nil {
		return body
	}
	return out
}

// The byte-level contract. This is the guard that keeps a future optimisation
// honest: the output must be the map round trip, not "the input with the model
// spliced in".
func TestRewriteModelFieldByteContract(t *testing.T) {
	cases := []struct{ name, in, to string }{
		{"same model", `{"model":"a","messages":[]}`, "a"},
		{"same model with siblings", `{"model":"a","temperature":0.5,"messages":[{"role":"user","content":"hi"}]}`, "a"},
		{"different model", `{"model":"a","messages":[]}`, "b"},
		{"no model key", `{"messages":[]}`, "x"},
		{"empty target", `{"model":"a"}`, ""},
		{"non-json", `not json`, "x"},
		{"json array", `[1,2]`, "x"},
		{"json null", `null`, "x"},
		{"empty object", `{}`, "x"},
		{"escaped model", `{"model":"\u0061","messages":[]}`, "a"},
		{"numeric model", `{"model":1,"messages":[]}`, "1"},
		{"null model", `{"model":null,"messages":[]}`, "x"},
		{"object model", `{"model":{"a":1}}`, "x"},
		{"model with unicode", `{"model":"a","s":"héllo→"}`, "a"},
		{"duplicate model key", `{"model":"a","model":"b"}`, "a"},
		{"whitespace body", `{ "model" : "a" , "messages" : [ ] }`, "a"},
		{"html in sibling", `{"model":"a","html":"<b>&amp;</b>"}`, "a"},
		{"nested sibling", `{"model":"a","x":{ "y" : 1 }}`, "a"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			want := referenceRewrite([]byte(tc.in), tc.to)
			got := rewriteModelField([]byte(tc.in), tc.to)
			if string(got) != string(want) {
				t.Errorf("rewriteModelField(%s, %q)\n got: %s\nwant: %s", tc.in, tc.to, got, want)
			}
		})
	}
}

// WHY there is no "the model already matches, so skip the round trip" fast
// path: the round trip NORMALISES. Returning the body untouched would send the
// upstream the client's own bytes instead of the normalised ones, which is
// observable (key order, HTML escaping, \u escapes) and is exactly what the
// generic path forwards today. These cases are the proof.
func TestRewriteModelFieldCannotSkipRoundTrip(t *testing.T) {
	for _, in := range []string{
		`{"model":"a","messages":[]}`,          // keys out of order
		`{"model":"a","html":"<b>&amp;</b>"}`,  // HTML escaping
		`{"model":"\u0061","messages":[]}`,     // \u escapes
		`{ "model" : "a" , "messages" : [ ] }`, // whitespace
	} {
		got := string(rewriteModelField([]byte(in), "a"))
		if got == in {
			t.Errorf("body %s came back untouched, so the round trip was skipped — that would change the bytes sent upstream", in)
		}
	}
}

// The SSE relay's usage-parse gate must be CONSERVATIVE: it may only skip a
// line the full parse would have found nothing in.
func TestSSEUsageGateIsConservative(t *testing.T) {
	lines := []string{
		`data: {"id":"c","choices":[{"delta":{"content":"x"}}]}`,
		`data: {"id":"c","choices":[{"delta":{"content":"x"}}],"usage":{"prompt_tokens":3}}`,
		`data: {"id":"c","usage":null}`,
		`data: {"id":"c","usage":{"prompt_tokens":0}}`,
		`data: {"id":"c","choices":[{"delta":{"content":"a\\b"}}]}`,
		`data: {"id":"c","choices":[{"delta":{"content":"\"quoted\""}}]}`,
		`data: {"id":"c","choices":[{"delta":{"content":"<html>"}}]}`,
		`data: {"\u0075sage":{"prompt_tokens":9}}`,
		`data: {"id":"c","choices":[{"delta":{"content":"emoji \u00e9"}}]}`,
		`data: [DONE]`,
		`data: {"id":"c","usage":{"prompt_tokens":1},"extra":"back\\slash"}`,
		`data: {"id":"c","usage":{"prompt_tokens":1},"html":"<b>"}`,
	}
	for _, line := range lines {
		payload := line[len("data: "):]
		gated := !containsSub(payload, `"usage"`) && !containsSub(payload, `\`)
		var chunk struct {
			Usage *struct {
				PromptTokens int64 `json:"prompt_tokens"`
			} `json:"usage"`
		}
		err := json.Unmarshal([]byte(payload), &chunk)
		parsed := err == nil && chunk.Usage != nil
		if gated && parsed {
			t.Errorf("gate dropped a line the parse would have used: %s", line)
		}
	}
}

func containsSub(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
