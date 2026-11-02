// guard_test.go — the four-case contract the owner set (acceptance criterion 3):
// every rule is exercised with success, error, warn and unknown inputs.
//
// Why four and not one: a single happy-path test proves the code runs, not that
// it decides. The four cases are the four things a caller can hand this package
// — a valid input, an input that must be refused, an input that must warn but
// not refuse, and an input the code has never seen (missing field, unmodelled
// value, absent row). The "unknown" case is the one that catches a nil map, a
// zero time, or a default branch that silently allows.
package entitlement

import (
	"context"
	"testing"
	"time"
)

func fixedNow(t time.Time) func() time.Time { return func() time.Time { return t } }

// --- rule 14: max 3 IPs -----------------------------------------------------

func TestCheckIP(t *testing.T) {
	t.Run("success: three distinct addresses are admitted", func(t *testing.T) {
		g := New()
		for _, ip := range []string{"1.1.1.1", "2.2.2.2", "3.3.3.3"} {
			if d := g.CheckIP("k1", ip); !d.Allow {
				t.Fatalf("expected %s admitted, got %+v", ip, d)
			}
		}
		if n := g.IPCount("k1"); n != 3 {
			t.Fatalf("expected 3 admitted, got %d", n)
		}
	})

	t.Run("error: the fourth address is refused", func(t *testing.T) {
		g := New()
		g.SeedIPs("k1", []string{"1.1.1.1", "2.2.2.2", "3.3.3.3"})
		d := g.CheckIP("k1", "4.4.4.4")
		if d.Allow {
			t.Fatal("expected the fourth address refused")
		}
		if d.Rule != RuleIPLimit {
			t.Fatalf("expected rule %s, got %s", RuleIPLimit, d.Rule)
		}
	})

	t.Run("warn: a repeat address is admitted without consuming a slot", func(t *testing.T) {
		g := New()
		g.SeedIPs("k1", []string{"1.1.1.1", "2.2.2.2", "3.3.3.3"})
		// The key is full, but an address already on the list must still pass —
		// otherwise a member is locked out of their own key.
		if d := g.CheckIP("k1", "2.2.2.2"); !d.Allow {
			t.Fatalf("expected repeat address admitted, got %+v", d)
		}
		if n := g.IPCount("k1"); n != 3 {
			t.Fatalf("repeat must not grow the set, got %d", n)
		}
	})

	t.Run("unknown: an empty address is refused, not admitted", func(t *testing.T) {
		g := New()
		d := g.CheckIP("k1", "")
		if d.Allow {
			t.Fatal("an undetermined address must not be admitted")
		}
		if n := g.IPCount("k1"); n != 0 {
			t.Fatalf("a refused address must not consume a slot, got %d", n)
		}
	})
}

// --- rule 4: max 5 concurrency ---------------------------------------------

func TestAcquire(t *testing.T) {
	t.Run("success: five slots are granted", func(t *testing.T) {
		g := New()
		slots := make([]Slot, 0, MaxConcurrency)
		for i := range MaxConcurrency {
			s, d := g.Acquire("k1")
			if !d.Allow {
				t.Fatalf("slot %d refused: %+v", i, d)
			}
			slots = append(slots, s)
		}
		if n := g.Inflight("k1"); n != MaxConcurrency {
			t.Fatalf("expected %d in flight, got %d", MaxConcurrency, n)
		}
		for i := range slots {
			slots[i].Release()
		}
		if n := g.Inflight("k1"); n != 0 {
			t.Fatalf("expected gauge drained, got %d", n)
		}
	})

	t.Run("error: the sixth concurrent request is refused", func(t *testing.T) {
		g := New()
		for i := range MaxConcurrency {
			if _, d := g.Acquire("k1"); !d.Allow {
				t.Fatalf("slot %d refused early: %+v", i, d)
			}
		}
		_, d := g.Acquire("k1")
		if d.Allow {
			t.Fatal("expected the sixth request refused")
		}
		if d.Rule != RuleConcurrency {
			t.Fatalf("expected rule %s, got %s", RuleConcurrency, d.Rule)
		}
	})

	t.Run("warn: a refused acquire returns a safe no-op release", func(t *testing.T) {
		g := New()
		for range MaxConcurrency {
			g.Acquire("k1")
		}
		s, d := g.Acquire("k1")
		if d.Allow {
			t.Fatal("expected refusal")
		}
		// Releasing the zero Slot must not corrupt the gauge, and a double
		// release must be a no-op.
		s.Release()
		s.Release()
		if n := g.Inflight("k1"); n != MaxConcurrency {
			t.Fatalf("a refused release must not change the gauge, got %d", n)
		}
	})

	t.Run("unknown: an unseen key starts at zero and is admitted", func(t *testing.T) {
		g := New()
		s, d := g.Acquire("never-seen")
		if !d.Allow {
			t.Fatalf("an unseen key must be admitted, got %+v", d)
		}
		s.Release()
		if n := g.Inflight("never-seen"); n != 0 {
			t.Fatalf("expected drained, got %d", n)
		}
	})
}

// --- rule 12: subscription gate --------------------------------------------

func TestCheckSubscription(t *testing.T) {
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)

	t.Run("success: a live subscription is admitted", func(t *testing.T) {
		g := New()
		g.now = fixedNow(now)
		sub := &Subscription{Plan: "sub_7d", ExpiresAt: now.Add(24 * time.Hour)}
		if d := g.CheckSubscription(sub); !d.Allow {
			t.Fatalf("expected admitted, got %+v", d)
		}
	})

	t.Run("error: an expired subscription is refused", func(t *testing.T) {
		g := New()
		g.now = fixedNow(now)
		sub := &Subscription{Plan: "sub_1d", ExpiresAt: now.Add(-time.Hour)}
		d := g.CheckSubscription(sub)
		if d.Allow {
			t.Fatal("expected refused")
		}
		if d.Rule != RuleExpired {
			t.Fatalf("expected rule %s, got %s", RuleExpired, d.Rule)
		}
	})

	t.Run("warn: a subscription expiring exactly now is refused (boundary)", func(t *testing.T) {
		g := New()
		g.now = fixedNow(now)
		// ExpiresAt == now is NOT live: `After` is strict. The boundary must
		// fail closed so a member cannot ride a zero-width window.
		sub := &Subscription{Plan: "sub_1d", ExpiresAt: now}
		if d := g.CheckSubscription(sub); d.Allow {
			t.Fatal("an expiry at exactly now must be refused")
		}
	})

	t.Run("unknown: a nil subscription is refused, not treated as unlimited", func(t *testing.T) {
		g := New()
		g.now = fixedNow(now)
		d := g.CheckSubscription(nil)
		if d.Allow {
			t.Fatal("a nil subscription must be refused")
		}
		if d.Rule != RuleNoSubscription {
			t.Fatalf("expected rule %s, got %s", RuleNoSubscription, d.Rule)
		}
	})

	t.Run("unknown: a zero ExpiresAt is refused", func(t *testing.T) {
		g := New()
		g.now = fixedNow(now)
		sub := &Subscription{Plan: "sub_7d"} // ExpiresAt never set
		if d := g.CheckSubscription(sub); d.Allow {
			t.Fatal("a zero expiry must be refused")
		}
	})
}

// --- rule 15: auto-restrict escalation -------------------------------------

func TestShouldRestrict(t *testing.T) {
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)

	t.Run("success: an IP breach restricts immediately", func(t *testing.T) {
		if !ShouldRestrict(RuleIPLimit, now, now) {
			t.Fatal("an IP breach must restrict immediately")
		}
	})

	t.Run("error: a concurrency breach restricts immediately", func(t *testing.T) {
		if !ShouldRestrict(RuleConcurrency, now, now) {
			t.Fatal("a concurrency breach must restrict immediately")
		}
	})

	t.Run("warn: an expiry inside the grace window does NOT restrict", func(t *testing.T) {
		expired := now.Add(-time.Hour) // one hour ago, grace is 24h
		if ShouldRestrict(RuleExpired, expired, now) {
			t.Fatal("an expiry inside the grace window must warn, not restrict")
		}
	})

	t.Run("unknown: an unmodelled rule does not restrict", func(t *testing.T) {
		if ShouldRestrict("something_new", now, now) {
			t.Fatal("an unknown rule must not restrict by default")
		}
	})

	t.Run("error: an expiry past the grace window restricts", func(t *testing.T) {
		expired := now.Add(-48 * time.Hour)
		if !ShouldRestrict(RuleExpired, expired, now) {
			t.Fatal("an expiry past the grace window must restrict")
		}
	})
}

// --- context plumbing -------------------------------------------------------

func TestDecisionContext(t *testing.T) {
	t.Run("success: a stored decision round-trips", func(t *testing.T) {
		ctx := WithDecision(context.Background(), Decision{Rule: RuleIPLimit, Reason: "x"})
		d, ok := DecisionFrom(ctx)
		if !ok || d.Rule != RuleIPLimit {
			t.Fatalf("expected the stored decision, got %+v ok=%v", d, ok)
		}
	})

	t.Run("unknown: an empty context reports not-stored", func(t *testing.T) {
		if _, ok := DecisionFrom(context.Background()); ok {
			t.Fatal("an empty context must report no decision")
		}
	})
}

func TestRestrictReasonString(t *testing.T) {
	t.Run("success: rule and note join", func(t *testing.T) {
		if got := (RestrictReason{Rule: RuleIPLimit, Note: "4th ip"}).String(); got != "ip_limit: 4th ip" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("unknown: an empty note yields the bare rule", func(t *testing.T) {
		if got := (RestrictReason{Rule: RuleExpired}).String(); got != RuleExpired {
			t.Fatalf("got %q", got)
		}
	})
}
