package proxy

// parseRetryAfter: the upstream's own Retry-After hint.
//
// Why this file exists: Attempt.RetryAfterSeconds was declared, documented and
// relayed to the client (lifecycle.go:709) but NEVER SET, so every 429 parked
// its credential for the 60s default regardless of what the provider said. A
// provider answering `retry-after: 3600` was retried 60x too early; one
// answering `retry-after: 5` was benched 12x too long. The plumbing was
// complete and the parse was missing, so the test pins the parse.
//
// The clamp is the load-bearing part: without it a provider reporting a
// multi-day reset takes a credential out of rotation for that whole span on a
// single 429, and a clock-skewed HTTP-date parks it for years.

import (
	"net/http"
	"testing"
	"time"
)

func TestParseRetryAfter(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		in   string
		want int
	}{
		{"empty", "", 0},
		{"whitespace", "   ", 0},
		{"delta seconds", "120", 120},
		{"delta seconds padded", "  120  ", 120},
		{"one second", "1", 1},
		{"zero is no hint", "0", 0},
		{"negative is no hint", "-5", 0},
		{"garbage", "soon", 0},
		{"clamped to 24h", "999999", 24 * 60 * 60},
		{"exactly 24h", "86400", 86400},
		{"http-date in the past", "Wed, 21 Oct 2015 07:28:00 GMT", 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseRetryAfter(tc.in); got != tc.want {
				t.Fatalf("parseRetryAfter(%q) = %d, want %d", tc.in, got, tc.want)
			}
		})
	}

	// An HTTP-date in the future is honoured, within a tolerance: the value is
	// computed from time.Until, so a strict equality would be flaky.
	//
	// The format is the wire format, not time.RFC1123: that constant renders
	// the zone as "UTC", and http.ParseTime accepts only "GMT" (RFC 9110
	// §10.2.1). A provider sends GMT, so the test must too.
	t.Run("http-date in the future", func(t *testing.T) {
		future := time.Now().Add(90 * time.Second).UTC().Format(http.TimeFormat)
		got := parseRetryAfter(future)
		if got < 85 || got > 90 {
			t.Fatalf("parseRetryAfter(%q) = %d, want ~90", future, got)
		}
	})

	// A far-future date must clamp, not park for years.
	t.Run("http-date far future clamps", func(t *testing.T) {
		far := time.Now().Add(400 * 24 * time.Hour).UTC().Format(http.TimeFormat)
		if got := parseRetryAfter(far); got != 24*60*60 {
			t.Fatalf("parseRetryAfter(%q) = %d, want the 24h clamp", far, got)
		}
	})
}
