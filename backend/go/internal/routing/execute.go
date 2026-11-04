package routing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
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
	// RetryAfterSeconds carries an upstream Retry-After hint (waiting room /
	// rate limit) so the client response can relay it.
	RetryAfterSeconds int
	// ClientStatus overrides the taxonomy's default HTTP status for this
	// attempt's failure (e.g. a waiting room is 503, not the generic
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
// spec §9). `budget` is how many attempts this candidate may spend: Execute
// reserves one per still-viable candidate behind it, so the loop MUST stop at
// `budget` and hand the rest of the walk the remaining slots.
type AttemptFn func(ctx context.Context, cand *Candidate, next, budget int) []*Attempt

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

// minLastResortBudget is the minimum remaining request budget that justifies a
// last-resort attempt when every candidate's p95 estimate overshoots the
// deadline. It keeps a genuinely-exhausted request from starting attempts that
// cannot finish, while still giving a real upstream answer in the common case
// where p95 only slightly exceeds request_timeout_ms (e.g. p95 30.2s vs a 30s
// deadline with ~29.8s still remaining).
const minLastResortBudget = time.Second

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

	// M-e: CIRCUIT_OPEN refusals are recorded but do NOT count against
	// maxAttempts. A refusal costs no upstream round trip, so counting it
	// starved the fallback candidates: with maxAttempts=2 and two open
	// circuits ahead, the healthy third candidate was never reached.
	realAttempts := 0
	for i := 0; i < len(ordered) && realAttempts < maxAttempts; i++ {
		cand := ordered[i]

		// 1. Deadline: prefer a candidate that can finish in time. SKIP (not
		// abort) a slow one so a faster fallback still gets its turn; the
		// last-resort pass after the loop tries the best one anyway when no
		// candidate fits the budget.
		if !budgetAllows(ctx, deadline, cand) {
			continue
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

		room := maxAttempts - realAttempts
		// Reserve one attempt for every viable candidate behind this one. A
		// provider whose credential pool is LARGER than the budget otherwise
		// drains every slot on its own dead accounts and the healthy fallback is
		// never reached at all: measured live, kindred 8 zro accounts vs
		// max_attempts=6 produced request_attempt rows 1..6 *all* 402 on the
		// first candidate while a 200-serving candidate sat one slot away, and
		// the caller got a 502 with a live target unused. Capping the inner loop
		// at pool.Len() (the earlier fix) does nothing when pool.Len() > budget.
		if reserve := viableRemaining(ctx, deadline, ordered, i+1); reserve > 0 {
			if room > reserve {
				room -= reserve
			} else {
				room = 1 // never zero: this candidate still gets its own shot
			}
		}
		batch := fn(ctx, &cand, len(res.Attempts)+1, room)
		if len(batch) > room {
			batch = batch[:room]
		}
		realAttempts += len(batch)
		candidatesTried++
		for _, a := range batch {
			if a == nil {
				a = &Attempt{ErrorCode: ErrCodeInternalError}
			}
			a.Candidate = &cand
			a.Attempt = len(res.Attempts) + 1
			if a.Reason == "" {
				a.Reason = cand.Reason()
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

			// 3. Circuit feedback. RATE_LIMITED and MODEL_NOT_FOUND are
			// deliberately neutral for the breaker: a 429 is the upstream
			// saying "busy", not "dead" — free-tier concurrency caps emit
			// them under any real load — and a 404 is one account's
			// per-model gate, not the connection dying. Counting either as
			// a failure tripped the per-connection breaker and blackholed
			// every model on a healthy connection for the whole cooling-off
			// window (5 throttle responses in 60s = 30s total outage).
			if cb != nil && a.ErrorCode != ErrCodeRateLimited && a.ErrorCode != ErrCodeModelNotFound {
				cb.Result(ctx, &cand, a.ErrorCode == "")
			}

			// 4. Measured reliability (spec §30's reliability signal, which had
			// no measured input before this). Unlike the breaker above, this
			// DOES count a 429 — see reliability.go — and it is folded on this
			// goroutine, after the attempt, so it cannot delay the exchange it
			// is describing. A code the EWMA refuses to observe (a refusal, or
			// one account's per-model gate) is skipped rather than scored.
			if cb != nil {
				if outcome, observed := ReliabilityOutcome(a.ErrorCode); observed {
					cb.Observe(ctx, &cand, outcome)
				}
			}

			if a.ErrorCode == "" {
				res.Winner = a
				res.FallbackUsed = candidatesTried > 1
				return res
			}
			res.LastErrorCode = a.ErrorCode
			res.LastStatus = a.HTTPStatus

			// An attempt may override the code-based verdict when the proxy
			// proved the failure is the UPSTREAM's, not the request's: a 400
			// reporting `Failed to deserialize ... duplicate field X` was
			// measured against a byte-exact capture of the body we sent, which
			// parsed clean with zero duplicate keys — the client's request was
			// valid JSON (the proxy had already parsed it) and a sibling
			// candidate can serve it. The code stays INVALID_REQUEST for the
			// client-facing answer, but the walk must not stop on it. This is a
			// strict OR: a false ClassifyRetryable plus a true attempt flag
			// retries, and it never suppresses a retry ClassifyRetryable wanted.
			if !ClassifyRetryable(a.ErrorCode, a.HTTPStatus, a.Transport != nil) && !a.Retryable {
				res.FallbackUsed = candidatesTried > 1
				return res // request-shaped: no other target can fix it
			}
		}
	}
	// Last resort: no candidate fit the deadline budget but the request is
	// still alive. Try the best-ranked one anyway (the exchange is bounded by
	// ctx). Without this, a provider whose measured p95 exceeds
	// request_timeout_ms is permanently unroutable — every request would 502
	// with a phantom "deadline before any attempt could start" instead of the
	// real upstream answer.
	if realAttempts == 0 && len(res.Attempts) == 0 && ctx.Err() == nil && len(ordered) > 0 &&
		time.Until(deadline) >= minLastResortBudget {
		cand := ordered[0]
		batch := fn(ctx, &cand, len(res.Attempts)+1, maxAttempts)
		if len(batch) > maxAttempts {
			batch = batch[:maxAttempts]
		}
		realAttempts += len(batch)
		candidatesTried++
		for _, a := range batch {
			if a == nil {
				a = &Attempt{ErrorCode: ErrCodeInternalError}
			}
			a.Candidate = &cand
			a.Attempt = len(res.Attempts) + 1
			res.Attempts = append(res.Attempts, a)
			if a.ErrorCode == "" {
				res.Winner = a
				break
			}
			res.LastErrorCode = a.ErrorCode
			res.LastStatus = a.HTTPStatus
		}
	}
	res.FallbackUsed = candidatesTried > 1
	return res
}

// viableRemaining counts candidates from index `from` onward that could still
// accept an attempt (circuit closed, budget alive). Execute reserves one attempt
// slot per such candidate so a deep-but-dead pool cannot consume the whole walk.
// It is a cheap upper bound, not a guarantee: a candidate counted here may still
// be refused by the breaker, which only makes the reservation conservative.
func viableRemaining(ctx context.Context, deadline time.Time, ordered []Candidate, from int) int {
	n := 0
	for i := from; i < len(ordered); i++ {
		if !budgetAllows(ctx, deadline, ordered[i]) {
			continue
		}
		n++
	}
	return n
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
// Retry on: RATE_LIMITED, PROVIDER_TIMEOUT, PROVIDER_UNAVAILABLE,
// CIRCUIT_OPEN, UPSTREAM_ERROR(5xx/429/401/403), transport errors, and
// MODEL_NOT_FOUND.
//
// MODEL_NOT_FOUND used to be in the never-retry set, written when one
// credential per provider was the norm. Pools broke that assumption:
// upstreams gate models PER ACCOUNT — proved on tokenharbor 2026-10-26,
// where mimo-v2.6-flash:free answers 200 on 23 of 25 probed accounts and
// 404 "This model is unavailable right now" on the throttled rest while
// the same accounts serve other models fine. A 404 that reaches this
// table came from an UPSTREAM response (resolution-time unknowns are
// rejected before the walk starts), so it describes one account's answer,
// not the model's existence: the next Pick() rotates to a different
// account and the next candidate is a different provider. The walk stays
// bounded by MaxAttempts and the request deadline, and a genuinely
// unknown model still surfaces MODEL_NOT_FOUND after the budget is spent.
func ClassifyRetryable(code string, httpStatus int, transport bool) bool {
	if transport {
		return true
	}
	switch code {
	case ErrCodeRateLimited, ErrCodeProviderTimeout, ErrCodeProviderUnavailable, ErrCodeCircuitOpen,
		ErrCodeModelNotFound, ErrCodeInsufficientCredits:
		return true
	case ErrCodeUpstreamError:
		switch httpStatus {
		case 0, 200, 401, 403, 429:
			// 200 is here because of the 2xx ERROR ENVELOPE: an upstream that
			// answers a refusal with HTTP 200 and `{"error":...}` in the body
			// has its real status read from the body, not the header (see
			// ErrorEnvelope / the sniff in proxy.exchange). Without this row the
			// walk STOPPED on that refusal — no failover, and the client got
			// the refusal written as a 200 success. Measured 2026-11-02 on
			// tokenharbor ("Per-minute rate limit reached", HTTP 200).
			return true
		case 402:
			// An upstream 402 is the PROVIDER's quota (ClassifyUpstream maps it
			// to UPSTREAM_ERROR). A different provider may serve the same model,
			// so the walk must be allowed to move on — without this the two
			// classifiers disagreed: ClassifyUpstream(402) said retryable while
			// this said not, so the walk stopped on the first spent account and
			// the funded sibling was never reached (measured: the failover test
			// answered 502 with a healthy account one Pick away).
			return true
		}
		return httpStatus >= 500
	case ErrCodeInvalidRequest, ErrCodeUnsupportedParam, ErrCodeContextTooLong,
		ErrCodeAuthorization, ErrCodeContentRejected,
		ErrCodeAuthError:
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
	case status == 503:
		// The upstream is telling the caller "I am temporarily unavailable,
		// retry later" (horde: "no online worker"; google: "high demand, spikes
		// are usually temporary"). Keep that meaning at the edge — the client
		// gets 503, the canonical retryable-unavailable status, instead of a 502
		// that reads as "the gateway itself is broken".
		return ErrCodeProviderUnavailable, true
	case status == 502:
		// A 502 IS a bad gateway: the upstream's own edge failed to reach its
		// backend. Distinct code, so console/metrics can tell the two apart.
		return ErrCodeUpstreamError, true
	case status >= 500:
		return ErrCodeUpstreamError, true
	case status == 400 || status == 422:
		return ErrCodeInvalidRequest, false
	case status == 404:
		return ErrCodeModelNotFound, false
	case status == 413:
		return ErrCodeContextTooLong, false
	case status == 402:
		// An upstream 402 is the PROVIDER's own quota/billing state, not the
		// customer's. Mapping it to INSUFFICIENT_CREDITS told the customer to
		// top up when their balance was untouched and the fix was to route
		// elsewhere — measured live 2026-10-31: zro answered 402 "You've used
		// today's Free usage" and the client saw
		// {"code":"INSUFFICIENT_CREDITS","message":"upstream request failed"}.
		// INSUFFICIENT_CREDITS is reserved for the router's OWN budget gate
		// (PRD §129, proxy/budget.go); an upstream refusal is UPSTREAM_ERROR.
		//
		// Retryable: a different provider may serve the same model, so the walk
		// should move on. It is NOT retried against the same provider's other
		// accounts — see the per-provider short-circuit in Execute.
		return ErrCodeUpstreamError, true
	default:
		return ErrCodeUpstreamError, status >= 500
	}
}

// ErrorEnvelope sniffs an upstream body that arrived with a 2xx status but is
// NOT a completion. Some upstreams — tokenharbor.ai proved it live 2026-11-02 —
// answer an exhausted account with HTTP 200 and an error envelope in the body
// (`{"error":{"message":"Per-minute rate limit reached","code":
// "rate_limit_exceeded"}}`, or a bare `{"detail":"You exceeded your current
// quota"}`). Reading only the status made every one of those a 2xx: the walk
// recorded status='success', STOPPED (no failover), and relayed the envelope to
// the client as if it were an answer. Measured on the live ledger: of the top
// failures that day this was the one the ledger could not even see, because a
// 200 is written as success. An HTTP 200 was answering 200 with a refusal
// inside.
//
// It reports ok=true only when the body carries an error envelope AND no
// completion payload. Requiring the ABSENCE of a completion is what keeps a
// genuine answer that merely mentions the word "error" (a quoted source, a tool
// result, a refusal the model chose to write) from being discarded. code is the
// upstream's own error code when it has one, so the caller can decide
// retryability; empty otherwise.
func ErrorEnvelope(body []byte) (code string, ok bool) {
	var parsed struct {
		Error  json.RawMessage `json:"error"`
		Detail json.RawMessage `json:"detail"`
		// Completion markers: any of these means this is a real answer.
		Choices    []json.RawMessage `json:"choices"`
		Output     json.RawMessage   `json:"output"`
		Candidates json.RawMessage   `json:"candidates"`
		Content    json.RawMessage   `json:"content"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", false
	}
	if len(parsed.Choices) > 0 || parsed.Output != nil || parsed.Candidates != nil || parsed.Content != nil {
		return "", false
	}
	raw := parsed.Error
	if len(raw) == 0 {
		raw = parsed.Detail
	}
	if len(raw) == 0 {
		return "", false
	}
	// `"error":null` is not an error.
	var s string
	if json.Unmarshal(raw, &s) == nil {
		if strings.TrimSpace(s) == "" {
			return "", false
		}
		return "", true
	}
	var m struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(raw, &m)
	return m.Code, true
}

// ClassifyErrorCode maps an upstream's own error code (from a 2xx body
// envelope, or an error string) onto the taxonomy. It only recognises codes
// whose meaning is unambiguous; anything else is UPSTREAM_ERROR, which is
// retryable — a terminal 200 written as `success` is worse than one extra
// attempt, so an unknown envelope walks on to another candidate.
func ClassifyErrorCode(upstreamCode string, body []byte) (string, bool) {
	hay := strings.ToLower(upstreamCode + " " + string(body))
	switch {
	case strings.Contains(hay, "rate_limit") || strings.Contains(hay, "rate limit") ||
		strings.Contains(hay, "too many requests") || strings.Contains(hay, "slow down") ||
		strings.Contains(hay, "quota") || strings.Contains(hay, "throttl"):
		return ErrCodeRateLimited, true
	case strings.Contains(hay, "insufficient") || strings.Contains(hay, "credit") ||
		strings.Contains(hay, "payment") || strings.Contains(hay, "billing") ||
		strings.Contains(hay, "balance"):
		return ErrCodeInsufficientCredits, true
	case strings.Contains(hay, "authentication") || strings.Contains(hay, "unauthorized") ||
		strings.Contains(hay, "invalid_api_key") || strings.Contains(hay, "invalid api key"):
		return ErrCodeAuthError, true
	case strings.Contains(hay, "model_not_found") || strings.Contains(hay, "model not found") ||
		strings.Contains(hay, "no such model") || strings.Contains(hay, "unavailable right now"):
		return ErrCodeModelNotFound, true
	case strings.Contains(hay, "context_length") || strings.Contains(hay, "context length") ||
		strings.Contains(hay, "too long"):
		return ErrCodeContextTooLong, false
	case strings.Contains(hay, "overloaded") || strings.Contains(hay, "unavailable") ||
		strings.Contains(hay, "temporarily"):
		return ErrCodeProviderUnavailable, true
	case strings.Contains(hay, "timeout") || strings.Contains(hay, "timed out") ||
		strings.Contains(hay, "deadline"):
		return ErrCodeProviderTimeout, true
	case strings.Contains(hay, "invalid_request") || strings.Contains(hay, "invalid request") ||
		strings.Contains(hay, "bad request") || strings.Contains(hay, "malformed"):
		return ErrCodeInvalidRequest, false
	}
	return ErrCodeUpstreamError, true
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

// circuitState is the cached value under `circuit:v2:{target}:{id}`.
type circuitState struct {
	State      string  `json:"state"`
	Failures   []int64 `json:"failures"` // unix-millis timestamps, pruned to the window
	OpenedAtMs int64   `json:"opened_at_ms"`
	Probes     int     `json:"probes"`
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
	now := time.Now()

	b.mu.Lock()
	defer b.mu.Unlock()
	cfg := b.config(target, id)
	switch st.State {
	case CircuitOpen:
		if now.Sub(time.UnixMilli(st.OpenedAtMs)) >= time.Duration(cfg.OpenMs)*time.Millisecond {
			// Cooling-off elapsed: admit ONE probe (half-open).
			st.State = CircuitHalfOpen
			st.Probes = 0
			_ = b.save(ctx, target, id, st)
			return true
		}
		return false
	case CircuitHalfOpen:
		if st.Probes < cfg.HalfOpenProbes {
			st.Probes++
			_ = b.save(ctx, target, id, st)
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

	b.mu.Lock()
	defer b.mu.Unlock()
	cfg := b.config(target, id)
	st, err := b.load(ctx, key)
	if err != nil {
		return // state is advisory; never fail the request for it
	}
	now := time.Now()

	// The window is a real window (F2): prune failures older than
	// window_seconds BEFORE counting, then open on the surviving length. Before
	// this, Failures was a lifetime counter — a target failing once an hour for
	// six hours opened the circuit, and a four-failure burst in ten seconds that
	// recovered still held its count.
	winMs := int64(cfg.WindowSeconds) * 1000
	if winMs <= 0 {
		winMs = 60_000 // WindowSeconds is always >0 via config(), but be explicit
	}
	cutoff := now.UnixMilli() - winMs
	kept := st.Failures[:0]
	for _, ts := range st.Failures {
		if ts >= cutoff {
			kept = append(kept, ts)
		}
	}
	st.Failures = kept

	switch {
	case success:
		st = circuitState{State: CircuitClosed}
	case st.State == CircuitHalfOpen:
		// A failed probe re-opens with a fresh cooling-off window. The seeded
		// timestamps keep the count at threshold so the half-open path is
		// unchanged.
		st = circuitState{State: CircuitOpen, OpenedAtMs: now.UnixMilli(), Failures: freshFailures(cfg.FailureThreshold, now.UnixMilli())}
	default:
		st.Failures = append(st.Failures, now.UnixMilli())
		if len(st.Failures) >= cfg.FailureThreshold {
			st = circuitState{State: CircuitOpen, OpenedAtMs: now.UnixMilli(), Failures: st.Failures}
		} else {
			st.State = CircuitClosed
		}
	}
	_ = b.save(ctx, target, id, st)
}

// SetConfig replaces the breaker configuration map from the circuit_breaker
// table (F1: the map used to be wired in New with nil and never written again,
// so an operator's row changed nothing). It REPLACES rather than merges: a row
// deleted from the table must stop applying, not be served forever by a merge.
// It takes the same lock the readers hold, so a replacement is atomic with any
// in-flight decision; nil-receiver-safe like Allow/Result.
func (b *CircuitBreaker) SetConfig(cfg map[string]BreakerDefaults) {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.cfg = cfg
}

// config reads the breaker configuration. It is called only from inside the
// breaker's own locked sections (Allow/Result/save hold b.mu), so it MUST NOT
// take the lock itself — that would deadlock. SetConfig writes b.cfg under the
// same lock, and this read is serialized against that write by the caller's
// already-held lock.
//
// Callers MUST call this with b.mu held and BEFORE the first use of its return
// value. Result used to read it above the Lock, which -race flagged as a real
// data race against SetConfig on the hot path (one refreshBreakerConfig per
// request via begin() vs every in-flight Result).
func (b *CircuitBreaker) config(target, id string) BreakerDefaults {
	if c, ok := b.cfg[target+":"+id]; ok && c.FailureThreshold > 0 {
		return c
	}
	return DefaultBreaker()
}

// freshFailures returns n timestamps at nowMs, the seed an OPEN circuit stores
// so a half-open probe that fails re-opens with the count still at threshold.
// n is cfg.FailureThreshold, which config() guarantees >0.
func freshFailures(n int, nowMs int64) []int64 {
	ts := make([]int64, n)
	for i := range ts {
		ts[i] = nowMs
	}
	return ts
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

func (b *CircuitBreaker) save(ctx context.Context, target, id string, st circuitState) error {
	// M-d: the TTL comes from the breaker config of the REAL target/id. The
	// old call was b.config("provider", "") — a key that never exists in the
	// cfg map, so every save silently used DefaultBreaker's window and a
	// per-target WindowSeconds was ignored on the write side.
	// The state is ephemeral (spec §12: Valkey may lose it), so it carries a
	// short TTL rather than living forever: a stale OPEN must age out even if
	// the process that wrote it is gone.
	ttl := time.Duration(b.config(target, id).WindowSeconds) * time.Second
	if ttl <= 0 {
		ttl = time.Minute
	}
	return b.vk.SetJSON(ctx, circuitKey(target, id), st, ttl)
}

// breakerTarget picks the target kind a candidate's breaker lives on: the
// provider_model first, then connection, then provider.
//
// Per-model is the correct granularity because the failures are per-model in
// practice: a throttle, a removed model, a per-model quota. Keying on the
// CONNECTION meant one 429 on one OVH model opened the circuit for the
// connection and blackholed the thirteen siblings served by it.
//
// OPERATOR NOTE: a circuit_breaker row only applies when its (target, target_id)
// matches what breakerTarget picks, and every routed candidate carries a
// provider_model id — so target='model' is the only kind that matches in
// practice. A row with target='connection' or target='provider' will silently
// never fire (config() falls back to DefaultBreaker). The fallback chain below
// is reached only by a candidate with NO provider_model, which the catalogue
// does not produce today.
func breakerTarget(cand *Candidate) (string, string) {
	if cand == nil || cand.Store == nil {
		return "", ""
	}
	if cand.Store.ProviderModelID != "" {
		return "model", cand.Store.ProviderModelID
	}
	if cand.Store.ConnectionID != "" {
		return "connection", cand.Store.ConnectionID
	}
	return "provider", cand.Store.ProviderID
}

func circuitKey(target, id string) string {
	// circuit:v2: — the stored value's failure shape changed from an int count
	// to a timestamp ring (F2). A v1 entry decoded into the new shape would read
	// as zero failures (harmless), but the bump makes that boundary explicit, and
	// a v1 OPEN state is deliberately forgotten so the target gets one immediate
	// probe — safer than the opposite, where a forgotten v1 CLOSED would let a
	// dead target be retried.
	return fmt.Sprintf("circuit:v2:%s:%s", target, id)
}
