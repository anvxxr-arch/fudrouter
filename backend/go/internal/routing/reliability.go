package routing

// Measured per-(model x provider) reliability: an exponentially weighted moving
// average of attempt outcomes, kept in Valkey under its own key and fed into the
// candidate score's reliability term.
//
// WHY A SEPARATE STORE FROM THE CIRCUIT BREAKER. The breaker already observes
// every attempt and is already keyed per (model x provider) via breakerTarget,
// so it looks like the natural home — but its decisions are the opposite of what
// ranking needs:
//
//   - The breaker REFUSES (binary, 30s cooling-off, and only for the codes it
//     counts). Ranking must GRADUALLY demote: a target that is merely slower to
//     serve than its siblings should fall behind them, not be taken out.
//   - The breaker deliberately DISCARDS RATE_LIMITED and MODEL_NOT_FOUND
//     (execute.go step 3): counting a 429 as a failure once blackholed every
//     model on a healthy connection for the whole cooling-off window, so a
//     refusal had to stop being the response. For RANKING the same 429 is the
//     single most useful signal there is — "alive, but not serving right now" —
//     and it is exactly the signal a demotion should be able to see. The two
//     consumers want the same observation answered differently, so they cannot
//     share one counter.
//   - The breaker's state carries a TTL of its failure WINDOW (60s), which is
//     long enough to refuse and far too short to rank on.
//
// So this is a second, longer-memory reading of the same traffic. It never
// refuses anything: a collapsed value only changes ORDER (see Select), and a
// target with no measurement stays exactly where it ranks today.
//
// HALF-LIFE: 120s, i.e. twice the breaker's own failure window (60s) and four
// times its cooling-off (30s). The horizon a routing rank should track is "how
// has this target behaved for the last couple of minutes" — the span over which
// a free tier is spent, a regional endpoint degrades, or a credential pool
// drains. Much shorter and one throttled minute outvotes weeks of history;
// much longer (an hour) and a target whose every credential is spent outranks a
// healthy sibling for an hour, which is the exact failure the credential-fraction
// damping in LoadSignals already had to be added for (prv-zro, 2026-11-02).
//
// WRITE-TIME, NOT READ-TIME. The fold happens in Observe, on the same goroutine
// and immediately after the attempt that produced the observation, and it rides
// one Valkey Get+Set on a path that is already past the client's critical
// moment (the attempt has completed; either the response is being relayed or the
// fallback walk is already moving on). The selection path is the latency-critical
// one, and it reads the whole candidate set at once: computing there would mean
// a read-modify-write per candidate on admission. Selection therefore only READS,
// through FillReliability (one MGET for the entire set, the same shape
// fillCandidatePricing already uses), and never writes — which also means the
// request path can never block on a counter update.
//
// The read applies the elapsed decay (decayTowardsPrior) so a value stops
// mattering without needing a write to age it — otherwise a demoted target that
// stops being selected would freeze at its bad value until the key's TTL.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/vk"
)

const (
	// reliabilityHalfLife is the time for one observation's influence to halve.
	// See the package comment above for why 120s.
	reliabilityHalfLife = 120 * time.Second

	// reliabilityPrior is what an unmeasured target reads as, and the value a
	// measurement decays toward. It is neutralAvailability so a target with no
	// history ranks precisely where it ranked before this existed — the same
	// "a missing claim is not a claim" rule the capability filter and
	// LoadSignals follow.
	reliabilityPrior = neutralAvailability

	// reliabilityTTL bounds the key's lifetime so a target that leaves the
	// catalogue does not hold a score forever. It is NOT the memory of the
	// signal: with a 120s half-life an hour is ~30 half-lives, so a stored value
	// has already decayed to the prior by the time this fires, and the read-time
	// decay above means the value self-ages even while nothing is written.
	reliabilityTTL = time.Hour

	// maxObservationWeight caps one observation's influence at the weight of a
	// half-life-old sample (0.5). Without the cap the raw 2^(-dt/H) is ~1 for
	// anything microseconds apart, so an unbroken burst of failures — the one
	// case a ranking signal exists for — each computed next = 1*prev + 0*outcome
	// and changed nothing at all. The same cap gives a target with NO precursor
	// (dt pinned to zero below) a half-way first step, so a single request cannot
	// pin a target's rank.
	maxObservationWeight = 0.5
)

// reliabilityState is the value under `reliability:v1:{target}:{id}`. Two fields:
// the EWMA in [0,1] and the wall-clock ms of the write, which is what makes the
// decay computable without a per-sample timer.
type reliabilityState struct {
	V  float64 `json:"v"`
	At int64   `json:"at_ms"`
}

// reliabilityKey is the per-(model x provider) key. It is deliberately NOT the
// breaker's key: the two have different lifetimes and different meanings, and
// sharing one would make a breaker write a ranking write and vice versa.
func reliabilityKey(target, id string) string {
	return fmt.Sprintf("reliability:v1:%s:%s", target, id)
}

// reliabilityWeight is the fraction of the stored value that survives `dt`:
// 2^(-dt/H), clamped to [0,1].
func reliabilityWeight(dt time.Duration) float64 {
	if dt <= 0 {
		return 1
	}
	w := math.Exp2(-dt.Seconds() / reliabilityHalfLife.Seconds())
	if w < 0 {
		return 0
	}
	if w > 1 {
		return 1
	}
	return w
}

// decayTowardsPrior is what a stored value reads as with no further observations:
// its distance from the prior shrinks by the same weight a new sample would eat.
func decayTowardsPrior(v float64, atMs int64, now time.Time) float64 {
	if atMs <= 0 {
		return reliabilityPrior
	}
	w := reliabilityWeight(now.Sub(time.UnixMilli(atMs)))
	return w*v + (1-w)*reliabilityPrior
}

// Reliability returns the measured success EWMA and whether the target has ever
// been measured. Unmeasured is NOT zero: a new provider must neither win nor
// lose every route on no evidence.
func (c Candidate) Reliability() (float64, bool) { return c.reliability, c.reliabilityMeasured }

// reliabilityCollapsed is the demotion threshold Select reads: a MEASURED
// reliability below this parks the candidate behind every candidate that has not
// collapsed, whatever the strategy ranked it by.
//
// 0.5 is a half-life of evidence, not a success-rate policy. With the sample
// weight capped at 0.5 (maxObservationWeight) a target that was sitting on the
// neutral 0.95 prior and then fails once reads 0.475 — under the line — and one
// that alternates success and failure settles around 0.5. Both are "try the
// sibling first", not "this target is dead": the breaker owns that judgement, and
// the read-time decay walks a demoted target back up over the same 120s
// half-life that put it down, so a transient dip costs a couple of minutes of
// rank and nothing else.
func (c Candidate) reliabilityCollapsed() bool {
	return c.reliabilityMeasured && c.reliability < 0.5
}

// reliabilitySignal is the score's reliability term: the MEASUREMENT when one
// exists, and today's declared availability claim (config availability, health
// status, damped by the credential fraction) when it does not. It replaced a
// declarative value outright rather than being averaged with one, because the
// point of measuring is that the observation outranks the claim: an operator's
// `availability: 0.99` on a connection whose attempts have failed for the last
// two minutes is precisely the claim the measurement exists to contradict.
func (c Candidate) reliabilitySignal() float64 {
	if c.reliabilityMeasured {
		return c.reliability
	}
	return c.Availability
}

// ReliabilityOutcome maps a PRD §88 taxonomy code onto the EWMA sample, and
// reports whether that code is an observation at all.
//
// Success is 1 and every other observed failure is 0: the EWMA is a success
// RATE, so a graded scale would only hide which side of the line a code fell on.
//
// Two codes are deliberately NOT observations, each for a reason the breaker's
// own comment already established:
//
//   - MODEL_NOT_FOUND is one ACCOUNT's per-model gate, not a property of the
//     target, and the attempt loop may rotate to another credential on the same
//     target and succeed. Recording it would demote a target for a sibling
//     credential's state.
//   - CIRCUIT_OPEN is a refusal, not an exchange: no upstream round trip
//     happened, so there is nothing to measure. It also lets Execute call this
//     from the one place that sees real attempts only. It is listed explicitly
//     rather than left to the default so a future call site cannot silently
//     start scoring refusals as failures.
//
// RATE_LIMITED is on the observed side on purpose, and it is the clearest
// example of why this store is separate from the breaker: the breaker must
// ignore a 429 or it blackholes a healthy connection, but a 429 is exactly the
// evidence that this target is not serving and another one should be tried first.
func ReliabilityOutcome(code string) (float64, bool) {
	switch code {
	case "":
		return 1, true
	case ErrCodeModelNotFound, ErrCodeCircuitOpen:
		return 0, false
	}
	return 0, true
}

// Observe folds one real attempt's outcome into the candidate's target EWMA.
//
// It is called from Execute's attempt loop, which holds a *CircuitBreaker and no
// other per-attempt state store — so it lives here rather than on a type of its
// own. It deliberately does NOT read or write circuit state and does NOT take
// b.mu: the breaker's lock guards its config map, and a ranking sample has no
// business contending for it.
//
// The read-modify-write is not atomic against a concurrent attempt on the same
// target, and that is accepted: two interleaved samples lose one, which moves the
// average by less than one sample's weight. Valkey is a cache/counter layer
// (spec §12) and PostgreSQL is authoritative — a lost ranking sample cannot lose
// business data, only delay a demotion by one observation.
func (b *CircuitBreaker) Observe(ctx context.Context, cand *Candidate, outcome float64) {
	if b == nil || cand == nil {
		return
	}
	target, id := breakerTarget(cand)
	if id == "" {
		return
	}
	key := reliabilityKey(target, id)
	now := time.Now()

	var st reliabilityState
	// ttl=0 disables valkey-go's client-side cache on PURPOSE. A cached read here
	// would serve a stale value back into the write below, so the demotion a
	// burst of failures is supposed to produce would only land when the client
	// cache expired — the ranking would lag the traffic by the cache TTL.
	err := b.vk.GetJSON(ctx, key, &st, 0)
	if err != nil && !errors.Is(err, vk.ErrNotFound) {
		return // state is advisory; never fail or delay a request for it
	}

	// dt=0 for a target with no precursor, so the cap below gives the first
	// sample half a step instead of replacing the prior outright.
	dt := time.Duration(0)
	if st.At > 0 {
		dt = now.Sub(time.UnixMilli(st.At))
	}
	if dt < 0 {
		dt = 0 // a clock step must not make a sample weightless
	}
	w := reliabilityWeight(dt)
	if w > maxObservationWeight {
		w = maxObservationWeight
	}

	prev := reliabilityPrior
	if st.At > 0 && st.V > 0 {
		prev = st.V
	}
	next := reliabilityState{V: w*prev + (1-w)*outcome, At: now.UnixMilli()}
	_ = b.vk.SetJSON(ctx, key, next, reliabilityTTL)
}

// FillReliability reads the whole candidate set's measured reliability in ONE
// Valkey round trip and installs it on each candidate.
//
// Batched for the same reason fillCandidatePricing is: the set is N candidates
// and a per-candidate read would be N round trips on the admission path. A
// failed read fills nothing, which leaves every candidate on its declared
// availability — the pre-existing behaviour, so a Valkey outage degrades to
// ranking without measurement rather than to ranking on zeroes.
//
// Candidates are mutated in place through the slice; the reliability fields are
// unexported and this is the only writer on the read side.
func (b *CircuitBreaker) FillReliability(ctx context.Context, cands []Candidate) {
	if b == nil || len(cands) == 0 {
		return
	}
	keys := make([]string, 0, len(cands))
	idx := make([]int, 0, len(cands))
	for i := range cands {
		target, id := breakerTarget(&cands[i])
		if id == "" {
			continue
		}
		keys = append(keys, reliabilityKey(target, id))
		idx = append(idx, i)
	}
	if len(keys) == 0 {
		return
	}

	raw := make(map[string]json.RawMessage, len(keys))
	if err := b.vk.GetJSONMany(ctx, keys, raw, 0); err != nil {
		return
	}
	now := time.Now()
	for n, i := range idx {
		buf, ok := raw[keys[n]]
		if !ok {
			continue // never measured for this target
		}
		var st reliabilityState
		if json.Unmarshal(buf, &st) != nil {
			continue
		}
		// Guard on At, not on V: a value of 0 is a perfectly real reading (a
		// target that has failed every observed attempt), and skipping it would
		// let exactly the worst target keep its neutral prior.
		if st.At <= 0 {
			continue
		}
		cands[i].reliability = decayTowardsPrior(st.V, st.At, now)
		cands[i].reliabilityMeasured = true
	}
}
