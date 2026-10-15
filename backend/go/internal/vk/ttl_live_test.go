package vk

// The counter TTL guard must be verified against a REAL Valkey, not a fake.
//
// Why this file exists: the fixed-window counters armed their expiry with
// `if v == ARGV[1] then … PEXPIRE`. ARGV arrives as a STRING, so that compares a
// Lua number against a string — false in Lua, always — and PEXPIRE never ran. The
// counter therefore had no expiry at all, and because the token-window key is
// `rl:api_key:<id>:tpm|tpd` (no bucket in the name), the TTL was the only thing
// that could ever end the window: a key that reached its daily token cap once
// stayed capped for the life of the process.
//
// It survived a green suite because Fake interpreted the script's INTENT rather
// than executing it. A fake cannot catch a script that does not do what it says,
// so this test runs the shipped script object against a real server through the
// real client, and skips only when VALKEY_URL is absent.
//
// Verified by mutation: reverting incrByBucketScript to `v == ARGV[1]` turns the
// PTTL assertions red (observed -1, i.e. no expiry).

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"
)

// requireLive returns a live client, or skips when no Valkey is configured. The
// suite must stay runnable without one (spec §12: no cache is a valid config).
func requireLive(t *testing.T) Client {
	t.Helper()
	if os.Getenv(EnvURL) == "" {
		t.Skip("VALKEY_URL not set: the counter TTL contract needs a real server")
	}
	c, err := NewFromEnv()
	if err != nil {
		t.Fatalf("NewFromEnv: %v", err)
	}
	if _, err := c.IncrByBucket(context.Background(), []string{"probe:reach"}, 0, time.Minute); err != nil {
		if errors.Is(err, ErrDisabled) {
			t.Skip("Valkey reports disabled")
		}
		t.Skipf("Valkey unreachable: %v", err)
	}
	return c
}

func TestIncrByBucketArmsTheWindowTTL(t *testing.T) {
	c := requireLive(t)
	ctx := context.Background()
	key := "rl:api_key:ttlprobe:tpm"
	_ = deleteKeys(t, c, key)

	if _, err := c.IncrByBucket(ctx, []string{key}, 1200, time.Minute); err != nil {
		t.Fatalf("IncrByBucket: %v", err)
	}
	if pttl := pttlMs(t, c, key); pttl <= 0 {
		t.Fatalf("after the first write the counter has PTTL=%d ms: the window has no expiry, "+
			"so a token cap that is reached once can never roll over", pttl)
	}

	// A later write must NOT re-arm the TTL: the window belongs to the FIRST
	// write. Re-arming would let a steady stream of requests slide the window
	// forward forever, which is the opposite of a fixed window.
	time.Sleep(1200 * time.Millisecond)
	before := pttlMs(t, c, key)
	if _, err := c.IncrByBucket(ctx, []string{key}, 1, time.Minute); err != nil {
		t.Fatalf("second IncrByBucket: %v", err)
	}
	after := pttlMs(t, c, key)
	if after > before {
		t.Errorf("a later write re-armed the TTL: %d ms -> %d ms (the window slid)", before, after)
	}
	_ = deleteKeys(t, c, key)
}

// The multi-key form must arm EVERY key's TTL, and return the totals in KEYS
// order — the limiter's allow decision is `totals[0] <= limit`.
func TestIncrByBucketIsOneRoundTripForNKeys(t *testing.T) {
	c := requireLive(t)
	ctx := context.Background()
	keys := []string{"spend:probe:a:day", "spend:probe:b:day", "spend:probe:c:day"}
	_ = deleteKeys(t, c, keys...)

	totals, err := c.IncrByBucket(ctx, keys, 500, time.Hour)
	if err != nil {
		t.Fatalf("IncrByBucket: %v", err)
	}
	if len(totals) != len(keys) {
		t.Fatalf("returned %d totals for %d keys — the caller indexes totals[0]", len(totals), len(keys))
	}
	for i, want := range []int64{500, 500, 500} {
		if totals[i] != want {
			t.Errorf("totals[%d] = %d, want %d", i, totals[i], want)
		}
	}
	// The running total must accumulate on the same key.
	totals, err = c.IncrByBucket(ctx, keys, 250, time.Hour)
	if err != nil {
		t.Fatalf("second IncrByBucket: %v", err)
	}
	if totals[0] != 750 {
		t.Errorf("second increment = %d, want 750", totals[0])
	}
	for _, k := range keys {
		if pttl := pttlMs(t, c, k); pttl <= 0 {
			t.Errorf("key %s has PTTL=%d ms: a counter without a TTL never rolls over", k, pttl)
		}
	}
	_ = deleteKeys(t, c, keys...)
}

func TestReplaceBucketsSetsValueAndTTL(t *testing.T) {
	c := requireLive(t)
	ctx := context.Background()
	keys := []string{"spend:probe:re:day", "spend:probe:re:month"}
	_ = deleteKeys(t, c, keys...)

	if err := c.ReplaceBuckets(ctx, keys, 4242, time.Hour); err != nil {
		t.Fatalf("ReplaceBuckets: %v", err)
	}
	for _, k := range keys {
		var got int64
		if err := c.GetJSON(ctx, k, &got, 0); err != nil {
			t.Fatalf("GetJSON %s: %v", k, err)
		}
		if got != 4242 {
			t.Errorf("%s = %d, want 4242", k, got)
		}
		if pttl := pttlMs(t, c, k); pttl <= 0 {
			t.Errorf("%s has PTTL=%d ms after the re-seed", k, pttl)
		}
	}
	_ = deleteKeys(t, c, keys...)
}

// pttlMs reads a key's remaining TTL, in milliseconds, straight from the server.
//
// It reaches past the Client interface on purpose: the interface deliberately has
// no general-purpose command escape hatch any more (see vk.go's note on why), and
// PTTL is exactly the kind of assertion a fake cannot stand in for — the bug this
// file pins was a TTL that was never armed. -1 means "no expiry".
func pttlMs(t *testing.T, c Client, key string) int64 {
	t.Helper()
	lv, ok := c.(*live)
	if !ok {
		t.Skipf("PTTL needs the live client, got %T", c)
	}
	res := lv.c.Do(context.Background(), lv.c.B().Pttl().Key(key).Build())
	n, err := res.AsInt64()
	if err != nil {
		t.Fatalf("PTTL %s: %v", key, err)
	}
	return n
}

func deleteKeys(t *testing.T, c Client, keys ...string) error {
	t.Helper()
	for _, k := range keys {
		lv, ok := c.(*live)
		if !ok {
			return nil
		}
		if err := lv.c.Do(context.Background(), lv.c.B().Del().Key(k).Build()).Error(); err != nil {
			return err
		}
	}
	return nil
}
