// Request payload shaping and the upstream error taxonomy.
//
// `injectMetadata` is what makes a plain OpenAI-shaped body acceptable to
// Codebuff — the four codebuff_metadata fields are mandatory. `Classify` maps a
// failure to a kind so the caller can decide whether to retry, fail over to
// another pooled account, or surface a readable error; the status code is
// preferred over text matching, but a 401 whose body says nothing recognisable
// still has to classify as auth, not as network.
package freebuff

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

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
