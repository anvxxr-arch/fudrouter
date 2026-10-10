package proxy

import (
	"context"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/services/router/internal/routing"
	"github.com/anvxxr-arch/fudrouter/services/router/internal/store"
	"github.com/anvxxr-arch/fudrouter/services/router/internal/vk"
)

// fillCandidatePricing is the lifecycle's price step: candidates arrive with
// nil Store.Price (the price comes from the Valkey cache while signals load
// inline), and the helper must populate the price AND reload the scoring
// signals — otherwise lowest_cost scores every candidate at zero and the
// order degrades to provider priority. This exercises the real helper through
// a seeded vk.Fake (not a re-implementation of its sequence), so a future
// lifecycle edit that drops the reload or bypasses the helper breaks here.
func TestFillCandidatePricingDrivesLowestCost(t *testing.T) {
	ctx := context.Background()
	fake := vk.NewFake()
	// store nil: every lookup must hit the seeded cache.
	h := &Handler{vk: fake}
	// Seed through the same key builder cachedPricing uses — a hand-written
	// key here would silently drift the moment the key format changes.
	seed := func(modelID, pmdl string, in, out int64) {
		t.Helper()
		if err := fake.SetJSON(ctx, h.pricingKey(modelID, pmdl),
			&store.Pricing{InputMicro: in, OutputMicro: out}, time.Minute); err != nil {
			t.Fatal(err)
		}
	}
	seed("mdl_m", "pmdl_prv_a", 100, 100)
	seed("mdl_m", "pmdl_prv_b", 900, 900)

	mk := func(providerID, name string) routing.Candidate {
		c := routing.Candidate{Store: &store.Candidate{
			ModelID:         "mdl_m",
			ModelSlug:       "m",
			ProviderModelID: "pmdl_" + providerID,
			ProviderID:      providerID,
			ProviderName:    name,
			ProviderSlug:    name,
			Priority:        10,
		}}
		c.LoadSignals() // price unknown here, exactly like the lifecycle
		return c
	}
	// Same priority, pricey first: only the price signal may decide the order.
	merged := []routing.Candidate{mk("prv_b", "priceyco"), mk("prv_a", "cheapco")}
	if merged[0].PriceInputMicro != 0 || merged[1].PriceInputMicro != 0 {
		t.Fatalf("precondition: signals before pricing must be zero, got %d/%d",
			merged[0].PriceInputMicro, merged[1].PriceInputMicro)
	}

	h.fillCandidatePricing(ctx, merged)

	for _, c := range merged {
		if c.Store.Price == nil {
			t.Fatalf("candidate %s: Store.Price still nil after fill", c.Store.ProviderName)
		}
	}
	if merged[0].PriceInputMicro != 900 || merged[1].PriceInputMicro != 100 {
		t.Errorf("signals not reloaded after fill: got %d/%d, want 900/100",
			merged[0].PriceInputMicro, merged[1].PriceInputMicro)
	}
	got := routing.Select(merged, routing.Plan{Strategy: routing.StrategyLowestCost, Weights: routing.DefaultWeights()})
	if len(got) != 2 || got[0].Store.ProviderName != "cheapco" {
		t.Errorf("lowest_cost order = [%s %s], want [cheapco priceyco]",
			got[0].Store.ProviderName, got[1].Store.ProviderName)
	}
}
