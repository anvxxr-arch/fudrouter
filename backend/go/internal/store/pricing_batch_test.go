package store_test

// The COLD pricing-cache path: resolving prices for many models must be ONE
// query, not one per model.
//
// Why this file exists: fillCandidatePricing (internal/proxy/catalog_cache.go)
// batches its Valkey reads into one MGET, but every MISS went through
// cachedPricing — one ResolvePricing round trip per model. The cache TTL is 60s
// per key, so a `[NAME]/*` virtual request served from a cold cache paid one
// query per model in the catalogue: measured at 500 round trips for a 500-model
// catalogue, ~58ms of sequential database time on the admission path, repeating
// whenever entries expire together (a deploy, a flush, any TTL wave).
//
// The count is the assertion, as elsewhere in this package: on a loopback
// Postgres a single removed round trip hides inside the timing noise, and this
// box varies by an order of magnitude run to run.

import (
	"context"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

func TestResolvePricingManyIsOneQuery(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	s, tr := startCounting(t, dsn)
	ctx := context.Background()
	at := time.Now()

	// Bulk models carry their own provider_model mapping, which is the pair the
	// pricing lookup keys on.
	bulk := tests.SeedModels(t, dsn, env, 30)
	keys := make([][2]string, 0, len(bulk)+1)
	for _, id := range bulk {
		keys = append(keys, [2]string{id, id})
	}
	keys = append(keys, [2]string{env.ModelID, env.ProviderModelID})

	// The per-model baseline this replaces, through the same tracer.
	tr.Reset()
	want := make(map[string]store.Pricing, len(keys))
	for _, k := range keys {
		p, err := s.ResolvePricing(ctx, k[0], k[1], at)
		if err != nil {
			t.Fatalf("ResolvePricing(%s): %v", k[0], err)
		}
		want[k[0]+"\x00"+k[1]] = *p
	}
	perModel := tr.Count()
	t.Logf("per-model resolution: %d queries for %d models (%.1f each)",
		perModel, len(keys), float64(perModel)/float64(len(keys)))
	// At least one query per model, and TWO for a model with no pricing_rule
	// (the rule miss, then the legacy model-row fallback). Measured 61 for 31
	// models — so the pre-fix cold path was worse than one query per model.
	if perModel < len(keys) {
		t.Fatalf("per-model baseline = %d for %d models, expected at least 1:1", perModel, len(keys))
	}

	// The batched form: one query for the whole set.
	tr.Reset()
	got, err := s.ResolvePricingMany(ctx, keys, at)
	if err != nil {
		t.Fatalf("ResolvePricingMany: %v", err)
	}
	if n := tr.Count(); n != 1 {
		t.Errorf("ResolvePricingMany issued %d queries for %d models, want 1", n, len(keys))
	}
	if len(got) != len(keys) {
		t.Fatalf("ResolvePricingMany returned %d entries for %d models", len(got), len(keys))
	}
	// Equivalence per field: a batched price that differs from the single-row
	// resolution in ANY field would silently reprice a candidate.
	for k, wantP := range want {
		gotP, ok := got[k]
		if !ok {
			t.Errorf("%s missing from the batched result", k)
			continue
		}
		if *gotP != wantP {
			t.Errorf("%s:\n batch  = %+v\n single = %+v", k, *gotP, wantP)
		}
	}

	// A pair with no rule and no legacy row is simply absent, not an error.
	none, err := s.ResolvePricingMany(ctx, [][2]string{{"mdl_does_not_exist", "pmdl_nope"}}, at)
	if err != nil {
		t.Fatalf("ResolvePricingMany(unknown): %v", err)
	}
	if _, ok := none["mdl_does_not_exist\x00pmdl_nope"]; ok {
		t.Error("an unknown model produced a price")
	}
}
