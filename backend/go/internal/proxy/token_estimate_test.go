package proxy

// tokenEstimate's contract, pinned as a table (lifecycle.go).
//
// Why it exists: tokenEstimate feeds the TPM/TPD window at admission, and that
// window is denominated in the CLIENT's declared bound — the router does not
// count tokens itself (PRD §87: it bills what the upstream reports). So the
// return value is money-adjacent in both directions: too low and a key walks
// past its token cap, too high and honest traffic is refused.
//
// The contract is "the first present, positive bound among max_tokens,
// max_completion_tokens, max_output_tokens, else 0" — checked in that SLICE
// order, not in document order (lifecycle.go's loop iterates a literal
// []string). The cases below are the ones a rewrite can quietly break: key
// precedence, a wrong-typed or non-positive value FALLING THROUGH to the next
// key rather than aborting, and the malformed-body answer (0 — an unparseable
// body declares no bound; the endpoints' own validate rejects it later).

import "testing"

func TestTokenEstimate(t *testing.T) {
	cases := []struct {
		name string
		body string
		want int64
	}{
		{"max_tokens", `{"max_tokens": 2048}`, 2048},
		{"max_completion_tokens", `{"max_completion_tokens": 100}`, 100},
		{"max_output_tokens", `{"max_output_tokens": 7}`, 7},
		{"max_tokens wins over later keys", `{"max_completion_tokens": 300, "max_tokens": 100}`, 100},
		{"declared bound with body noise", `{"messages":[{"role":"user","content":"hi"}],"max_tokens":32}`, 32},
		{"negative falls through", `{"max_tokens": -5, "max_completion_tokens": 100}`, 100},
		{"zero falls through", `{"max_tokens": 0, "max_completion_tokens": 100}`, 100},
		{"numeric string falls through", `{"max_tokens": "2048", "max_completion_tokens": 100}`, 100},
		{"bool falls through", `{"max_tokens": true, "max_completion_tokens": 100}`, 100},
		{"array falls through", `{"max_tokens": [1,2], "max_completion_tokens": 100}`, 100},
		{"object falls through", `{"max_tokens": {"a":1}, "max_completion_tokens": 100}`, 100},
		{"fraction truncates", `{"max_tokens": 2048.7}`, 2048},
		{"exponent form", `{"max_tokens": 1e3}`, 1000},
		{"no bound at all", `{"model":"grok-4.6"}`, 0},
		{"empty body", ``, 0},
		{"not json", `not json`, 0},
		{"truncated json", `{"max_tokens": 2048, garbage`, 0},
		{"json array root", `[]`, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tokenEstimate([]byte(tc.body)); got != tc.want {
				t.Fatalf("tokenEstimate(%q) = %d, want %d", tc.body, got, tc.want)
			}
		})
	}
}
