package vk

// Batched cache reads (MGET) must agree with repeated GetJSON, including the
// miss case.
//
// Why this file exists: a `[NAME]/*` virtual request prices every candidate it
// has, which is every model in the catalogue. Doing that with one GetJSON per
// candidate paid one round trip per model — measured at 500 reads for a
// 500-model catalogue — on the admission path, before the first upstream byte.
// GetJSONMany collapses that into one MGET.
//
// The property that makes it usable is MISS-TOLERANCE: MGET returns a nil
// element per missing key, so `out` must contain exactly the keys that were
// present and the caller must be able to fall back per key. A batched read that
// errored on the first miss would be worse than the loop it replaced, and one
// that paired values with keys by position after dropping an element would hand
// one model's price to another — the first is asserted here, the second is why
// the implementation checks the reply length.

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestGetJSONManyReadsPresentKeysAndSkipsMissing(t *testing.T) {
	ctx := context.Background()
	f := NewFake()
	for _, k := range []string{"p:a", "p:c"} {
		if err := f.SetJSON(ctx, k, map[string]int{"n": len(k)}, time.Minute); err != nil {
			t.Fatal(err)
		}
	}

	keys := []string{"p:a", "p:b", "p:c"}
	out := map[string]json.RawMessage{}
	if err := f.GetJSONMany(ctx, keys, out, time.Minute); err != nil {
		t.Fatalf("GetJSONMany: %v", err)
	}
	if len(out) != 2 {
		t.Fatalf("got %d entries, want 2 (p:a and p:c): %v", len(out), out)
	}
	for _, k := range []string{"p:a", "p:c"} {
		var v map[string]int
		if err := json.Unmarshal(out[k], &v); err != nil {
			t.Errorf("decode %s: %v", k, err)
		}
		if v["n"] != len(k) {
			t.Errorf("%s decoded to %v — a value was paired with the wrong key", k, v)
		}
	}
	if _, ok := out["p:b"]; ok {
		t.Error("a missing key produced an entry")
	}
}

// The disabled client is the "no cache configured" configuration, and it must
// report ErrDisabled so callers fall back rather than reading an empty map as
// "everything is a cache miss by value".
func TestGetJSONManyDisabled(t *testing.T) {
	out := map[string]json.RawMessage{}
	if err := Disabled().GetJSONMany(context.Background(), []string{"x"}, out, 0); err != ErrDisabled {
		t.Errorf("err = %v, want ErrDisabled", err)
	}
}

// A transport failure must surface as an error, not as "no keys were present":
// the caller treats an error by pricing the whole set from the DB, while an
// empty success would look like a cold cache and do the same work per key.
func TestGetJSONManyTransportFailureIsAnError(t *testing.T) {
	f := NewFake()
	f.FailAll()
	out := map[string]json.RawMessage{}
	if err := f.GetJSONMany(context.Background(), []string{"x"}, out, 0); err == nil {
		t.Fatal("transport failure reported as success")
	}
}

// The cache-hit tally (owner rule 19: ≥60% of reads served from cache) must
// count a present key as a hit and an absent key as a miss, and a transport
// failure as NEITHER — the read never reached the cache, so counting it as a
// miss would understate the hit rate during a Valkey outage and make the target
// look unmet for a reason that has nothing to do with cache effectiveness.
func TestCacheStatsCountHitsAndMisses(t *testing.T) {
	ctx := context.Background()
	f := NewFake()
	if err := f.SetJSON(ctx, "present", 1, time.Minute); err != nil {
		t.Fatal(err)
	}

	var v int
	if err := f.GetJSON(ctx, "present", &v, 0); err != nil {
		t.Fatalf("hit read: %v", err)
	}
	if err := f.GetJSON(ctx, "absent", &v, 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("miss read err = %v, want ErrNotFound", err)
	}

	// A batched read: one present, one absent.
	out := map[string]json.RawMessage{}
	if err := f.GetJSONMany(ctx, []string{"present", "absent"}, out, 0); err != nil {
		t.Fatalf("batched read: %v", err)
	}

	// A transport failure must not move either counter.
	f.FailAll()
	_ = f.GetJSON(ctx, "present", &v, 0)

	got := f.CacheStats()
	if got.Hits != 2 {
		t.Errorf("Hits = %d, want 2 (one GetJSON hit + one batched hit)", got.Hits)
	}
	if got.Misses != 2 {
		t.Errorf("Misses = %d, want 2 (one GetJSON miss + one batched miss)", got.Misses)
	}
	if rate := got.HitRate(); rate != 0.5 {
		t.Errorf("HitRate = %v, want 0.5", rate)
	}
}

// A zero tally reports a 0 hit rate rather than dividing by zero — the disabled
// client and a freshly started process both read this before any cache read.
func TestCacheStatsZeroTally(t *testing.T) {
	if rate := (CacheStats{}).HitRate(); rate != 0 {
		t.Errorf("empty HitRate = %v, want 0", rate)
	}
	if got := Disabled().CacheStats(); got.Hits != 0 || got.Misses != 0 {
		t.Errorf("disabled CacheStats = %+v, want zero", got)
	}
}
