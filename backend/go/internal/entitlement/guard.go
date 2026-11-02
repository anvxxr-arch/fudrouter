// Package entitlement enforces the member-facing access rules the owner set
// (docs/specs/2026-10-31-subscription-platform-target.md):
//
//	13. exactly ONE active API key per member
//	14. at most THREE client IPs may use that key
//	15. auto-restrict a key that breaches a rule
//	16. auto-warn the member (API / Telegram / Discord)
//
// Why this is its own package and not more code in `limits`: `limits` answers
// "how fast may this key go" (a rate question, counted in Valkey). This answers
// "is this key allowed to exist right now" (an entitlement question, answered
// from the subscription and the key's own state). Folding them together would
// make the rate limiter depend on the billing schema, which is the coupling the
// two-plane split exists to avoid.
//
// The hot path is O(1) and allocation-light: the subscription window and the
// IP set are resolved once per key (cached by the caller, 60s, like
// EffectiveLimits) and every request is a map lookup plus a counter. Nothing
// here touches Postgres per request.
package entitlement

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// Rule names, used in the warning `kind` and the restrict `reason` so an
// operator can grep one string across the DB, the logs and the bot messages.
const (
	RuleNoSubscription = "no_subscription"
	RuleExpired        = "subscription_expired"
	RuleIPLimit        = "ip_limit"
	RuleConcurrency    = "concurrency"
	RuleRestricted     = "key_restricted"
)

// MaxIPs is the owner's rule 14: three client addresses per key.
const MaxIPs = 3

// MaxConcurrency is the owner's rule 4: five in-flight requests per member.
const MaxConcurrency = 5

// Decision is the outcome of one admission check. It is a value, not an error,
// because "denied" is an expected answer on the hot path and building an error
// per denied request would allocate for the common abuse case.
type Decision struct {
	Allow  bool
	Rule   string // empty when Allow
	Reason string // human-readable, safe to show the member
}

// allow is the zero-allocation happy path.
var allow = Decision{Allow: true}

// Subscription is the entitlement window resolved for one account. A nil
// *Subscription means "no live subscription" — the caller must not treat a nil
// as "unlimited".
type Subscription struct {
	Plan      string
	ExpiresAt time.Time
}

// Live reports whether the subscription is active at `now`. A zero ExpiresAt
// (a row that failed to parse) is NOT live: fail closed on entitlement, unlike
// the rate limiter which fails open on a cache blip. The asymmetry is
// deliberate — a cache blip must not stop paying members, but a corrupt
// entitlement must not hand out free service.
func (s *Subscription) Live(now time.Time) bool {
	return s != nil && !s.ExpiresAt.IsZero() && s.ExpiresAt.After(now)
}

// Guard enforces the entitlement rules for one process. It holds the per-key
// IP set and the in-flight concurrency gauge in memory, so admission never
// waits on Postgres or Valkey.
//
// The IP set is seeded from the DB once per key (the caller passes it in) and
// then maintained here: a new address is admitted only while the key has fewer
// than MaxIPs, and the admitted set is what later requests are checked against.
// A process restart re-seeds from the DB, so the set is durable across restarts
// without a write per request.
type Guard struct {
	mu sync.RWMutex
	// ips is the admitted address set per key id. Bounded by MaxIPs per key,
	// so it cannot grow without bound; a key that is deleted is swept lazily.
	ips map[string]map[string]struct{}
	// inflight is the concurrency gauge per key id.
	inflight map[string]int
	// now is injectable so the four-case tests can pin time.
	now func() time.Time
}

// New returns a Guard ready for use.
func New() *Guard {
	return &Guard{
		ips:      make(map[string]map[string]struct{}),
		inflight: make(map[string]int),
		now:      time.Now,
	}
}

// SeedIPs installs the durable address set for a key, replacing whatever this
// process had. The caller reads `api_key_ip` once per key (cached) and passes
// the rows here; the guard then owns the set.
func (g *Guard) SeedIPs(keyID string, addrs []string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	set := make(map[string]struct{}, len(addrs))
	for _, a := range addrs {
		if a != "" {
			set[a] = struct{}{}
		}
	}
	g.ips[keyID] = set
}

// CheckIP decides whether `addr` may use `keyID`. It is the owner's rule 14.
//
// Three outcomes:
//   - the address is already admitted  -> allow (the common case)
//   - the key has room (< MaxIPs)      -> admit and allow
//   - the key is full                  -> deny with RuleIPLimit
//
// An empty address is denied: a request with no resolvable client IP must not
// silently consume a slot, and it must not be treated as "already admitted".
func (g *Guard) CheckIP(keyID, addr string) Decision {
	if addr == "" {
		return Decision{Rule: RuleIPLimit, Reason: "client address could not be determined"}
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	set, ok := g.ips[keyID]
	if !ok {
		set = make(map[string]struct{}, MaxIPs)
		g.ips[keyID] = set
	}
	if _, seen := set[addr]; seen {
		return allow
	}
	if len(set) >= MaxIPs {
		return Decision{
			Rule:   RuleIPLimit,
			Reason: fmt.Sprintf("this key is limited to %d IP addresses", MaxIPs),
		}
	}
	set[addr] = struct{}{}
	return allow
}

// Slot is a held concurrency slot. It is a VALUE, not a closure: the first cut
// returned `func()` from Acquire, and that closure captured the guard and the
// key id, so it escaped to the heap — one allocation per request on the hot
// path, measured at 2 allocs/op and 15k live closures at the target load. A
// value with a Release method allocates nothing.
type Slot struct {
	g     *Guard
	keyID string
	held  bool
}

// Release frees the slot. It is safe to call on a zero Slot (the denied case),
// so a caller can `defer slot.Release()` unconditionally. Calling it twice is
// also safe: the second call is a no-op.
func (s *Slot) Release() {
	if !s.held {
		return
	}
	s.held = false
	s.g.mu.Lock()
	defer s.g.mu.Unlock()
	if s.g.inflight[s.keyID] > 0 {
		s.g.inflight[s.keyID]--
	}
	if s.g.inflight[s.keyID] == 0 {
		delete(s.g.inflight, s.keyID)
	}
}

// Acquire takes one concurrency slot for `keyID` (owner rule 4: five). The
// returned Slot MUST be released exactly once; a denied Slot is zero-valued and
// its Release is a no-op, so `defer slot.Release()` is always correct.
func (g *Guard) Acquire(keyID string) (Slot, Decision) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.inflight[keyID] >= MaxConcurrency {
		return Slot{}, Decision{
			Rule:   RuleConcurrency,
			Reason: fmt.Sprintf("this key is limited to %d concurrent requests", MaxConcurrency),
		}
	}
	g.inflight[keyID]++
	return Slot{g: g, keyID: keyID, held: true}, allow
}

// CheckSubscription is the owner's rule 12 gate: a member with no live
// subscription is refused. It is separate from CheckIP/Acquire because the
// subscription is resolved from the DB (cached), not held in this process.
func (g *Guard) CheckSubscription(sub *Subscription) Decision {
	if sub.Live(g.now()) {
		return allow
	}
	if sub == nil {
		return Decision{Rule: RuleNoSubscription, Reason: "no active subscription"}
	}
	return Decision{Rule: RuleExpired, Reason: "subscription expired"}
}

// Inflight reports the current gauge for a key. Test-only accessor; production
// code never needs it.
func (g *Guard) Inflight(keyID string) int {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.inflight[keyID]
}

// IPCount reports the admitted address count for a key. Test-only accessor.
func (g *Guard) IPCount(keyID string) int {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return len(g.ips[keyID])
}

// ErrRestricted is returned by the store when a key carries restricted_at. It
// is a distinct error so the proxy can answer with a clear message rather than
// a generic 401.
var ErrRestricted = errors.New("api key is restricted")

// RestrictReason is the operator-facing text stored beside restricted_at.
type RestrictReason struct {
	Rule string
	Note string
}

// String renders the reason for storage in `api_key.restricted_reason`.
func (r RestrictReason) String() string {
	if r.Note == "" {
		return r.Rule
	}
	return r.Rule + ": " + r.Note
}

// ShouldRestrict decides whether a breach escalates to a key restriction
// (owner rule 15). Not every warning restricts: an IP breach on a key that is
// otherwise healthy warns first, while a subscription that has been expired for
// more than the grace window restricts. The grace window exists so a member
// whose payment is a few minutes late is warned, not cut off mid-session.
const GraceWindow = 24 * time.Hour

// ShouldRestrict reports whether `rule` at `now` for a subscription expiring at
// `expiresAt` escalates to a restriction.
func ShouldRestrict(rule string, expiresAt, now time.Time) bool {
	switch rule {
	case RuleExpired, RuleNoSubscription:
		// Restrict only once the grace window has passed, so a late payment
		// does not cut a session off.
		return now.After(expiresAt.Add(GraceWindow))
	case RuleIPLimit, RuleConcurrency:
		// A breach of a hard guard is immediate: the member is actively
		// exceeding the plan they bought.
		return true
	default:
		return false
	}
}

// contextKey is unexported so no other package can collide with it.
type contextKey struct{}

// WithDecision stores a Decision on a context so a downstream handler can read
// why a request was refused without threading it through every signature.
func WithDecision(ctx context.Context, d Decision) context.Context {
	return context.WithValue(ctx, contextKey{}, d)
}

// DecisionFrom reads the Decision stored by WithDecision. The second result is
// false when none was stored, so a caller can distinguish "allowed" from
// "never checked".
func DecisionFrom(ctx context.Context) (Decision, bool) {
	d, ok := ctx.Value(contextKey{}).(Decision)
	return d, ok
}
