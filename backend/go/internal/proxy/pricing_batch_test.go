package proxy

// The candidate pricing pass must read the cache in ONE round trip, not one per
// candidate, and must still price every candidate.
//
// Why this file exists: `[NAME]/*` virtual requests price their whole candidate
// set, which is every model in the catalogue. The pass used to issue one GetJSON
// per candidate — measured at 500 sequential cache reads (~75ms of pure
// round-trip latency on a live Valkey) for a 500-model catalogue, all of it on
// the admission path before the first upstream byte. A cold cache was worse,
// because every miss then became its own pricing query.
//
// Two properties are asserted, and a fix that satisfied only the first would be
// a regression:
//
//  1. the read count does not scale with the candidate count, and
//  2. every candidate still ends up with a price (a batched read that silently
//     dropped misses would pass (1) while cheapest-first routing degraded to
//     provider priority).
//
// The counters live on the fake because the cost being asserted is a COUNT of
// cache operations, not a wall-clock number: a timing bound would move with the
// box while the fan-out stays whatever it is.

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/routing"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/vk"
)

// countingVK counts single-key reads and batched reads separately, so the test
// can tell "one MGET" from "N GETs" without reading the implementation.
type countingVK struct {
	*vk.Fake
	gets     int
	getManys int
}

func (c *countingVK) GetJSON(ctx context.Context, key string, v any, ttl time.Duration) error {
	c.gets++
	return c.Fake.GetJSON(ctx, key, v, ttl)
}

func (c *countingVK) GetJSONMany(ctx context.Context, keys []string, out map[string]json.RawMessage, ttl time.Duration) error {
	c.getManys++
	return c.Fake.GetJSONMany(ctx, keys, out, ttl)
}

// cachedCandidates builds `n` candidates with distinct pricing keys and pre-warms
// every one of them through `h`, whose key namespace depends on its store — so
// warming with a different Handler would write keys the pass never reads.
func cachedCandidates(t *testing.T, h *Handler, f *vk.Fake, ctx context.Context, n int) []routing.Candidate {
	t.Helper()
	merged := make([]routing.Candidate, 0, n)
	for i := range n {
		mid := "mdl_cachegate_" + itoa(i)
		cs := store.Candidate{ModelID: mid, ProviderModelID: mid}
		merged = append(merged, routing.Candidate{Store: &cs})
	}
	for i := range merged {
		p := store.Pricing{Currency: "USD", InputStr: "150000.000000", OutputStr: "600000.000000"}
		key := h.pricingKey(merged[i].Store.ModelID, merged[i].Store.ProviderModelID)
		if err := f.SetJSON(ctx, key, &p, time.Minute); err != nil {
			t.Fatal(err)
		}
	}
	return merged
}

func TestPricingPassReadsTheCacheOnce(t *testing.T) {
	ctx := context.Background()
	for _, n := range []int{1, 50, 500} {
		f := &vk.Fake{}
		*f = *vk.NewFake()
		c := &countingVK{Fake: f}
		h := &Handler{vk: c}
		merged := cachedCandidates(t, h, f, ctx, n)

		h.fillCandidatePricing(ctx, merged)

		if c.getManys != 1 {
			t.Errorf("n=%d: %d batched reads, want 1", n, c.getManys)
		}
		if c.gets != 0 {
			t.Errorf("n=%d: %d single-key cache reads on the pricing pass, want 0", n, c.gets)
		}
		priced := 0
		for i := range merged {
			if merged[i].Store.Price != nil {
				priced++
			}
		}
		if priced != n {
			t.Errorf("n=%d: only %d candidates were priced", n, priced)
		}
	}
}

// A candidate whose cache entry is MISSING must still be priced through the
// store, and one candidate's miss must not cost the rest of the batch its
// prices.
//
// This is the cold-cache path and it is the case that decides whether batching
// helps at all: a miss is where the DB query happens, and on a cold cache every
// candidate is a miss. The store here parses the DSN but never dials, so a
// correctly-batched miss stays unpriced and a wrongly-accepted one does not.
func TestPricingPassSkipsUnresolvableCandidates(t *testing.T) {
	ctx := context.Background()
	f := vk.NewFake()
	st, err := store.New(ctx, "postgres://u:p@127.0.0.1:1/pricing_batch_test")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(st.Close)
	h := &Handler{vk: f, store: st}
	merged := cachedCandidates(t, h, f, ctx, 3)
	// Delete the middle candidate's entry by overwriting it with a value no
	// Pricing can decode: a JSON scalar, not an object.
	if err := f.SetJSON(ctx, h.pricingKey(merged[1].Store.ModelID, merged[1].Store.ModelID), "not-json", time.Minute); err != nil {
		t.Fatal(err)
	}

	h.fillCandidatePricing(ctx, merged)

	if merged[1].Store.Price != nil {
		t.Errorf("undecodable entry was accepted as a price: %+v", merged[1].Store.Price)
	}
	if merged[0].Store.Price == nil || merged[2].Store.Price == nil {
		t.Error("one undecodable entry cost the rest of the batch its prices")
	}
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b [20]byte
	p := len(b)
	for i > 0 {
		p--
		b[p] = byte('0' + i%10)
		i /= 10
	}
	return string(b[p:])
}
