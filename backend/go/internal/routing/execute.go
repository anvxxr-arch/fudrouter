package routing

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/vk"
)

// Attempt is one upstream exchange (or one REFUSED exchange, e.g. an open
// circuit) and everything spec §8's request_attempt row records.
type Attempt struct {
	Attempt   int
	Candidate *Candidate
	// Reason is why this candidate won its slot (spec §8 `reason`): copied from
	// the selection so the attempt row is self-describing.
	Reason string
	// CredentialID identifies the secret that served (or was refused), for the
	// attempt row and credential-state bookkeeping.
	CredentialID string
	StartedAt    time.Time
	FinishedAt   time.Time
	HTTPStatus   int
	ErrorCode    string // PRD §88 taxonomy code, "" on success
	Retryable    bool
	LatencyMs    int64
	TTFTMs       *int
	Transport    error // a transport failure (timeout, reset, EOF), nil otherwise
	// RawMessage is the provider's own error text. It is recorded in
	// request_log.error / attempt metadata ONLY (spec §8: never as the
	// client-facing code).
	RawMessage string
	// RetryAfterSeconds carries an upstream Retry-After hint (freebuff waiting
	// room / rate limit) so the client response can relay it.
	RetryAfterSeconds int
	// ClientStatus overrides the taxonomy's default HTTP status for this
	// attempt's failure (e.g. a freebuff waiting room is 503, not the generic
	// provider-unavailable 502). Zero = use the default.
	ClientStatus int
	// Payload is the caller's own exchange artifact (e.g. *http.Response),
	// opaque to this package. It is set only on the winning attempt.
	Payload any
}

// AttemptFn performs one candidate's EXCHANGE LOOP and returns every attempt
// it made (spec §8: one row per real upstream exchange — a connection with
// several credential rows can produce several attempts on one call). It MUST
// classify each outcome (ErrorCode, Retryable) and set Payload on the winning
// attempt. A non-nil Transport is a transport-level failure (retryable per
// spec §9).
type AttemptFn func(ctx context.Context, cand *Candidate, next int) []*Attempt

// Result is the outcome of the whole fallback walk.
type Result struct {
	Winner        *Attempt // nil when every attempt failed
	Attempts      []*Attempt
	FallbackUsed  bool // more than one candidate was attempted
	LastErrorCode string
	LastStatus    int
}

// Execute walks the ordered candidates with retry/fallback per spec §9.
//
// Rules, in order of application:
//
//  1. DEADLINE (policy `request_timeout_ms`): an attempt is never STARTED that
//     cannot finish inside the deadline. The estimate is the candidate's own
//     p95 latency signal; the remaining budget must exceed it.
//  2. Circuit breaker: an open circuit refuses the attempt (recorded as an
//     attempt with CIRCUIT_OPEN, retryable) and moves to the next candidate.
//  3. Retry/fallback only on retryable outcomes (ClassifyRetryable). A
//     non-retryable outcome stops the walk immediately: the request is wrong
//     and no other target can fix it.
//  4. Fallback is to a DIFFERENT candidate; `FallbackUsed` reports that.
func Execute(ctx context.Context, ordered []Candidate, plan Plan, deadline time.Time, cb *CircuitBreaker, fn AttemptFn) *Result {
	res := &Result{}
	if len(ordered) == 0 {
		return res
	}
	maxAttempts := plan.MaxAttempts
	if maxAttempts < 1 {
		maxAttempts = 1
	}
	if !plan.FallbackEnabled {
		maxAttempts = 1
	}
	candidatesTried := 0

	for i := 0; i < len(ordered) && len(res.Attempts) < maxAttempts; i++ {
		cand := ordered[i]

		// 1. Deadline: never start an attempt that cannot finish in time.
		if !budgetAllows(ctx, deadline, cand) {
			break
		}

		// 2. Circuit breaker (Valkey state; Valkey down = closed).
		started := time.Now()
		if cb != nil && !cb.Allow(ctx, &cand) {
			a := &Attempt{
				Attempt:    len(res.Attempts) + 1,
				Candidate:  &cand,
				StartedAt:  started,
				FinishedAt: time.Now(),
				ErrorCode:  ErrCodeCircuitOpen,
				Retryable:  true,
			}
			a.LatencyMs = a.FinishedAt.Sub(a.StartedAt).Milliseconds()
			res.Attempts = append(res.Attempts, a)
			res.LastErrorCode = a.ErrorCode
			candidatesTried++
			continue
		}

		room := maxAttempts - len(res.Attempts)
		batch := fn(ctx, &cand, len(res.Attempts)+1)
		if len(batch) > room {
			batch = batch[:room]
		}
		candidatesTried++
		for _, a := range batch {
			if a == nil {
				a = &Attempt{ErrorCode: ErrCodeInternalError}
			}
			a.Candidate = &cand
			a.Attempt = len(res.Attempts) + 1
			if a.Reason == "" {
				a.Reason = cand.Reason
			}
			if a.StartedAt.IsZero() {
				a.StartedAt = started
			}
			if a.FinishedAt.IsZero() {
				a.FinishedAt = time.Now()
			}
			if a.LatencyMs == 0 {
				a.LatencyMs = a.FinishedAt.Sub(a.StartedAt).Milliseconds()
			}
			res.Attempts = append(res.Attempts, a)

			// 3. Circuit feedback.
			if cb != nil {
				cb.Result(ctx, &cand, a.ErrorCode == "")
			}

			if a.ErrorCode == "" {
				res.Winner = a
				res.FallbackUsed = candidatesTried > 1
				return res
			}
			res.LastErrorCode = a.ErrorCode
			res.LastStatus = a.HTTPStatus

			if !ClassifyRetryable(a.ErrorCode, a.HTTPStatus, a.Transport != nil) {
				res.FallbackUsed = candidatesTried > 1
				return res // request-shaped: no other target can fix it
			}
		}
	}
	res.FallbackUsed = candidatesTried > 1
	return res
}

// budgetAllows reports whether an attempt against cand can finish inside the
// request deadline. The estimate is the candidate's p95 latency; a candidate
// with no signal uses the neutral estimate LoadSignals installs.
func budgetAllows(ctx context.Context, deadline time.Time, cand Candidate) bool {
	if deadline.IsZero() {
		return true
	}
	if err := ctx.Err(); err != nil {
		return false
	}
	est := time.Duration(cand.LatencyMs) * time.Millisecond
	if est <= 0 {
		est = time.Duration(neutralLatencyMs) * time.Millisecond
	}
	return time.Now().Add(est).Before(deadline)
}

// PRD §88 taxonomy codes (spec §8 "exactly").
const (
	ErrCodeAuthError           = "AUTHENTICATION_ERROR"
	ErrCodeAuthorization       = "AUTHORIZATION_ERROR"
	ErrCodeRateLimited         = "RATE_LIMITED"
	ErrCodeInsufficientCredits = "INSUFFICIENT_CREDITS"
	ErrCodeInvalidRequest      = "INVALID_REQUEST"
	ErrCodeModelNotFound       = "MODEL_NOT_FOUND"
	ErrCodeContextTooLong      = "CONTEXT_TOO_LONG"
	ErrCodeUnsupportedParam    = "UNSUPPORTED_PARAMETER"
	ErrCodeContentRejected     = "CONTENT_REJECTED"
	ErrCodeProviderTimeout     = "PROVIDER_TIMEOUT"
	ErrCodeProviderUnavailable = "PROVIDER_UNAVAILABLE"
	ErrCodeCircuitOpen         = "CIRCUIT_OPEN"
	ErrCodeUpstreamError       = "UPSTREAM_ERROR"
	ErrCodeInternalError       = "INTERNAL_ERROR"
)

// ClassifyRetryable implements spec §9's retry table.
//
// Retry ONLY on: RATE_LIMITED, PROVIDER_TIMEOUT, PROVIDER_UNAVAILABLE,
// CIRCUIT_OPEN, UPSTREAM_ERROR(5xx/429/401/403) and transport errors.
// NEVER on: INVALID_REQUEST, UNSUPPORTED_PARAMETER, CONTEXT_TOO_LONG,
// MODEL_NOT_FOUND, AUTHORIZATION_ERROR, CONTENT_REJECTED.
func ClassifyRetryable(code string, httpStatus int, transport bool) bool {
	if transport {
		return true
	}
	switch code {
	case ErrCodeRateLimited, ErrCodeProviderTimeout, ErrCodeProviderUnavailable, ErrCodeCircuitOpen:
		return true
	case ErrCodeUpstreamError:
		switch httpStatus {
		case 0, 401, 403, 429:
			return true
		}
		return httpStatus >= 500
	case ErrCodeInvalidRequest, ErrCodeUnsupportedParam, ErrCodeContextTooLong,
		ErrCodeModelNotFound, ErrCodeAuthorization, ErrCodeContentRejected,
		ErrCodeAuthError, ErrCodeInsufficientCredits:
		return false
	}
	return false
}

// ClassifyUpstream maps an upstream HTTP status onto the taxonomy code and its
// retryability. An upstream 401/403 is a DEAD CREDENTIAL, not a client's
// authorization failure: it is UPSTREAM_ERROR and retryable (the S0 failover
// contract, spec §9 "UPSTREAM_ERROR(5xx/429/401/403)").
func ClassifyUpstream(status int) (string, bool) {
	switch {
	case status == 0:
		return ErrCodeUpstreamError, true
	case status == 429:
		return ErrCodeRateLimited, true
	case status == 401 || status == 403:
		return ErrCodeUpstreamError, true
	case status == 408 || status == 504:
		return ErrCodeProviderTimeout, true
	case status == 502 || status == 503:
		return ErrCodeProviderUnavailable, true
	case status >= 500:
		return ErrCodeUpstreamError, true
	case status == 400 || status == 422:
		return ErrCodeInvalidRequest, false
	case status == 404:
		return ErrCodeModelNotFound, false
	case status == 413:
		return ErrCodeContextTooLong, false
	case status == 402:
		return ErrCodeInsufficientCredits, false
	default:
		return ErrCodeUpstreamError, status >= 500
	}
}

// ---------------------------------------------------------------- breaker ----

// Circuit state values (spec §9, key `circuit:{target}:{id}`).
const (
	CircuitClosed   = "closed"
	CircuitOpen     = "open"
	CircuitHalfOpen = "half_open"
)

// BreakerDefaults are the PRD §105 defaults used when no circuit_breaker row
// exists for a target.
type BreakerDefaults struct {
	FailureThreshold int
	WindowSeconds    int
	OpenMs           int
	HalfOpenProbes   int
}

func DefaultBreaker() BreakerDefaults {
	return BreakerDefaults{FailureThreshold: 5, WindowSeconds: 60, OpenMs: 30000, HalfOpenProbes: 2}
}

// CircuitBreaker keeps breaker state in Valkey (spec §9) and configuration in
// PostgreSQL (store.CircuitBreakerConfig). With Valkey down the breaker
// degrades to CLOSED and health filtering carries the load (PRD §150) — a
// cache outage must not stop traffic.
type CircuitBreaker struct {
	vk  vk.Client
	mu  sync.Mutex
	cfg map[string]BreakerDefaults // "target:id" -> config
}

// circuitState is the cached value under `circuit:{target}:{id}`.
type circuitState struct {
	State      string `json:"state"`
	Failures   int    `json:"failures"`
	OpenedAtMs int64  `json:"opened_at_ms"`
	Probes     int    `json:"probes"`
}

func NewCircuitBreaker(c vk.Client, cfg map[string]BreakerDefaults) *CircuitBreaker {
	if c == nil {
		c = vk.Disabled()
	}
	if cfg == nil {
		cfg = map[string]BreakerDefaults{}
	}
	return &CircuitBreaker{vk: c, cfg: cfg}
}

// Allow reports whether an attempt against cand may proceed. A missing or
// broken state store means CLOSED: the breaker protects the upstream, never
// the other way around.
func (b *CircuitBreaker) Allow(ctx context.Context, cand *Candidate) bool {
	if b == nil {
		return true
	}
	target, id := breakerTarget(cand)
	if id == "" {
		return true
	}
	key := circuitKey(target, id)
	st, err := b.load(ctx, key)
	if err != nil {
		return true // Valkey down → closed (PRD §150)
	}
	cfg := b.config(target, id)
	now := time.Now()

	b.mu.Lock()
	defer b.mu.Unlock()
	switch st.State {
	case CircuitOpen:
		if now.Sub(time.UnixMilli(st.OpenedAtMs)) >= time.Duration(cfg.OpenMs)*time.Millisecond {
			// Cooling-off elapsed: admit ONE probe (half-open).
			st.State = CircuitHalfOpen
			st.Probes = 0
			_ = b.save(ctx, key, st)
			return true
		}
		return false
	case CircuitHalfOpen:
		if st.Probes < cfg.HalfOpenProbes {
			st.Probes++
			_ = b.save(ctx, key, st)
			return true
		}
		return false
	default:
		return true
	}
}

// Result feeds one attempt's outcome back into the breaker.
func (b *CircuitBreaker) Result(ctx context.Context, cand *Candidate, success bool) {
	if b == nil {
		return
	}
	target, id := breakerTarget(cand)
	if id == "" {
		return
	}
	key := circuitKey(target, id)
	cfg := b.config(target, id)

	b.mu.Lock()
	defer b.mu.Unlock()
	st, err := b.load(ctx, key)
	if err != nil {
		return // state is advisory; never fail the request for it
	}
	now := time.Now()
	switch {
	case success:
		st = circuitState{State: CircuitClosed}
	case st.State == CircuitHalfOpen:
		// A failed probe re-opens with a fresh cooling-off window.
		st = circuitState{State: CircuitOpen, OpenedAtMs: now.UnixMilli(), Failures: cfg.FailureThreshold}
	default:
		st.Failures++
		if st.Failures >= cfg.FailureThreshold {
			st = circuitState{State: CircuitOpen, OpenedAtMs: now.UnixMilli(), Failures: cfg.FailureThreshold}
		} else {
			st.State = CircuitClosed
		}
	}
	_ = b.save(ctx, key, st)
}

// config reads the breaker configuration. The map is populated once at
// construction and never written afterwards, so it needs no lock — and MUST
// NOT take one: it is called from inside the breaker's own locked sections.
func (b *CircuitBreaker) config(target, id string) BreakerDefaults {
	if c, ok := b.cfg[target+":"+id]; ok && c.FailureThreshold > 0 {
		return c
	}
	return DefaultBreaker()
}

func (b *CircuitBreaker) load(ctx context.Context, key string) (circuitState, error) {
	var st circuitState
	err := b.vk.GetJSON(ctx, key, &st, 0)
	if errors.Is(err, vk.ErrNotFound) {
		return circuitState{State: CircuitClosed}, nil
	}
	if err != nil {
		return circuitState{}, err
	}
	if st.State == "" {
		st.State = CircuitClosed
	}
	return st, nil
}

func (b *CircuitBreaker) save(ctx context.Context, key string, st circuitState) error {
	// The state is ephemeral (spec §12: Valkey may lose it), so it carries a
	// short TTL rather than living forever: a stale OPEN must age out even if
	// the process that wrote it is gone.
	ttl := time.Duration(b.config("provider", "").WindowSeconds) * time.Second
	if ttl <= 0 {
		ttl = time.Minute
	}
	return b.vk.SetJSON(ctx, key, st, ttl)
}

// breakerTarget picks the target kind a candidate's breaker lives on:
// connection first (the thing that actually fails), then provider.
func breakerTarget(cand *Candidate) (string, string) {
	if cand == nil || cand.Store == nil {
		return "", ""
	}
	if cand.Store.ConnectionID != "" {
		return "connection", cand.Store.ConnectionID
	}
	return "provider", cand.Store.ProviderID
}

func circuitKey(target, id string) string {
	return fmt.Sprintf("circuit:%s:%s", target, id)
}
