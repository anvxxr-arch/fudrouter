package routing

// The `random` strategy is what `fudrouter/auto` runs (store/catalog.go's
// virtualModels: auto → random). The tier's promise is "spread traffic across
// everything that is answering right now", so a shuffle that always lands on the
// same candidate would make the name a lie in exactly the way this card is about.
//
// The unit-level test below pins the DISTRIBUTION property (no candidate wins
// every draw, and every candidate wins sometimes). It deliberately does not
// assert exact frequencies: a correct Fisher-Yates over 4 candidates should be
// roughly uniform, and asserting tight bounds would make the test flaky on a
// loaded box while telling us nothing extra — what matters is that the choice is
// not deterministic.
//
// The end-to-end companion (TestAutoTierSpreadsAcrossLiveModels) lives in
// internal/store: it drives ResolveModel + Select the way the lifecycle does and
// requires more than one distinct winner across many requests.

import (
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
)

func randomCandidates(n int) []Candidate {
	out := make([]Candidate, 0, n)
	for i := range n {
		out = append(out, Candidate{
			Store: &store.Candidate{
				ModelID:      "mdl_rand_" + string(rune('a'+i)),
				ModelSlug:    "rand-" + string(rune('a'+i)),
				ProviderID:   "prv_" + string(rune('a'+i)),
				ProviderName: "prov" + string(rune('a'+i)),
				Priority:     10 + i,
			},
			Availability: 0.99,
			Capacity:     100,
		})
	}
	return out
}

// TestRandomStrategyIsNotDeterministic: the winner of a `random` selection must
// change across draws. 200 draws over 4 candidates and a single winner would mean
// the shuffle is not running (or is being undone by a later stable partition).
func TestRandomStrategyIsNotDeterministic(t *testing.T) {
	cands := randomCandidates(4)
	winners := map[string]int{}
	const draws = 200
	for range draws {
		got := Select(cands, Plan{Strategy: StrategyRandom, Weights: DefaultWeights()})
		if len(got) != len(cands) {
			t.Fatalf("Select returned %d candidates, want %d — random must reorder, not drop", len(got), len(cands))
		}
		winners[got[0].Store.ModelSlug]++
	}
	if len(winners) < 2 {
		t.Fatalf("random picked %v across %d draws — the shuffle is deterministic", winners, draws)
	}
	// Every candidate must win sometimes. With 200 draws over 4 equally-ranked
	// candidates the chance of one never winning is (3/4)^200 ≈ 1e-25, so this
	// is a real assertion and not a coin flip.
	if len(winners) != len(cands) {
		t.Fatalf("only %d of %d candidates ever won: %v", len(winners), len(cands), winners)
	}
	// And no single candidate may dominate: more than half the draws means the
	// distribution is skewed enough to defeat the point of the tier.
	for slug, n := range winners {
		if n > draws/2 {
			t.Fatalf("%s won %d of %d draws — random is biased toward one target (%v)", slug, n, draws, winners)
		}
	}
}

// TestRandomPreservesEveryCandidate: the shuffle must be a PERMUTATION. A bug
// that dropped or duplicated entries would silently shrink the target set, which
// is the same class of defect as an allowlist that quietly loses members.
func TestRandomPreservesEveryCandidate(t *testing.T) {
	cands := randomCandidates(6)
	want := map[string]bool{}
	for _, c := range cands {
		want[c.Store.ModelID] = true
	}
	for range 20 {
		got := Select(cands, Plan{Strategy: StrategyRandom, Weights: DefaultWeights()})
		if len(got) != len(cands) {
			t.Fatalf("got %d candidates, want %d", len(got), len(cands))
		}
		seen := map[string]bool{}
		for _, c := range got {
			if seen[c.Store.ModelID] {
				t.Fatalf("candidate %s appears twice after shuffling", c.Store.ModelID)
			}
			seen[c.Store.ModelID] = true
		}
		for id := range want {
			if !seen[id] {
				t.Fatalf("candidate %s vanished from the shuffled set", id)
			}
		}
	}
}
