// The Codebuff/Freebuff wire protocol: constants and payload shapes.
//
// Everything here is taken verbatim from the reverse-engineered reference
// (Freebuff2API src/upstream.rs) and is NOT an OpenAI-compatible surface — a chat
// needs a session, a root agent run, and codebuff_metadata injection. Keeping the
// constants and the shapes in one file means a protocol change is a diff against
// a single page.
//
// Split out of client.go, which now holds only the HTTP transport, and
// manager.go, which holds the session state machine.
package freebuff

import (
	"encoding/json"
	"fmt"
)

// Upstream constants, all taken verbatim from the reverse-engineered protocol
// (Freebuff2API src/upstream.rs).
const (
	DefaultBaseURL = "https://www.codebuff.com"
	RootAgentID    = "base2-free"

	codebuffUA = "ai-sdk/openai-compatible/1.0.25/codebuff"

	headerModel    = "x-freebuff-model"
	headerInstance = "x-freebuff-instance-id"
	headerMulti    = "x-freebuff-multi-session"

	pathSession    = "/api/v1/freebuff/session"
	pathAgentRuns  = "/api/v1/agent-runs"
	pathChat       = "/api/v1/chat/completions"
	instanceHeader = "1"
)

// SessionStatus is the freebuff session state machine.
type SessionStatus string

const (
	StatusNone       SessionStatus = "none"
	StatusQueued     SessionStatus = "queued"
	StatusActive     SessionStatus = "active"
	StatusDisabled   SessionStatus = "disabled"
	StatusEnded      SessionStatus = "ended"
	StatusSuperseded SessionStatus = "superseded"
)

// sessionResponse is POST/GET /api/v1/freebuff/session.
type sessionResponse struct {
	Status          string          `json:"status"`
	InstanceID      string          `json:"instanceId"`
	InstanceIDSnake string          `json:"instance_id"`
	Model           string          `json:"model"`
	ExpiresAt       string          `json:"expiresAt"`
	Position        *int64          `json:"position"`
	QueueDepth      *int64          `json:"queueDepth"`
	EstimatedWaitMs *int64          `json:"estimatedWaitMs"`
	Message         string          `json:"message"`
	Error           string          `json:"error"`
	RateLimits      json.RawMessage `json:"rateLimitsByModel"`
}

func (s sessionResponse) instance() string {
	if s.InstanceID != "" {
		return s.InstanceID
	}
	return s.InstanceIDSnake
}

type startRunResponse struct {
	RunID      string `json:"runId"`
	RunIDSnake string `json:"run_id"`
}

// httpError carries the upstream status so a caller can classify a failure by
// code, not just by text. Without it a 401 whose body says "Invalid API key"
// (no keyword match) would be misclassified as a network error.
type httpError struct {
	Status int
	Body   string
}

func (e *httpError) Error() string {
	return fmt.Sprintf("freebuff: HTTP %d: %s", e.Status, Excerpt(e.Body))
}

func (r startRunResponse) id() string {
	if r.RunID != "" {
		return r.RunID
	}
	return r.RunIDSnake
}
