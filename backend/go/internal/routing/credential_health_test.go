package routing

//credential health must drive the ORDER, not just the score.
//
// Measured 2026-11-02 on the live router: prv-zro held rank #1 (balanced score
// 0.631) with every one of its 486 credentials spent (462 rate_limited cooling
// until ~00:00, 24 invalid) while prv-tokenharbor held 6413 healthy at 0.623.
// Each request then burned 5 of its 6 attempts on zro — 402 per attempt — and
// only reached the provider that could answer as the LAST resort. The
// connection's health_status was 'healthy' the whole time: it describes the
// connection, and a connection whose every secret was just throttled is not
// healthy.
//
// These tests pin the fix: an exhausted candidate sorts behind every candidate
// that still has a pickable credential, under EVERY strategy — including
// lowest_cost, where a free-tier farm priced 0 would otherwise win on price
// alone while being unable to serve.

import (
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
)

// withCreds attaches credential rows with the given statuses.
func withCreds(c Candidate, statuses ...string) Candidate {
	for i, s := range statuses {
		c.Store.Credentials = append(c.Store.Credentials, store.Credential{
			ID:     "crd_" + s + string(rune('a'+i)),
			Name:   s,
			Status: s,
			Weight: 1,
		})
	}
	return c
}

// exhausted is a free-tier farm whose every credential is spent.
func exhausted(model, provider string) Candidate {
	return withCreds(build(model, "prv_"+provider, provider, 0, 0, 0, 250, 0.99),
		"rate_limited", "rate_limited", "invalid")
}

// funded is a provider with healthy credentials.
func funded(model, provider string, input, output int64) Candidate {
	return withCreds(build(model, "prv_"+provider, provider, 5, input, output, 250, 0.99),
		"healthy", "healthy", "healthy")
}

func TestExhaustedCandidateSortsLastUnderEveryStrategy(t *testing.T) {
	strategies := []struct {
		name string
		plan Plan
	}{
		{"balanced", Plan{Strategy: StrategyBalanced}},
		{"smart", Plan{Strategy: StrategySmart}},
		{"lowest_cost", Plan{Strategy: StrategyLowestCost}},
		{"lowest_latency", Plan{Strategy: StrategyLowestLatency}},
		{"highest_reliability", Plan{Strategy: StrategyHighestReliability}},
		{"provider_priority", Plan{Strategy: StrategyProviderPriority}},
		{"weighted", Plan{Strategy: StrategyWeighted}},
		{"round_robin", Plan{Strategy: StrategyRoundRobin}},
	}

	for _, s := range strategies {
		t.Run(s.name, func(t *testing.T) {
			// The exhausted farm is FREE and has better raw signals, so under
			// price/latency/reliability ordering it would win without the fix.
			zro := exhausted("glm-5.3-flash", "zro")
			th := funded("glm-5.3-flash", "tokenharbor", 300, 900)
			order := Select([]Candidate{zro, th}, s.plan)
			if got := order[0].Store.ProviderSlug; got != "tokenharbor" {
				t.Fatalf("first = %q, want tokenharbor — an exhausted candidate outranked a funded one (%v)",
					got, names(order))
			}
			if got := order[1].Store.ProviderSlug; got != "zro" {
				t.Fatalf("last = %q, want zro (the exhausted farm must stay reachable as a last resort)", got)
			}
		})
	}
}

// Under lowest_cost the free farm is strictly cheaper, so this is the case the
// score alone cannot fix — it needs the ordering partition.
func TestLowestCostDoesNotPickAnExhaustedFreeFarm(t *testing.T) {
	zro := exhausted("glm-5.3-flash", "zro")                 // priced 0
	th := funded("glm-5.3-flash", "tokenharbor", 5000, 9000) // priced, healthy
	order := Select([]Candidate{zro, th}, Plan{Strategy: StrategyLowestCost})
	if order[0].Store.ProviderSlug != "tokenharbor" {
		t.Fatalf("lowest_cost picked the exhausted free farm: %v", names(order))
	}
}

// An exhausted candidate must NOT be dropped from the plan: when it is the only
// target, a request must still be attempted rather than answered 404.
func TestExhaustedCandidateIsDemotedNotDropped(t *testing.T) {
	only := exhausted("glm-5.3-flash", "zro")
	order := Select([]Candidate{only}, Plan{Strategy: StrategyBalanced})
	if len(order) != 1 {
		t.Fatalf("plan dropped the only candidate: %v", names(order))
	}
}

// A candidate whose LAST credential is still selectable keeps its rank — the
// demotion is for exhaustion, not for being small.
func TestOneUsableCredentialIsNotExhausted(t *testing.T) {
	small := withCreds(build("m", "prv_small", "small", 0, 0, 0, 250, 0.99), "healthy", "rate_limited")
	healthy := withCreds(build("m", "prv_big", "big", 0, 0, 0, 400, 0.99), "healthy", "healthy")
	if small.Capacity == 0 || small.Availability == 0 {
		t.Fatalf("a candidate with 1 usable credential was marked exhausted: cap=%v avail=%v",
			small.Capacity, small.Availability)
	}
	_ = healthy
}

// A candidate with NO credential rows (legacy blob / static api_key) is not
// condemned: a missing claim is not a claim.
func TestNoCredentialRowsIsNotExhausted(t *testing.T) {
	legacy := build("m", "prv_legacy", "legacy", 0, 0, 0, 250, 0.99)
	if !candidateHasUsableCredential(legacy) {
		t.Fatal("a candidate with no credential rows was condemned as exhausted")
	}
}

// The score must fall too, so highest_reliability and balanced agree with the
// order — the old bug was Availability reading connection.health_status.
func TestLoadSignalsSinksAvailabilityOnExhaustion(t *testing.T) {
	c := exhausted("m", "zro")
	c.Store.ConfigJSON = []byte(`{"capacity": 500}`)
	c.Store.HealthStatus = "healthy"
	c.LoadSignals()
	if c.Capacity != 0 {
		t.Errorf("capacity = %d, want 0 — LoadSignals ignored credential exhaustion", c.Capacity)
	}
	if c.Availability != 0 {
		t.Errorf("availability = %v, want 0 despite connection.health_status=healthy", c.Availability)
	}
}

// The healthy fraction must damp the health claim even when the candidate is
// not fully exhausted: 1 usable of 900 is not 0.95 available.
func TestLoadSignalsScalesAvailabilityByHealthyFraction(t *testing.T) {
	c := funded("m", "mixed", 0, 0)
	c.Store.ConfigJSON = []byte(`{"availability": 0.95}`)
	c.Store.HealthStatus = "healthy"
	// 3 healthy of 3, then make most of them spent.
	statuses := make([]string, 0, 100)
	statuses = append(statuses, "healthy")
	for i := 0; i < 99; i++ {
		statuses = append(statuses, "rate_limited")
	}
	c = withCreds(build("m", "prv_mixed", "mixed", 0, 0, 0, 250, 0.95), statuses...)
	c.Store.ConfigJSON = []byte(`{"availability": 0.95}`)
	c.Store.HealthStatus = "healthy"
	c.LoadSignals()
	if c.Availability >= 0.95 {
		t.Fatalf("availability = %v, want < 0.95 — 1 usable of 100 must damp the health claim", c.Availability)
	}
	if c.Availability <= 0 {
		t.Fatalf("availability = %v, want > 0", c.Availability)
	}
}
