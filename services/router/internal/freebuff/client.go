package freebuff

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Upstream constants, all taken verbatim from the reverse-engineered protocol
// (Freebuff2API src/upstream.rs).
const (
	DefaultBaseURL = "https://www.codebuff.com"
	RootAgentID    = "base2-free"

	codebuffUA = "ai-sdk/openai-compatible/1.0.25/codebuff"

	headerModel     = "x-freebuff-model"
	headerInstance  = "x-freebuff-instance-id"
	headerMulti     = "x-freebuff-multi-session"
	headerInclude   = "x-freebuff-include-unused-rate-limits"
	headerHeartbeat = "x-freebuff-heartbeat"

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

// client is the raw HTTP layer against the Codebuff upstream.
type client struct {
	baseURL string
	http    *http.Client
}

func newClient(baseURL string) *client {
	if strings.TrimSpace(baseURL) == "" {
		baseURL = DefaultBaseURL
	}
	baseURL = strings.TrimRight(baseURL, "/")
	if baseURL == "https://codebuff.com" {
		baseURL = DefaultBaseURL
	}
	return &client{
		baseURL: baseURL,
		http: &http.Client{
			Timeout: 15 * time.Minute, // streaming: long docs must not be cut
		},
	}
}

func (c *client) authHeaders(token string) http.Header {
	h := http.Header{}
	h.Set("Authorization", "Bearer "+token)
	h.Set("Content-Type", "application/json")
	h.Set("User-Agent", codebuffUA)
	return h
}

// createSession POSTs `{}` with the model header; the upstream answers
// active / queued.
func (c *client) createSession(ctx context.Context, token, model, instanceID string) (sessionResponse, error) {
	h := c.authHeaders(token)
	h.Set(headerModel, model)
	h.Set(headerMulti, instanceHeader)
	if instanceID != "" {
		h.Set(headerInstance, instanceID)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+pathSession, strings.NewReader("{}"))
	if err != nil {
		return sessionResponse{}, err
	}
	req.Header = h
	return c.doJSON(req)
}

// getSession polls session state (queued → active) and pulls rate limits.
func (c *client) getSession(ctx context.Context, token, instanceID string) (sessionResponse, error) {
	h := c.authHeaders(token)
	h.Set(headerMulti, instanceHeader)
	h.Set(headerInclude, instanceHeader)
	if instanceID != "" {
		h.Set(headerInstance, instanceID)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+pathSession, nil)
	if err != nil {
		return sessionResponse{}, err
	}
	req.Header = h
	return c.doJSON(req)
}

func (c *client) deleteSession(ctx context.Context, token, instanceID string) error {
	h := c.authHeaders(token)
	h.Set(headerInstance, instanceID)
	h.Set(headerMulti, instanceHeader)
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, c.baseURL+pathSession, nil)
	if err != nil {
		return err
	}
	req.Header = h
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode < 300 {
		return nil
	}
	return fmt.Errorf("freebuff: delete session HTTP %d", resp.StatusCode)
}

// heartbeat keeps an active session alive (GET + x-freebuff-heartbeat: 1).
func (c *client) heartbeat(ctx context.Context, token, instanceID string) error {
	h := c.authHeaders(token)
	h.Set(headerMulti, instanceHeader)
	h.Set(headerInstance, instanceID)
	h.Set(headerHeartbeat, instanceHeader)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+pathSession, nil)
	if err != nil {
		return err
	}
	req.Header = h
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	return nil
}

// startRun opens a root agent run under the active session. ancestorRunIds is
// an explicit empty array — `null` is rejected by the upstream schema.
func (c *client) startRun(ctx context.Context, token, agentID string) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"action":         "START",
		"agentId":        agentID,
		"ancestorRunIds": []string{},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+pathAgentRuns, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header = c.authHeaders(token)
	resp, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode < 300 {
		var out startRunResponse
		if err := json.Unmarshal(raw, &out); err != nil {
			return "", fmt.Errorf("freebuff: start run unparseable: %w", err)
		}
		if id := out.id(); id != "" {
			return id, nil
		}
		return "", fmt.Errorf("freebuff: start run response missing runId")
	}
	// A 4xx here is not fatal for the request as a whole: the chat can still be
	// attempted, but without a run it will fail upstream. Surface it.
	return "", &httpError{Status: resp.StatusCode, Body: string(raw)}
}

// finishRun closes the run. "not found"/"not running" is success — the run may
// already have been reaped upstream.
func (c *client) finishRun(ctx context.Context, token, runID string, steps int64) error {
	body, _ := json.Marshal(map[string]any{
		"action":        "FINISH",
		"runId":         runID,
		"status":        "completed",
		"totalSteps":    steps,
		"directCredits": 0,
		"totalCredits":  0,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+pathAgentRuns, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header = c.authHeaders(token)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode < 300 {
		return nil
	}
	text := strings.ToLower(string(raw))
	if strings.Contains(text, "not found") || strings.Contains(text, "not running") {
		return nil
	}
	return &httpError{Status: resp.StatusCode, Body: string(raw)}
}

// chat POSTs the [OI]-shaped body with codebuff_metadata injected, and returns
// the raw upstream response for the caller to stream or relay.
func (c *client) chat(ctx context.Context, token string, body []byte, runID, instanceID string) (*http.Response, error) {
	patched, err := injectMetadata(body, runID, instanceID)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+pathChat, bytes.NewReader(patched))
	if err != nil {
		return nil, err
	}
	req.Header = c.authHeaders(token)
	return c.http.Do(req)
}

func (c *client) doJSON(req *http.Request) (sessionResponse, error) {
	resp, err := c.http.Do(req)
	if err != nil {
		return sessionResponse{}, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 256<<10))
	if resp.StatusCode >= 300 {
		return sessionResponse{}, &httpError{Status: resp.StatusCode, Body: string(raw)}
	}
	var out sessionResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return sessionResponse{}, fmt.Errorf("freebuff: unparseable session body: %w", err)
	}
	return out, nil
}

// injectMetadata sets the four required codebuff_metadata fields. All four must
// be present or the upstream rejects the request.
func injectMetadata(body []byte, runID, instanceID string) ([]byte, error) {
	var req map[string]any
	if err := json.Unmarshal(body, &req); err != nil {
		return nil, fmt.Errorf("freebuff: request body is not a JSON object: %w", err)
	}
	meta, _ := req["codebuff_metadata"].(map[string]any)
	if meta == nil {
		meta = map[string]any{}
	}
	meta["run_id"] = runID
	meta["cost_mode"] = "free"
	meta["client_id"] = newClientID()
	if instanceID != "" {
		meta["freebuff_instance_id"] = instanceID
	}
	req["codebuff_metadata"] = meta
	return json.Marshal(req)
}

// ErrorKind classifies an upstream failure so the caller can decide whether to
// retry, fail over, or surface a readable error.
type ErrorKind string

const (
	KindRateLimit        ErrorKind = "rate_limit"
	KindWaitingRoom      ErrorKind = "waiting_room"
	KindAuthExpired      ErrorKind = "auth_expired"
	KindModelUnavailable ErrorKind = "model_unavailable"
	KindBadRequest       ErrorKind = "bad_request"
	KindUpstream5xx      ErrorKind = "upstream_5xx"
	KindNetwork          ErrorKind = "network"
	KindUnknown          ErrorKind = "unknown"
)

var (
	waitingRoomStrong = []string{"waiting_room", "waiting room", "排队"}
	waitingRoomWeak   = []string{"queue"}
	rateLimitHints    = []string{"rate limit", "rate_limit", "too many requests", "限流"}
	modelUnavailable  = []string{
		"invalid_agent_model", "free_mode_invalid", "model not available",
		"only available for", "model_not_found", "no such model",
	}
	authHints      = []string{"unauthorized", "invalid token", "session expired", "token expired", "authentication"}
	badRequestHint = []string{"invalid_request", "bad request"}
	missingReqRe   = regexp.MustCompile(`(?is)missing\b.{0,80}?required`)
)

// Classify mirrors Freebuff2API's errors::classify: text rules first, status
// code as fallback. status 0 means a network error.
func Classify(status int, body string) ErrorKind {
	lowered := strings.ToLower(body)
	if k := classifyText(lowered, status); k != "" {
		return k
	}
	switch {
	case status == 0:
		return KindNetwork
	case status == 429:
		return KindRateLimit
	case status == 401 || status == 403:
		return KindAuthExpired
	case status == 404:
		return KindModelUnavailable
	case status == 400 || status == 422:
		return KindBadRequest
	case status >= 500 && status < 600:
		return KindUpstream5xx
	default:
		return KindUnknown
	}
}

func classifyText(lowered string, status int) ErrorKind {
	if containsAny(lowered, waitingRoomStrong) ||
		((status == 429 || status == 503) && containsAny(lowered, waitingRoomWeak)) {
		return KindWaitingRoom
	}
	if containsAny(lowered, rateLimitHints) {
		return KindRateLimit
	}
	if containsAny(lowered, modelUnavailable) {
		return KindModelUnavailable
	}
	if containsAny(lowered, authHints) {
		return KindAuthExpired
	}
	if containsAny(lowered, badRequestHint) || missingReqRe.MatchString(lowered) {
		return KindBadRequest
	}
	return ""
}

// RetryAfterHint is the suggested backoff for a retryable kind, matching the
// upstream constants (rate limit 60s, waiting room 15s, 5xx 5s).
func RetryAfterHint(k ErrorKind) (int, bool) {
	switch k {
	case KindRateLimit:
		return 60, true
	case KindWaitingRoom:
		return 15, true
	case KindUpstream5xx:
		return 5, true
	}
	return 0, false
}

// Retryable reports whether a backoff-and-retry is worthwhile.
func Retryable(k ErrorKind) bool {
	switch k {
	case KindRateLimit, KindWaitingRoom, KindUpstream5xx, KindNetwork:
		return true
	}
	return false
}

func containsAny(haystack string, needles []string) bool {
	for _, n := range needles {
		if strings.Contains(haystack, n) {
			return true
		}
	}
	return false
}
