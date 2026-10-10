package freebuff

import (
	"crypto/rand"
	"encoding/json"
	"strings"
	"time"
)

// excerptMaxChars bounds an error excerpt shown to a caller.
const excerptMaxChars = 300

// Excerpt pulls the most useful human-readable message out of an upstream
// error body (JSON `message`/`detail`/`error_description`/`error`, else the raw
// text), collapses whitespace, and truncates it. Mirrors errors::error_excerpt.
func Excerpt(body string) string {
	text := strings.TrimSpace(body)
	if text == "" {
		return ""
	}
	if msg := messageFromJSON(text); msg != "" {
		text = msg
	}
	return truncateChars(collapseWhitespace(text), excerptMaxChars)
}

func messageFromJSON(text string) string {
	var v any
	if err := json.Unmarshal([]byte(text), &v); err != nil {
		return ""
	}
	return messageFromValue(v)
}

func messageFromValue(v any) string {
	switch t := v.(type) {
	case string:
		return strings.TrimSpace(t)
	case map[string]any:
		for _, key := range []string{"message", "detail", "error_description", "error"} {
			if child, ok := t[key]; ok {
				if s := messageFromValue(child); s != "" {
					return s
				}
			}
		}
	}
	return ""
}

func collapseWhitespace(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

func truncateChars(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	if max <= 3 {
		return string(r[:max])
	}
	return string(r[:max-3]) + "..."
}

const clientIDAlphabet = "0123456789abcdefghijklmnopqrstuvwxyz"

// newClientID produces the 13-char [0-9a-z] id the upstream expects in
// codebuff_metadata.client_id.
func newClientID() string {
	buf := make([]byte, 13)
	if _, err := rand.Read(buf); err != nil {
		// crypto/rand failing is unrecoverable in practice; a fixed id is still
		// a syntactically valid value the upstream accepts.
		return strings.Repeat("0", 13)
	}
	for i, b := range buf {
		buf[i] = clientIDAlphabet[int(b)%len(clientIDAlphabet)]
	}
	return string(buf)
}

// parseExpiry reads an RFC3339 timestamp; an empty or unparseable value returns
// the zero time, which the caller treats as "already expired".
func parseExpiry(s string) time.Time {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05Z"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Time{}
}
