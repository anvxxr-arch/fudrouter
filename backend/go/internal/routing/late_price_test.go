package routing

import (
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
)

// The hot path fills candidate prices AFTER the first LoadSignals (the price
// comes from the Valkey cache while signals load inline). LoadSignals
// snapshots Store.Price into the scoring fields, so the lifecycle must reload
// signals once the price lands — otherwise lowest_cost scores every candidate
// at zero and the order degrades to provider priority. This pins that order:
// price-filled-then-reloaded must route to the cheaper target.
func TestLatePriceFillStillDrivesLowestCost(t *testing.T) {
	mk := func(providerID, name string, priority int) Candidate {
		c := Candidate{
			Store: &store.Candidate{
				ModelID:         "mdl_m",
				ModelSlug:       "m",
				ProviderModelID: "pmdl_" + providerID,
				ProviderID:      providerID,
				ProviderName:    name,
				ProviderSlug:    name,
				Priority:        priority,
			},
			Capacity: 100,
		}
		c.LoadSignals() // price unknown here, exactly like the lifecycle
		return c
	}
	// Same priority, so only the price signal can decide the order.
	cheap := mk("prv_a", "cheapco", 10)
	pricey := mk("prv_b", "priceyco", 10)
	if cheap.PriceInputMicro != 0 || pricey.PriceInputMicro != 0 {
		t.Fatalf("precondition: signals before pricing must be zero, got %d/%d",
			cheap.PriceInputMicro, pricey.PriceInputMicro)
	}

	// The lifecycle's fill step: set Store.Price, then reload signals.
	cheap.Store.Price = &store.Pricing{InputMicro: 100, OutputMicro: 100}
	pricey.Store.Price = &store.Pricing{InputMicro: 900, OutputMicro: 900}
	cheap.LoadSignals()
	pricey.LoadSignals()

	got := Select([]Candidate{pricey, cheap}, Plan{Strategy: StrategyLowestCost, Weights: DefaultWeights()})
	if g := names(got); len(g) != 2 || g[0] != "cheapco" {
		t.Errorf("lowest_cost order = %v, want [cheapco priceyco]", g)
	}
}
