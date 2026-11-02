package routing

// Measured-reliability ranking: the three properties that motivated
// reliability.go, plus the outcome mapping its deliberate divergence from the
// breaker depends on.
//
// Why these tests exist and what each prevents:
//
//  1. TestReliabilityOpenCircuitDoesNotPoisonTheModel — the HA property. A model
//     served by several providers must survive ONE provider_model being refused.
//     This is the premise the task started from, and the source already gets it
//     right (breakerTarget picks the provider_model), so the test is a REGRESSION
//     PIN, not a fix: it fails the moment someone re-keys the breaker to the
//     provider or the connection, which is precisely the mistake the premise
//     assumed had already been made.
//  2. TestMeasuredReliabilityReordersEqualCandidates — the EWMA must actually
//     reach the score. Two candidates equal on every declared signal must swap
//     places purely because one of them failed attempts and the other did not.
//  3. TestReliabilityDemotesWithoutOpeningTheBreaker — the reason this is a
//     SECOND reading of the traffic rather than a reuse of the breaker: a target
//     throttled (429) has not tripped anything (the breaker deliberately ignores
//     429s) yet must still fall behind a sibling.
//  4. TestReliabilityOutcomeIgnoresRefusalsAndModelGates — pins the two codes
//     that are NOT observations, so a later call site cannot start scoring a
//     CIRCUIT_OPEN refusal (no upstream exchange happened) or one account's
//     per-model 404 as a target failure.

import (
	"context"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/vk"
)

// reliabilityPlan keeps every declared signal NEUTRAL so the only thing that can
// move a candidate is the measurement: same price, same p95, same availability,
// same priority, no credentials to trip the credential partition.
func reliabilityCandidate(pmID, providerID, name string, priority int) Candidate {
	c := build("m", providerID, name, priority, 500, 500, 300, neutralAvailability)
	c.Store.ProviderModelID = pmID
	return c
}

// TestReliabilityOpenCircuitDoesNotPoisonTheModel is the HA regression pin.
//
// One provider_model is refused (its own circuit is OPEN) and its measured
// reliability has collapsed; the SAME model on a sibling provider must still be
// selected and served. A breaker keyed on the provider or the connection instead
// of the provider_model would take the whole model down here, and this test is
// the thing that notices.
func TestReliabilityOpenCircuitDoesNotPoisonTheModel(t *testing.T) {
	ctx := context.Background()

	dead := reliabilityCandidate("pmdl_dead", "prv_a", "deadco", 1)
	live := reliabilityCandidate("pmdl_live", "prv_b", "liveco", 2)

	cb := NewCircuitBreaker(vk.NewFake(), map[string]BreakerDefaults{
		// Keyed "model:<provider_model.id>" — the target breakerTarget picks.
		"model:pmdl_dead": {FailureThreshold: 1, WindowSeconds: 60, OpenMs: 60_000, HalfOpenProbes: 1},
	})

	// Trip deadco's own circuit with one failing attempt.
	fail := func(_ context.Context, _ *Candidate, _ int, _ int) []*Attempt {
		return []*Attempt{{HTTPStatus: 503, ErrorCode: ErrCodeProviderUnavailable}}
	}
	_ = Execute(ctx, []Candidate{dead}, Plan{Strategy: StrategyProviderPriority, MaxAttempts: 1, FallbackEnabled: false}, time.Time{}, cb, fail)

	// The refusal must be scoped to the provider_model, not to the model.
	if cb.Allow(ctx, &dead) {
		t.Fatal("deadco's circuit is still closed after a failure at threshold 1")
	}
	if !cb.Allow(ctx, &live) {
		t.Fatal("the sibling provider_model was refused by deadco's circuit — the breaker poisoned the model")
	}

	// Order the pair WITHOUT a breaker hint first: deadco has the better
	// priority, so only the measurement can move it. The slice must be held in a
	// variable: FillReliability installs the values on the SLICE, so a fresh
	// literal at the Select call would silently discard them.
	pair := []Candidate{dead, live}
	cb.FillReliability(ctx, pair)
	ordered := Select(pair, Plan{Strategy: StrategyHighestReliability})
	if got := names(ordered); got[0] != "liveco" {
		t.Fatalf("order = %v, want liveco first — a collapsed sibling must not outrank a healthy target", got)
	}
	if v, ok := pair[0].Reliability(); !ok || v >= 0.5 {
		t.Fatalf("deadco reliability = (%v, measured=%v), want a collapsed measurement", v, ok)
	}

	// And the model still SERVES: the walk skips the open circuit and lands on
	// the sibling.
	serve := func(_ context.Context, cand *Candidate, _ int, _ int) []*Attempt {
		if cand.Store.ProviderName == "liveco" {
			return []*Attempt{{Payload: "ok"}}
		}
		return []*Attempt{{HTTPStatus: 503, ErrorCode: ErrCodeProviderUnavailable}}
	}
	servePlan := Plan{Strategy: StrategyHighestReliability, MaxAttempts: 2, FallbackEnabled: true}
	res := Execute(ctx, ordered, servePlan, time.Time{}, cb, serve)
	if res.Winner == nil || res.Winner.Candidate.Store.ProviderName != "liveco" {
		t.Fatalf("winner = %+v, want liveco — one dead provider_model took the model down", res.Winner)
	}
}

// TestMeasuredReliabilityReordersEqualCandidates: the EWMA must reach the score.
// Both candidates are identical on every declared signal, so the ONLY input that
// can separate them is the measurement — which must have been written by the
// attempt loop and read back by FillReliability, not injected by the test.
func TestMeasuredReliabilityReordersEqualCandidates(t *testing.T) {
	ctx := context.Background()

	a := reliabilityCandidate("pmdl_a", "prv_a", "flakyco", 1)
	b := reliabilityCandidate("pmdl_b", "prv_b", "steadyco", 2)

	cb := NewCircuitBreaker(vk.NewFake(), map[string]BreakerDefaults{
		// High threshold: nothing opens here, this test is about RANKING only.
		"model:pmdl_a": {FailureThreshold: 99, WindowSeconds: 60, OpenMs: 60_000, HalfOpenProbes: 1},
		"model:pmdl_b": {FailureThreshold: 99, WindowSeconds: 60, OpenMs: 60_000, HalfOpenProbes: 1},
	})

	// Drive REAL attempts through Execute so the observations are produced by the
	// code under test rather than by the test poking fields. One candidate per
	// run keeps each target's breaker/Ranking state its own.
	broken := func(_ context.Context, _ *Candidate, _ int, _ int) []*Attempt {
		return []*Attempt{{HTTPStatus: 503, ErrorCode: ErrCodeProviderUnavailable}}
	}
	healthy := func(_ context.Context, _ *Candidate, _ int, _ int) []*Attempt {
		return []*Attempt{{Payload: "ok"}}
	}
	one := Plan{Strategy: StrategyHighestReliability, MaxAttempts: 1, FallbackEnabled: false}
	// `a` fails twice then recovers; `b` succeeds throughout. Both must end
	// ABOVE the demotion threshold — a's sequence reads 0.475, 0.2375, then
	// 0.6188 once a success lands on the decayed value — so the collapsed-target
	// partition cannot be what separates them. Only the comparator can. Without
	// that, a strategy that silently stopped reading the measurement would still
	// pass this test on the demotion alone.
	broken2 := 2
	for range broken2 {
		_ = Execute(ctx, []Candidate{a}, one, time.Time{}, cb, broken)
	}
	_ = Execute(ctx, []Candidate{a}, one, time.Time{}, cb, healthy)
	for range 3 {
		_ = Execute(ctx, []Candidate{b}, one, time.Time{}, cb, healthy)
	}

	// Baseline: before the measurement is loaded, the tie is broken by priority,
	// so flakyco (priority 1) leads.
	before := Select([]Candidate{a, b}, Plan{Strategy: StrategyHighestReliability})
	if got := names(before); got[0] != "flakyco" {
		t.Fatalf("pre-measurement order = %v, want flakyco first on priority", got)
	}

	// After the measurement is loaded the two swap: every declared signal is
	// equal, so reliability is the only thing that moved.
	pair := []Candidate{a, b}
	cb.FillReliability(ctx, pair)
	after := Select(pair, Plan{Strategy: StrategyHighestReliability})
	if got := names(after); got[0] != "steadyco" {
		t.Fatalf("post-measurement order = %v, want steadyco first — the measured EWMA did not reach the score", got)
	}

	// The same reversal must show up in `balanced`, which weights the measured
	// value through balancedScore's reliability term rather than comparing it
	// directly. Both candidates are above the demotion threshold, so this is the
	// score's own reading of the measurement, not the partition.
	relHeavy := Plan{Strategy: StrategyBalanced, Weights: Weights{Reliability: 1}}
	balanced := Select(pair, relHeavy)
	if got := names(balanced); got[0] != "steadyco" {
		t.Fatalf("balanced order = %v, want steadyco first — the reliability weight is not reading the measurement", got)
	}
}

// TestReliabilityDemotesWithoutOpeningTheBreaker is the reason reliability is a
// SEPARATE reading from the breaker.
//
// A 429 is deliberately invisible to the breaker (counting it blackholed whole
// connections). For ranking it is the most useful signal available: "alive, but
// not serving right now". So the same traffic must leave the circuit CLOSED while
// moving the target to the back of the order.
func TestReliabilityDemotesWithoutOpeningTheBreaker(t *testing.T) {
	ctx := context.Background()

	// cheapco is strictly CHEAPER than priceyco, so `lowest_cost` ranks it first
	// on price alone — the same trap the credential partition was added for.
	cheap := reliabilityCandidate("pmdl_cheap", "prv_a", "cheapco", 1)
	cheap.PriceInputMicro, cheap.PriceOutputMicro = 1, 1
	pricey := reliabilityCandidate("pmdl_pricey", "prv_b", "priceyco", 9)
	pricey.PriceInputMicro, pricey.PriceOutputMicro = 10_000, 10_000

	cb := NewCircuitBreaker(vk.NewFake(), nil)

	// Baseline: the cheaper target leads.
	if got := names(Select([]Candidate{cheap, pricey}, Plan{Strategy: StrategyLowestCost})); got[0] != "cheapco" {
		t.Fatalf("baseline order = %v, want cheapco first on price", got)
	}

	// Throttle it through real attempts.
	throttled := func(_ context.Context, _ *Candidate, _ int, _ int) []*Attempt {
		return []*Attempt{{HTTPStatus: 429, ErrorCode: ErrCodeRateLimited}}
	}
	one := Plan{Strategy: StrategyLowestCost, MaxAttempts: 1, FallbackEnabled: false}
	for range 3 {
		_ = Execute(ctx, []Candidate{cheap}, one, time.Time{}, cb, throttled)
	}

	// No breaker involvement: 429s do not trip it.
	if !cb.Allow(ctx, &cheap) {
		t.Fatal("a throttled target was refused by the breaker — 429 must stay invisible to it")
	}

	pair := []Candidate{cheap, pricey}
	cb.FillReliability(ctx, pair)
	if v, ok := pair[0].Reliability(); !ok || v >= 0.5 {
		t.Fatalf("cheapco reliability = (%v, measured=%v), want a collapsed measurement", v, ok)
	}

	// `lowest_cost` still ranks on price, but the collapsed target must be
	// demoted behind the healthy sibling.
	got := names(Select(pair, Plan{Strategy: StrategyLowestCost}))
	if got[0] != "priceyco" {
		t.Fatalf("order = %v, want priceyco first — a collapsed target kept winning `lowest_cost` on price", got)
	}
	if got[1] != "cheapco" {
		t.Fatalf("order = %v, want cheapco demoted to the back rather than dropped", got)
	}
}

// TestReliabilityOutcomeIgnoresRefusalsAndModelGates pins WHICH codes are an
// observation. A CIRCUIT_OPEN refusal cost no upstream round trip, so there is
// nothing to measure, and a MODEL_NOT_FOUND is one account's per-model gate that
// the attempt loop may rotate past to a working credential on the SAME target —
// scoring either would demote a target for something it did not do.
func TestReliabilityOutcomeIgnoresRefusalsAndModelGates(t *testing.T) {
	cases := []struct {
		code     string
		want     float64
		observed bool
	}{
		{"", 1, true},
		{ErrCodeProviderUnavailable, 0, true},
		{ErrCodeUpstreamError, 0, true},
		// The crux: the breaker ignores this, ranking must not.
		{ErrCodeRateLimited, 0, true},
		// Deliberately unobservable.
		{ErrCodeModelNotFound, 0, false},
		{ErrCodeCircuitOpen, 0, false},
	}
	for _, tc := range cases {
		got, ok := ReliabilityOutcome(tc.code)
		if ok != tc.observed || got != tc.want {
			t.Errorf("ReliabilityOutcome(%q) = (%v, %v), want (%v, %v)", tc.code, got, ok, tc.want, tc.observed)
		}
	}
}
