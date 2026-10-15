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
