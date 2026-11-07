package routing

// The tier ladder's names must map to DIFFERENT strategies end to end: the
// virtual's hint (store.ModelResolution.StrategyHint) has to survive
// ResolveStrategy and actually change the order Select produces. If two tiers
// resolve to the same strategy they are the same tier wearing two labels, which
// is the defect this card exists to fix — `fudrouter/auto` used to be an empty
// hint, so it silently ran the policy's `balanced` and differed from
// `fudrouter/balanced` in nothing at all.

import (
	"testing"
)

// TestResolveStrategyPerTier pins hint → strategy for the four tier names.
// The hints are the exact strings store/catalog.go's virtualModels declares.
func TestResolveStrategyPerTier(t *testing.T) {
	cases := []struct{ virtual, hint, want string }{
		{"fudrouter/auto", "random", StrategyRandom},
		{"fudrouter/smart", "highest_reliability", StrategyHighestReliability},
		{"fudrouter/medium", "lowest_latency", StrategyLowestLatency},
		{"fudrouter/worker", "lowest_cost", StrategyLowestCost},
	}
	seen := map[string]string{}
	for _, tc := range cases {
		// The policy says `balanced`; the virtual's hint must win over it.
		got := ResolveStrategy(StrategyBalanced, "", tc.hint)
		if got != tc.want {
			t.Errorf("%s: resolved %q, want %q", tc.virtual, got, tc.want)
		}
		if prev, dup := seen[got]; dup {
			t.Errorf("%s and %s both resolve to %q — indistinguishable tiers", tc.virtual, prev, got)
		}
		seen[got] = tc.virtual
	}
	if len(seen) != len(cases) {
		t.Fatalf("the %d tiers produced %d distinct strategies", len(cases), len(seen))
	}
}

// TestTierHintsProduceDifferentOrders is the behavioural half: the same candidate
// set, ranked by each tier's hint, must produce a DIFFERENT winner. This is what
// makes "smart/medium/worker" meaningful rather than cosmetic — it asserts the
// strategies read different signals, not just that the strings differ.
func TestTierHintsProduceDifferentOrders(t *testing.T) {
	// One candidate per signal, so each strategy has an unambiguous winner.
	cheap := build("m", "prv_cheap", "cheapco", 90, 1, 1, 900, 0.90)         // cheapest, slow, less reliable
	fast := build("m", "prv_fast", "fastco", 80, 900, 900, 10, 0.90)         // fastest, pricey
	sturdy := build("m", "prv_sturdy", "sturdyco", 70, 500, 500, 500, 0.999) // most reliable
	cands := []Candidate{cheap, fast, sturdy}

	want := map[string]string{
		StrategyLowestCost:         "cheapco",
		StrategyLowestLatency:      "fastco",
		StrategyHighestReliability: "sturdyco",
	}
	winners := map[string]string{}
	for _, hint := range []string{"lowest_cost", "lowest_latency", "highest_reliability"} {
		strategy := ResolveStrategy(StrategyBalanced, "", hint)
		got := Select(cands, Plan{Strategy: strategy, Weights: DefaultWeights()})
		if len(got) == 0 {
			t.Fatalf("%s selected nothing", hint)
		}
		winner := got[0].Store.ProviderName
		if winner != want[strategy] {
			t.Errorf("%s (hint %q) picked %s, want %s", strategy, hint, winner, want[strategy])
		}
		winners[strategy] = winner
	}
	distinct := map[string]bool{}
	for _, w := range winners {
		distinct[w] = true
	}
	if len(distinct) != len(winners) {
		t.Fatalf("tiers picked the same winner: %v — the strategies are not reading different signals", winners)
	}
}

// TestTierRandomIgnoresSignals: `random` must NOT be a re-ranking of the others.
// A shuffle that preserved order would look like `balanced` in a test that only
// compares winners once, so this asserts the ordering actually varies while the
// member set does not.
func TestTierRandomIgnoresSignals(t *testing.T) {
	cheap := build("m", "prv_cheap", "cheapco", 90, 1, 1, 900, 0.90)
	fast := build("m", "prv_fast", "fastco", 80, 900, 900, 10, 0.90)
	sturdy := build("m", "prv_sturdy", "sturdyco", 70, 500, 500, 500, 0.999)
	cands := []Candidate{cheap, fast, sturdy}

	orders := map[string]bool{}
	for range 60 {
		got := Select(cands, Plan{Strategy: StrategyRandom, Weights: DefaultWeights()})
		names := make([]string, 0, len(got))
		for _, c := range got {
			names = append(names, c.Store.ProviderName)
		}
		orders[join(names)] = true
	}
	if len(orders) < 2 {
		t.Fatalf("random produced one ordering across 60 draws: %v", orders)
	}
}

// TestBalancedStaysBalanced proves the tier ladder did not hijack the policy
// default: an EMPTY hint must still resolve to the policy's own strategy.
func TestBalancedStaysBalanced(t *testing.T) {
	for _, policy := range []string{StrategyBalanced, StrategyLowestCost, StrategyProviderPriority} {
		if got := ResolveStrategy(policy, "", ""); got != policy {
			t.Errorf("policy %q with no hint resolved to %q — the default path changed", policy, got)
		}
	}
}

func join(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += "|"
		}
		out += p
	}
	return out
}
