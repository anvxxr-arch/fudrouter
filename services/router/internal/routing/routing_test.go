package routing

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/services/router/internal/store"
	"github.com/anvxxr-arch/fudrouter/services/router/internal/vk"
)

// build makes a candidate with explicit ranking signals. The store side is the
// minimum the selector reads: provider identity, priority, model slug, region.
func build(model, providerID, providerName string, priority int, input, output, latency int64, avail float64) Candidate {
	c := Candidate{
		Store: &store.Candidate{
			ModelID:    "mdl_" + model,
			ModelSlug:  model,
			ProviderID: providerID,
			ProviderName: providerName,
			ProviderSlug: providerName,
			Priority:   priority,
		},
		PriceInputMicro:  input,
		PriceOutputMicro: output,
		LatencyMs:        latency,
		Availability:     avail,
		Capacity:         100,
	}
	return c
}

func names(cands []Candidate) []string {
	out := make([]string, 0, len(cands))
	for _, c := range cands {
		out = append(out, c.Store.ProviderName)
	}
	return out
}

// Strategy intent (PRD §30): each strategy must order by its own signal. Ties
// on the signal break by provider.priority (lower wins) — a deterministic rule,
// so two equal-priced targets always resolve the same way.
func TestSelectStrategyOrdering(t *testing.T) {
	cheap := build("m", "prv_a", "cheapco", 50, 100, 100, 900, 0.95)
	fast := build("m", "prv_b", "fastco", 60, 900, 900, 50, 0.95)
	sturdy := build("m", "prv_c", "sturdyco", 70, 500, 500, 500, 0.999)
	priority := build("m", "prv_d", "prio", 1, 500, 500, 500, 0.9)

	cases := []struct {
		strategy string
		want     []string
	}{
		// sturdyco and prio tie on price (1000 micro) → priority decides.
		{StrategyLowestCost, []string{"cheapco", "prio", "sturdyco", "fastco"}},
		// sturdyco and prio tie on latency (500ms) → priority decides.
		{StrategyLowestLatency, []string{"fastco", "prio", "sturdyco", "cheapco"}},
		// cheapco and fastco tie on availability → priority decides.
		{StrategyHighestReliability, []string{"sturdyco", "cheapco", "fastco", "prio"}},
		{StrategyProviderPriority, []string{"prio", "cheapco", "fastco", "sturdyco"}},
	}
	for _, tc := range cases {
		t.Run(tc.strategy, func(t *testing.T) {
			// fresh copies: Select stamps reasons on its output copy anyway
			got := Select([]Candidate{cheap, fast, sturdy, priority}, Plan{Strategy: tc.strategy, Weights: DefaultWeights()})
			if g := names(got); !equal(g, tc.want) {
				t.Errorf("order = %v, want %v", g, tc.want)
			}
		})
	}
}

// balanced must be a WEIGHTED COMPROMISE: the cheap-but-slow candidate beats the
// fast-but-pricey one when the price weight dominates, and vice versa.
func TestBalancedRespectsWeights(t *testing.T) {
	cheap := build("m", "prv_a", "cheapco", 100, 1, 1, 100_000, 0.9)
	fast := build("m", "prv_b", "fastco", 100, 10_000_000, 10_000_000, 1, 0.9)

	priceHeavy := Weights{Price: 1, Latency: 0, Reliability: 0, Capacity: 0}
	got := Select([]Candidate{cheap, fast}, Plan{Strategy: StrategyBalanced, Weights: priceHeavy})
	if names(got)[0] != "cheapco" {
		t.Errorf("price-heavy balanced picked %v", names(got))
	}

	latHeavy := Weights{Price: 0, Latency: 1, Reliability: 0, Capacity: 0}
	got = Select([]Candidate{cheap, fast}, Plan{Strategy: StrategyBalanced, Weights: latHeavy})
	if names(got)[0] != "fastco" {
		t.Errorf("latency-heavy balanced picked %v", names(got))
	}
}

// The constraint filter runs BEFORE scoring (spec §9): a candidate that cannot
// be afforded or that is blocked must not appear in the order at all.
func TestFilterRemovesBlockedAndUnaffordable(t *testing.T) {
	cands := []Candidate{
		build("m", "prv_a", "cheapco", 50, 100, 100, 900, 0.95),
		build("m", "prv_b", "richco", 50, 10_000, 100, 50, 0.95),
		build("m", "prv_c", "slowco", 50, 100, 100, 5_000, 0.95),
		build("m", "prv_d", "flakyco", 50, 100, 100, 50, 0.5),
	}

	maxIn := int64(500)
	got := Filter(cands, Constraints{MaxInputPriceMicro: &maxIn})
	if names(got)[0] == "richco" || contains(names(got), "richco") {
		t.Errorf("max_input_price_micro did not drop the expensive candidate: %v", names(got))
	}

	maxLat := int64(1_000)
	got = Filter(cands, Constraints{MaxP95LatencyMs: &maxLat})
	if contains(names(got), "slowco") {
		t.Errorf("max_p95_latency_ms did not drop the slow candidate: %v", names(got))
	}

	minAvail := 0.9
	got = Filter(cands, Constraints{MinAvailability: &minAvail})
	if contains(names(got), "flakyco") {
		t.Errorf("min_availability did not drop the flaky candidate: %v", names(got))
	}

	got = Filter(cands, Constraints{BlockedProviders: []string{"prv_a", "richco"}})
	if contains(names(got), "cheapco") || contains(names(got), "richco") {
		t.Errorf("blocked_providers not enforced: %v", names(got))
	}

	got = Filter(cands, Constraints{AllowedProviders: []string{"slowco"}})
	if !equal(names(got), []string{"slowco"}) {
		t.Errorf("allowed_providers = %v, want only slowco", names(got))
	}
}

// A missing constraint key constrains NOTHING (missing ≠ zero).
func TestEmptyConstraintsConstrainNothing(t *testing.T) {
	cands := []Candidate{build("m", "prv_a", "anyco", 50, 0, 0, 0, 0)}
	got := Filter(cands, Constraints{})
	if len(got) != 1 {
		t.Errorf("empty constraints dropped a candidate: %v", names(got))
	}
}

// Capability filter (spec §5): an explicit `false` eliminates; a MISSING key
// passes — an unenriched catalog must never black-hole a request. The rule is
// store.CapabilitySatisfied (the candidate query's filter) and is pinned here
// because it is a routing contract, not just a query detail.
func TestCapabilityFilterRule(t *testing.T) {
	cases := []struct {
		name      string
		effective map[string]any
		required  map[string]bool
		want      bool
	}{
		{"missing passes", map[string]any{}, map[string]bool{"vision": true}, true},
		{"explicit true passes", map[string]any{"vision": true}, map[string]bool{"vision": true}, true},
		{"explicit false eliminates", map[string]any{"vision": false}, map[string]bool{"vision": true}, false},
		{"unknown capability passes", map[string]any{"telepathy": false}, map[string]bool{"vision": true}, true},
		{"non-bool claim passes", map[string]any{"vision": "yes"}, map[string]bool{"vision": true}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := store.CapabilitySatisfied(tc.effective, tc.required); got != tc.want {
				t.Errorf("CapabilitySatisfied(%v, %v) = %v, want %v", tc.effective, tc.required, got, tc.want)
			}
		})
	}
}

// Retry classification (spec §9): the retryable set and the never-retry set are
// both contracts, and the distinction decides fallback.
func TestClassifyRetryable(t *testing.T) {
	cases := []struct {
		code    string
		status  int
		transp  bool
		want    bool
	}{
		{ErrCodeRateLimited, 429, false, true},
		{ErrCodeProviderTimeout, 504, false, true},
		{ErrCodeProviderUnavailable, 503, false, true},
		{ErrCodeCircuitOpen, 0, false, true},
		{ErrCodeUpstreamError, 500, false, true},
		{ErrCodeUpstreamError, 502, false, true},
		{ErrCodeUpstreamError, 429, false, true},
		{ErrCodeUpstreamError, 401, false, true}, // dead credential: fail over
		{ErrCodeUpstreamError, 403, false, true},
		{ErrCodeUpstreamError, 400, false, false},
		{"", 0, true, true}, // transport error
		{ErrCodeInvalidRequest, 400, false, false},
		{ErrCodeUnsupportedParam, 400, false, false},
		{ErrCodeContextTooLong, 413, false, false},
		{ErrCodeModelNotFound, 404, false, false},
		{ErrCodeAuthorization, 403, false, false},
		{ErrCodeContentRejected, 403, false, false},
	}
	for _, tc := range cases {
		if got := ClassifyRetryable(tc.code, tc.status, tc.transp); got != tc.want {
			t.Errorf("ClassifyRetryable(%q, %d, %v) = %v, want %v", tc.code, tc.status, tc.transp, got, tc.want)
		}
	}
}

// Upstream status mapping: a client's 4xx is request-shaped, a 5xx/429/401/403
// is a target problem another candidate can fix.
func TestClassifyUpstream(t *testing.T) {
	cases := []struct {
		status    int
		wantCode  string
		wantRetry bool
	}{
		{429, ErrCodeRateLimited, true},
		{503, ErrCodeProviderUnavailable, true},
		{504, ErrCodeProviderTimeout, true},
		{500, ErrCodeUpstreamError, true},
		{401, ErrCodeUpstreamError, true},
		{403, ErrCodeUpstreamError, true},
		{400, ErrCodeInvalidRequest, false},
		{404, ErrCodeModelNotFound, false},
		{413, ErrCodeContextTooLong, false},
		{402, ErrCodeInsufficientCredits, false},
	}
	for _, tc := range cases {
		code, retry := ClassifyUpstream(tc.status)
		if code != tc.wantCode || retry != tc.wantRetry {
			t.Errorf("ClassifyUpstream(%d) = (%s, %v), want (%s, %v)", tc.status, code, retry, tc.wantCode, tc.wantRetry)
		}
	}
}

// The executor must fall back on a retryable failure and record both attempts.
func TestExecuteFallsBackOn429AndRecordsAttempts(t *testing.T) {
	cands := []Candidate{
		build("m", "prv_a", "badco", 1, 100, 100, 100, 0.9),
		build("m", "prv_b", "goodco", 2, 100, 100, 100, 0.9),
	}
	var seen []string
	fn := func(_ context.Context, cand *Candidate, _ int) []*Attempt {
		seen = append(seen, cand.Store.ProviderName)
		if cand.Store.ProviderName == "badco" {
			return []*Attempt{{HTTPStatus: 429, ErrorCode: ErrCodeRateLimited, Retryable: true}}
		}
		return []*Attempt{{Payload: "ok"}}
	}
	res := Execute(context.Background(), cands, Plan{Strategy: StrategyProviderPriority, MaxAttempts: 2, FallbackEnabled: true}, time.Time{}, nil, fn)

	if res.Winner == nil {
		t.Fatal("no winner after fallback")
	}
	if res.Winner.Candidate.Store.ProviderName != "goodco" {
		t.Errorf("winner = %s, want goodco", res.Winner.Candidate.Store.ProviderName)
	}
	if !res.FallbackUsed {
		t.Error("fallback_used must be true after a 429-then-success")
	}
	if len(res.Attempts) != 2 {
		t.Errorf("recorded %d attempts, want 2 (429 + success)", len(res.Attempts))
	}
	if equal(seen, []string{"badco", "goodco"}) != true {
		t.Errorf("attempt order = %v", seen)
	}
}

// A request-shaped failure stops the walk immediately: no other target can fix
// it and burning the pool on it is a bug (spec §9 "NEVER on …").
func TestExecuteDoesNotRetryClientErrors(t *testing.T) {
	cands := []Candidate{
		build("m", "prv_a", "first", 1, 1, 1, 1, 1),
		build("m", "prv_b", "second", 2, 1, 1, 1, 1),
	}
	calls := 0
	fn := func(_ context.Context, _ *Candidate, _ int) []*Attempt {
		calls++
		return []*Attempt{{HTTPStatus: 400, ErrorCode: ErrCodeInvalidRequest}}
	}
	res := Execute(context.Background(), cands, Plan{Strategy: StrategyProviderPriority, MaxAttempts: 2, FallbackEnabled: true}, time.Time{}, nil, fn)

	if calls != 1 {
		t.Errorf("attempted %d targets on a 400 INVALID_REQUEST, want 1 (never retry)", calls)
	}
	if res.Winner != nil {
		t.Error("a client error must not produce a winner")
	}
	if res.FallbackUsed {
		t.Error("fallback_used must be false when no fallback happened")
	}
}

// The DEADLINE is absolute (spec §9): an attempt is never STARTED that cannot
// finish inside request_timeout_ms.
func TestExecuteHonoursTheRequestDeadline(t *testing.T) {
	// A candidate whose p95 is 500ms cannot finish inside a deadline 10ms away.
	slow := build("m", "prv_a", "slowco", 1, 1, 1, 500, 1)
	calls := 0
	fn := func(_ context.Context, _ *Candidate, _ int) []*Attempt {
		calls++
		return []*Attempt{{Payload: "ok"}}
	}
	deadline := time.Now().Add(10 * time.Millisecond)
	res := Execute(context.Background(), []Candidate{slow}, Plan{Strategy: StrategyProviderPriority, MaxAttempts: 1}, deadline, nil, fn)

	if calls != 0 {
		t.Errorf("started %d attempt(s) that cannot finish inside the deadline", calls)
	}
	if res.Winner != nil {
		t.Error("an impossible request must not claim a winner")
	}

	// A budget that comfortably fits must still run.
	fast := build("m", "prv_a", "fastco", 1, 1, 1, 5, 1)
	res = Execute(context.Background(), []Candidate{fast}, Plan{Strategy: StrategyProviderPriority, MaxAttempts: 1}, time.Now().Add(time.Second), nil, fn)
	if res.Winner == nil {
		t.Fatal("a comfortably-budgeted attempt was refused")
	}
}

// fallback_enabled=false means ONE attempt, period (spec §9).
func TestExecuteRespectsFallbackDisabled(t *testing.T) {
	cands := []Candidate{
		build("m", "prv_a", "first", 1, 1, 1, 1, 1),
		build("m", "prv_b", "second", 2, 1, 1, 1, 1),
	}
	calls := 0
	fn := func(_ context.Context, _ *Candidate, _ int) []*Attempt {
		calls++
		return []*Attempt{{HTTPStatus: 503, ErrorCode: ErrCodeProviderUnavailable}}
	}
	res := Execute(context.Background(), cands, Plan{Strategy: StrategyProviderPriority, MaxAttempts: 4, FallbackEnabled: false}, time.Time{}, nil, fn)
	if calls != 1 || res.FallbackUsed {
		t.Errorf("fallback_enabled=false made %d attempts, fallback=%v", calls, res.FallbackUsed)
	}
}

// The circuit breaker refuses an open target and moves on (spec §9). With no
// Valkey the breaker degrades to CLOSED (PRD §150) — covered by the nil-vk
// cases above running through it here.
func TestExecuteCircuitOpenRefusesAndRecords(t *testing.T) {
	cands := []Candidate{
		build("m", "prv_a", "deadco", 1, 1, 1, 1, 1),
		build("m", "prv_b", "liveco", 2, 1, 1, 1, 1),
	}
	// Drive the breaker: the first target fails until the threshold trips.
	cb := NewCircuitBreaker(vk.NewFake(), map[string]BreakerDefaults{
		"connection:con_dead": {FailureThreshold: 1, WindowSeconds: 60, OpenMs: 60_000, HalfOpenProbes: 1},
	})
	cands[0].Store.ConnectionID = "con_dead"
	cands[1].Store.ConnectionID = "con_live"

	// Trip it with a failing attempt first.
	fn := func(_ context.Context, cand *Candidate, _ int) []*Attempt {
		if cand.Store.ConnectionID == "con_dead" {
			return []*Attempt{{HTTPStatus: 503, ErrorCode: ErrCodeProviderUnavailable}}
		}
		return []*Attempt{{Payload: "ok"}}
	}
	_ = Execute(context.Background(), []Candidate{cands[0]}, Plan{Strategy: StrategyProviderPriority, MaxAttempts: 1}, time.Time{}, cb, fn)

	// Now the circuit is open: the next request must skip deadco entirely
	// (recorded as a CIRCUIT_OPEN attempt) and land on liveco.
	res := Execute(context.Background(), cands, Plan{Strategy: StrategyProviderPriority, MaxAttempts: 2, FallbackEnabled: true}, time.Time{}, cb, fn)
	if res.Winner == nil || res.Winner.Candidate.Store.ProviderName != "liveco" {
		t.Fatalf("winner = %+v, want liveco around an open circuit", res.Winner)
	}
	var sawCircuitOpen bool
	for _, a := range res.Attempts {
		if a.ErrorCode == ErrCodeCircuitOpen {
			sawCircuitOpen = true
		}
	}
	if !sawCircuitOpen {
		t.Error("the refused attempt was not recorded with CIRCUIT_OPEN")
	}
}

// A dead Valkey must leave the breaker CLOSED (PRD §150): traffic keeps moving.
func TestCircuitBreakerDegradesClosedWhenValkeyIsDown(t *testing.T) {
	f := vk.NewFake()
	f.FailAll()
	cb := NewCircuitBreaker(f, nil)
	cand := build("m", "prv_a", "anyco", 1, 1, 1, 1, 1)
	cand.Store.ConnectionID = "con_x"
	for range 10 {
		if !cb.Allow(context.Background(), &cand) {
			t.Fatal("an open circuit refused traffic while Valkey was down — must degrade closed")
		}
		cb.Result(context.Background(), &cand, false)
	}
}

func TestNormalizeStrategy(t *testing.T) {
	cases := []struct{ in, want string }{
		{"lowest_cost", StrategyLowestCost},
		{"balanced", StrategyBalanced},
		{"smart", StrategyBalanced}, // flag off: smart = balanced
		{"nonsense", StrategyBalanced},
		{"", StrategyBalanced},
	}
	for _, tc := range cases {
		if got := NormalizeStrategy(tc.in, "", false); got != tc.want {
			t.Errorf("NormalizeStrategy(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
	if got := NormalizeStrategy("", "round_robin", false); got != StrategyRoundRobin {
		t.Errorf("empty override must fall back to the policy strategy, got %q", got)
	}
}

// The reasons written to request_attempt must explain the decision (spec §8).
func TestSelectStampsReasons(t *testing.T) {
	cands := []Candidate{build("m", "prv_a", "co", 1, 100, 100, 100, 0.9)}
	got := Select(cands, Plan{Strategy: StrategyLowestCost, Weights: DefaultWeights()})
	if got[0].Reason == "" {
		t.Error("select must stamp a reason on every candidate")
	}
	if !strings.Contains(got[0].Reason, "lowest_cost") {
		t.Errorf("reason %q should name the strategy", got[0].Reason)
	}
}

func TestRoundRobinSpreads(t *testing.T) {
	a := build("m", "prv_a", "a", 1, 1, 1, 1, 1)
	b := build("m", "prv_b", "b", 1, 1, 1, 1, 1)
	first := Select([]Candidate{a, b}, Plan{Strategy: StrategyRoundRobin})
	second := Select([]Candidate{a, b}, Plan{Strategy: StrategyRoundRobin})
	if equal(names(first), names(second)) {
		// With 2 candidates and an advancing counter, consecutive calls rotate.
		// (A collision is possible but must not repeat identically 10 times.)
		same := 0
		for range 10 {
			x := Select([]Candidate{a, b}, Plan{Strategy: StrategyRoundRobin})
			y := Select([]Candidate{a, b}, Plan{Strategy: StrategyRoundRobin})
			if equal(names(x), names(y)) {
				same++
			}
		}
		if same == 10 {
			t.Error("round_robin never rotated the starting candidate")
		}
	}
}

// ---- helpers ----

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
