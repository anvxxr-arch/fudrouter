package routing

import "testing"

// TestErrorEnvelope pins the 2xx-refusal detector against the live shapes it was
// written for, and against the false positives that would make it dangerous.
func TestErrorEnvelope(t *testing.T) {
	cases := []struct {
		name     string
		body     string
		wantOK   bool
		wantCode string
	}{
		{
			name:     "tokenharbor 200 rate limit",
			body:     `{"error":{"message":"Per-minute rate limit reached — slow down a bit.","type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}`,
			wantOK:   true,
			wantCode: "rate_limit_exceeded",
		},
		{
			name:   "openai-style detail quota refusal",
			body:   `{"detail":"You exceeded your current quota, please check your plan and billing details."}`,
			wantOK: true,
		},
		{
			name:   "bare string error",
			body:   `{"error":"upstream is temporarily overloaded"}`,
			wantOK: true,
		},
		{
			// The whole point of requiring the ABSENCE of a completion: a real
			// answer may legitimately contain the word "error".
			name:   "real completion that mentions error",
			body:   `{"choices":[{"message":{"role":"assistant","content":"there was an error in your code"}}],"usage":{"total_tokens":9}}`,
			wantOK: false,
		},
		{
			name:   "real completion with empty choices array",
			body:   `{"choices":[],"usage":{"total_tokens":0}}`,
			wantOK: false,
		},
		{
			name:   "anthropic-shaped answer",
			body:   `{"content":[{"type":"text","text":"ok"}],"role":"assistant"}`,
			wantOK: false,
		},
		{
			name:   "gemini-shaped answer",
			body:   `{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}`,
			wantOK: false,
		},
		{
			name:   "error null is not an error",
			body:   `{"error":null,"output":"fine"}`,
			wantOK: false,
		},
		{
			name:   "empty error string is not an error",
			body:   `{"error":"  "}`,
			wantOK: false,
		},
		{
			// A truncated/garbage 2xx body is not an envelope either — it must
			// keep flowing to the client untouched.
			name:   "plain non-json body is not an envelope",
			body:   `<html><body>502 Bad Gateway</body></html>`,
			wantOK: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			code, ok := ErrorEnvelope([]byte(tc.body))
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v (code=%q)", ok, tc.wantOK, code)
			}
			if tc.wantCode != "" && code != tc.wantCode {
				t.Fatalf("code = %q, want %q", code, tc.wantCode)
			}
		})
	}
}

func TestClassifyErrorCode(t *testing.T) {
	cases := []struct {
		code      string
		body      string
		wantCode  string
		retryable bool
	}{
		{"rate_limit_exceeded", `Per-minute rate limit reached`, ErrCodeRateLimited, true},
		{"", `{"detail":"You exceeded your current quota"}`, ErrCodeRateLimited, true},
		{"", `{"error":{"message":"insufficient credits"}}`, ErrCodeInsufficientCredits, true},
		{"", `{"error":{"message":"Invalid API key provided"}}`, ErrCodeAuthError, true},
		{"model_not_found", `no such model`, ErrCodeModelNotFound, true},
		{"", `{"error":{"message":"This model is unavailable right now"}}`, ErrCodeModelNotFound, true},
		{"", `{"error":{"message":"context length exceeded"}}`, ErrCodeContextTooLong, false},
		{"", `{"error":{"message":"upstream overloaded, try again"}}`, ErrCodeProviderUnavailable, true},
		{"", `{"error":{"message":"bad request: messages is required"}}`, ErrCodeInvalidRequest, false},
		// Unrecognised envelopes must WALK ON: a terminal 200 written as
		// success is worse than one extra attempt.
		{"weird_code", `something nobody has seen`, ErrCodeUpstreamError, true},
	}
	for _, tc := range cases {
		code, retryable := ClassifyErrorCode(tc.code, []byte(tc.body))
		if code != tc.wantCode || retryable != tc.retryable {
			t.Errorf("ClassifyErrorCode(%q, %q) = (%s,%v), want (%s,%v)",
				tc.code, tc.body, code, retryable, tc.wantCode, tc.retryable)
		}
	}
}

// TestClassifyRetryableAgreesOnEnvelopeCodes guards the seam the 2xx sniff
// depends on: whatever ClassifyErrorCode returns must be handled sensibly by
// ClassifyRetryable, or the walk stops on a refusal.
func TestClassifyRetryableAgreesOnEnvelopeCodes(t *testing.T) {
	for _, code := range []string{ErrCodeRateLimited, ErrCodeUpstreamError, ErrCodeProviderUnavailable,
		ErrCodeProviderTimeout, ErrCodeInsufficientCredits, ErrCodeModelNotFound} {
		if !ClassifyRetryable(code, 200, false) {
			t.Errorf("ClassifyRetryable(%s,200,false) = false; the walk would stop on a 2xx refusal", code)
		}
	}
}
