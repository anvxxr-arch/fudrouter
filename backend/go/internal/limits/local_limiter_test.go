package limits

// The S0 in-process limiter's window accounting, asserted directly.
//
// Why this file exists: it is the fallback that still enforces when Valkey is
// down, and its weighting was silently wrong. Three defects, each of which had
// a test that could not see it (the existing suite holds every weight at 1 and
// never ages a window):
//
//  1. Slot weights lived in a PACKAGE-LEVEL map keyed by the key name alone, so
//     two Limiter instances shared bookkeeping.
//  2. The weight was filed under `len(ts)-1` BEFORE the append — the last
//     EXISTING slot — so a slot's own weight was never recorded and the previous
//     one was overwritten. Uniform weights (RPM) hid it; the TOKEN path passes
//     the estimate as the weight, so a pruned window subtracted another
//     request's tokens.
//  3. Nothing evicted a key, so every key ever seen kept a map entry forever.
//
// These are internal-package tests because the state is unexported: the
// assertions are about the limiter's own bookkeeping, not its HTTP surface.

import (
	"testing"
	"time"
)

// TestWeightedWindowAccountsPerSlot is the discriminator for defect 2. It mixes
// weights and lets a window age out, which is the only way the mis-filed weight
// becomes observable: before the fix the aged-out total came out 10 instead of
// 0, so the next request was refused a full window early.
func TestWeightedWindowAccountsPerSlot(t *testing.T) {
	l := newLocalLimiter()
	const k, limit = "weighted", 100
	const window = 60 * time.Millisecond

	if !l.allow(k, limit, window, 10) {
		t.Fatal("first request refused")
	}
	if !l.allow(k, limit, window, 70) {
		t.Fatal("second request refused at 80/100")
	}
	if !l.allow(k, limit, window, 20) {
		t.Fatal("third request refused at exactly 100/100")
	}
	// Exactly at the limit: one more token must not fit.
	if l.allow(k, limit, window, 1) {
		t.Error("window admitted 101 of 100 tokens")
	}

	time.Sleep(window + 20*time.Millisecond)

	// Every slot has aged out, so the full budget is available again. This is
	// the assertion the old mis-indexed bookkeeping failed.
	if !l.allow(k, limit, window, 100) {
		t.Errorf("after the window elapsed, 100/100 tokens were refused — aged weights were not fully subtracted")
	}
}

// TestLimiterStateIsPerInstance covers defect 1: two limiters on one key must
// not see each other's windows.
func TestLimiterStateIsPerInstance(t *testing.T) {
	var a, b localLimiter
	a = newLocalLimiter()
	b = newLocalLimiter()
	const k = "same-key"

	// a fills its own window exactly.
	if !a.allow(k, 10, time.Minute, 10) {
		t.Fatal("a refused its first request")
	}
	if a.allow(k, 10, time.Minute, 1) {
		t.Fatal("a admitted 11 of 10")
	}

	// b has seen nothing, so it must still have its whole budget.
	if !b.allow(k, 10, time.Minute, 10) {
		t.Error("b refused a request because a's window was charged against shared state")
	}
}

// TestWindowEntriesAreEvicted covers defect 3: a key whose window has emptied
// must not keep an entry, and a key that NEVER comes back must also be
// reclaimed — the case lazy eviction cannot reach.
func TestWindowEntriesAreEvicted(t *testing.T) {
	l := newLocalLimiter()
	const n = 200
	const window = 40 * time.Millisecond

	for i := range n {
		if !l.allow(keyN(i), 5, window, 1) {
			t.Fatalf("key %d refused", i)
		}
	}
	if got := l.size(); got != n {
		t.Fatalf("window holds %d entries for %d keys", got, n)
	}

	// Abandon them: no further allow call for these keys. Only the opportunistic
	// sweep can reclaim them, so drive it past its interval.
	time.Sleep(window + 20*time.Millisecond)
	for i := range sweepEvery + 1 {
		l.allow("sweep-driver", 5, time.Hour, 1)
		_ = i
	}
	if got := l.size(); got > 2 {
		t.Errorf("after the sweep, %d of %d abandoned keys still hold entries", got, n)
	}

	// A key that ages out while still being called is dropped the same way.
	if !l.allow("evict-me", 5, window, 1) {
		t.Fatal("refused")
	}
	time.Sleep(window + 20*time.Millisecond)
	if !l.allow("evict-me", 5, window, 1) {
		t.Fatal("refused after its window elapsed")
	}
	if w := l.keys["evict-me"]; w == nil || len(w.slots) != 1 {
		t.Errorf("pruned window should hold only the new slot, got %+v", w)
	}
}

// TestConcurrencyGaugeIsReleasedAndEvicted: the gauge must return to nothing,
// not to a stored zero.
func TestConcurrencyGaugeIsReleasedAndEvicted(t *testing.T) {
	l := newLocalLimiter()
	const k = "gauge"

	if _, over := l.tryIncr(k, 2); over {
		t.Fatal("first slot reported over limit")
	}
	if _, over := l.tryIncr(k, 2); over {
		t.Fatal("second slot reported over limit")
	}
	if _, over := l.tryIncr(k, 2); !over {
		t.Error("third slot admitted past a limit of 2")
	}
	l.decr(k)
	if len(l.inFlight) != 1 {
		t.Fatalf("in-flight gauge holds %d entries, want 1", len(l.inFlight))
	}
	l.decr(k)
	if len(l.inFlight) != 0 {
		t.Errorf("released gauge keeps an entry: %v", l.inFlight)
	}
}

func keyN(i int) string {
	return "key-" + string(rune('a'+i%26)) + string(rune('a'+(i/26)%26)) + string(rune('0'+i%10))
}
