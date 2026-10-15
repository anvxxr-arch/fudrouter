package vk

// The window semantics the Lua scripts implement in the live client, pinned
// against the fake (spec §12 + assignment: "Tests with a fake client for window
// logic"). The fake mirrors those semantics deliberately — a regression in
// EITHER side of the pair must fail here, or the fake would start blessing
// behaviour the server never implements.

import (
	"context"
	"errors"
	"testing"
	"time"
)

// The window counts the call that hits the limit before comparing: a limit of
// 2 allows exactly two calls and denies the third IN THE SAME WINDOW.
func TestWindowAllowsUpToLimitThenDenies(t *testing.T) {
	f := NewFake()
	ctx := context.Background()
	for i := 1; i <= 2; i++ {
		ok, err := f.AllowRate(ctx, "rl:test:rpm", 2, time.Minute)
		if err != nil || !ok {
			t.Fatalf("call %d: allowed=%v err=%v, want allow in window", i, ok, err)
		}
	}
	ok, err := f.AllowRate(ctx, "rl:test:rpm", 2, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Error("third call allowed past limit=2 — the count must include the limiting call")
	}
}

// A non-positive limit is UNLIMITED and never denies (spec §7: effective
// limits are minima of present values; absent = unbounded).
func TestZeroLimitNeverDenies(t *testing.T) {
	f := NewFake()
	ctx := context.Background()
	for i := 0; i < 5; i++ {
		ok, err := f.AllowRate(ctx, "rl:test:rpm", 0, time.Minute)
		if err != nil || !ok {
			t.Fatalf("unlimited call %d: allowed=%v err=%v", i, ok, err)
		}
	}
}

// TTL is armed on the FIRST hit and the window then EXPIRES: after the window
// passes, the count resets and the next call is allowed again. A counter that
// never expires would ban a key forever.
func TestWindowExpiresAndResets(t *testing.T) {
	f := NewFake()
	ctx := context.Background()
	if ok, _ := f.AllowRate(ctx, "rl:reset:rpm", 1, 10*time.Millisecond); !ok {
		t.Fatal("first call denied")
	}
	if ok, _ := f.AllowRate(ctx, "rl:reset:rpm", 1, 10*time.Millisecond); ok {
		t.Fatal("second call allowed inside a limit=1 window")
	}
	time.Sleep(50 * time.Millisecond) // ≥5x the window: expiry is the only outcome
	if ok, _ := f.AllowRate(ctx, "rl:reset:rpm", 1, 10*time.Millisecond); !ok {
		t.Error("call after window expiry denied — the window must reset the count")
	}
}

// Windows are per key: one key's full window must not starve another's.
func TestWindowsArePerKey(t *testing.T) {
	f := NewFake()
	ctx := context.Background()
	if ok, _ := f.AllowRate(ctx, "rl:a:rpm", 1, time.Minute); !ok {
		t.Fatal("key a first call denied")
	}
	if ok, _ := f.AllowRate(ctx, "rl:b:rpm", 1, time.Minute); !ok {
		t.Error("key b denied by key a's window — limits must be per key")
	}
	if ok, _ := f.AllowRate(ctx, "rl:a:rpm", 1, time.Minute); ok {
		t.Error("key a allowed past its own limit")
	}
}

// IncrConc/DecrConc is a concurrency gauge: increments stack, decrements free,
// and the gauge floors at zero (a duplicate release must not go negative and
// hand out phantom capacity).
func TestConcurrencyGaugeStacksAndFrees(t *testing.T) {
	f := NewFake()
	ctx := context.Background()
	key := "conc:test"
	for want := int64(1); want <= 3; want++ {
		n, err := f.IncrConc(ctx, key, time.Minute)
		if err != nil || n != want {
			t.Fatalf("IncrConc #%d = (%d, %v), want (%d, nil)", want, n, err, want)
		}
	}
	if err := f.DecrConc(ctx, key); err != nil {
		t.Fatal(err)
	}
	if n, _ := f.IncrConc(ctx, key, time.Minute); n != 3 {
		t.Errorf("gauge after one free = %d, want 3", n)
	}
	// Over-release floors at zero.
	for i := 0; i < 4; i++ {
		if err := f.DecrConc(ctx, key); err != nil {
			t.Fatal(err)
		}
	}
	if n, _ := f.IncrConc(ctx, key, time.Minute); n != 1 {
		t.Errorf("gauge after over-release = %d, want 1 (floored at zero)", n)
	}
}

// The spend fast path reads its own counter via GetJSON after an INCRBY, so the
// fake must mirror the counter into the JSON store — real Valkey holds ONE value
// per key and a fake that kept two would hide a read-after-write bug.
func TestCounterIsReadableViaGetJSON(t *testing.T) {
	f := NewFake()
	ctx := context.Background()
	out, err := f.IncrByBucket(ctx, []string{"spend:ws"}, 500, time.Minute)
	if err != nil || len(out) != 1 || out[0] != 500 {
		t.Fatalf("IncrByBucket = (%v, %v), want [500]", out, err)
	}
	var v int64
	if err := f.GetJSON(ctx, "spend:ws", &v, 0); err != nil || v != 500 {
		t.Errorf("GetJSON after IncrByBucket = (%d, %v), want (500, nil)", v, err)
	}
	if out, err = f.IncrByBucket(ctx, []string{"spend:ws"}, 250, time.Minute); err != nil || out[0] != 750 {
		t.Fatalf("second IncrByBucket = (%v, %v), want [750]", out, err)
	}
}

// Absent key vs disabled client vs dead server are three DIFFERENT errors
// (spec §12): a missing key is ErrNotFound, and a dead server degrades OPEN
// (allow) with a non-nil error — never a denial.
func TestMissingKeyAndTransportFailureAreDistinct(t *testing.T) {
	f := NewFake()
	ctx := context.Background()
	var v int64
	if err := f.GetJSON(ctx, "nope", &v, 0); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetJSON missing key err = %v, want ErrNotFound", err)
	}
	f.FailAll()
	if ok, err := f.AllowRate(ctx, "rl:test:rpm", 1, time.Minute); !ok || err == nil {
		t.Errorf("dead server: allowed=%v err=%v, want (true, transport error) — degrade OPEN", ok, err)
	}
	var te ErrTransport
	if _, err := f.AllowRate(ctx, "rl:test:rpm", 1, time.Minute); !errors.As(err, &te) {
		t.Errorf("dead server err = %v, want ErrTransport", err)
	}
}
