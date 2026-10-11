package limits_test

import (
	"context"
	"sync"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/limits"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/vk"
)

// fakeSpend is the durable sum source (the DB) standing in for *store.Store.
// It records how often it was consulted: the Valkey spend counter must keep
// the DB off the hot path, and a MISSING counter must fall back to it (spec §7:
// "counter loss must never make spending unbounded").
type fakeSpend struct {
	mu        sync.Mutex
	daily     int64
	monthly   int64
	dayCalls   int
	monthCalls int
}

func (f *fakeSpend) DailyCostMicro(context.Context, string) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.dayCalls++
	return f.daily, nil
}

func (f *fakeSpend) MonthlyCostMicro(context.Context, string) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.monthCalls++
	return f.monthly, nil
}

func (f *fakeSpend) calls() (int, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.dayCalls, f.monthCalls
}

func identity(key string, s *fakeSpend) *limits.APIKeyIdentity {
	return &limits.APIKeyIdentity{KeyID: key, WorkspaceID: "wrk_test", Store: s}
}

func ptr[T any](v T) *T { return &v }

// The Valkey path: a fixed window must admit up to the limit and deny the next
// request inside the same window.
func TestRPMEnforcedOnTheValkeyPath(t *testing.T) {
	l := limits.New(vk.NewFake())
	lim := &store.Limits{RPM: ptr(int64(2))}
	ident := identity("key_rpm", &fakeSpend{})

	for i := range 2 {
		adm, rej := l.Check(context.Background(), ident, lim, 0)
		if rej != nil {
			t.Fatalf("request %d rejected at limit 2: %+v", i+1, rej)
		}
		adm.Release()
	}
	_, rej := l.Check(context.Background(), ident, lim, 0)
	if rej == nil {
		t.Fatal("third request admitted past rpm=2 on the Valkey path")
	}
	if rej.HTTPStatus != 429 || rej.Code != "RATE_LIMITED" {
		t.Errorf("rejection = %+v, want 429 RATE_LIMITED", rej)
	}
}

// The S0 in-process fallback (spec §12: absent VALKEY_URL disables cleanly and
// callers fall back): the SAME limit must still be enforced, locally.
func TestRPMFallsBackToTheInProcessLimiter(t *testing.T) {
	l := limits.New(nil) // nil client = disabled: the fallback path
	lim := &store.Limits{RPM: ptr(int64(1))}
	ident := identity("key_fallback", &fakeSpend{})

	adm, rej := l.Check(context.Background(), ident, lim, 0)
	if rej != nil {
		t.Fatalf("first request rejected on the fallback path: %+v", rej)
	}
	adm.Release()
	if _, rej := l.Check(context.Background(), ident, lim, 0); rej == nil {
		t.Fatal("second request admitted past rpm=1 — the fallback limiter is not enforcing")
	}
}

// A DEAD Valkey (transport error, not disabled) must fail OPEN (spec §12: a
// cache outage must not become a customer outage).
func TestValkeyDownFailsOpen(t *testing.T) {
	f := vk.NewFake()
	f.FailAll()
	l := limits.New(f)
	lim := &store.Limits{RPM: ptr(int64(1)), Concurrency: ptr(int64(1))}
	ident := identity("key_open", &fakeSpend{})

	for range 5 {
		adm, rej := l.Check(context.Background(), ident, lim, 0)
		if rej != nil {
			t.Fatalf("a dead Valkey rejected a request: %+v — must fail open", rej)
		}
		adm.Release()
	}
}

// The concurrency gauge: the limit is admitted up to N and the (N+1)th is
// rejected; releasing frees the slot again.
func TestConcurrencyLimitHoldsAndFrees(t *testing.T) {
	l := limits.New(vk.NewFake())
	lim := &store.Limits{Concurrency: ptr(int64(2))}
	ident := identity("key_conc", &fakeSpend{})

	first, rej := l.Check(context.Background(), ident, lim, 0)
	if rej != nil {
		t.Fatalf("first admission rejected: %+v", rej)
	}
	second, rej := l.Check(context.Background(), ident, lim, 0)
	if rej != nil {
		t.Fatalf("second admission rejected at limit 2: %+v", rej)
	}
	if _, rej := l.Check(context.Background(), ident, lim, 0); rej == nil {
		t.Fatal("third in-flight request admitted past concurrency=2")
	}
	second.Release()
	third, rej := l.Check(context.Background(), ident, lim, 0)
	if rej != nil {
		t.Fatalf("release did not free the slot: %+v", rej)
	}
	third.Release()
	first.Release()
	// Double release must not corrupt the gauge (floored at zero).
	first.Release()
	adm, rej := l.Check(context.Background(), ident, lim, 0)
	if rej != nil {
		t.Fatalf("gauge corrupted after double release: %+v", rej)
	}
	adm.Release()
}

// TPM counts tokens, not requests: a request whose estimate would cross the
// window's token budget is rejected with the same normalized answer.
func TestTPMRejectsWhenTheWindowIsFull(t *testing.T) {
	l := limits.New(vk.NewFake())
	lim := &store.Limits{TPM: ptr(int64(100))}
	ident := identity("key_tpm", &fakeSpend{})

	adm, rej := l.Check(context.Background(), ident, lim, 60)
	if rej != nil {
		t.Fatalf("60 of 100 tokens rejected: %+v", rej)
	}
	adm.Release()
	if _, rej := l.Check(context.Background(), ident, lim, 60); rej == nil {
		t.Fatal("a second 60 tokens admitted past tpm=100")
	}
}

// Spend caps reject with 402 INSUFFICIENT_CREDITS — the budget's language, not
// the rate limiter's.
func TestSpendCapsRejectWith402(t *testing.T) {
	t.Run("monthly", func(t *testing.T) {
		f := vk.NewFake()
		l := limits.New(f)
		spend := &fakeSpend{monthly: 5_000}
		lim := &store.Limits{MonthlySpendMicro: ptr(int64(5_000))}
		_, rej := l.Check(context.Background(), identity("key_spend", spend), lim, 0)
		if rej == nil {
			t.Fatal("a key at its monthly spend cap was admitted")
		}
		if rej.HTTPStatus != 402 || rej.Code != "INSUFFICIENT_CREDITS" {
			t.Errorf("rejection = %+v, want 402 INSUFFICIENT_CREDITS", rej)
		}
	})
	t.Run("daily", func(t *testing.T) {
		l := limits.New(vk.NewFake())
		spend := &fakeSpend{daily: 10}
		lim := &store.Limits{DailySpendMicro: ptr(int64(10))}
		_, rej := l.Check(context.Background(), identity("key_daily", spend), lim, 0)
		if rej == nil || rej.HTTPStatus != 402 {
			t.Fatalf("a key at its daily spend cap was admitted: %+v", rej)
		}
	})
}

// The durable fallback must be consulted when the counter is missing (spec §7),
// and the fast path must keep it off the hot path afterwards.
func TestSpendFallsBackToTheDBWhenTheCounterIsMissing(t *testing.T) {
	l := limits.New(vk.NewFake())
	spend := &fakeSpend{monthly: 3_000}
	lim := &store.Limits{MonthlySpendMicro: ptr(int64(10_000))}

	// First check: no counter yet -> the DB sum is authoritative.
	if _, rej := l.Check(context.Background(), identity("key_seed", spend), lim, 0); rej != nil {
		t.Fatalf("unexpected rejection: %+v", rej)
	}
	dayCalls, monthCalls := spend.calls()
	if monthCalls == 0 {
		t.Fatal("the missing counter did not fall back to the durable sum")
	}

	// Second check: the counter was re-seeded -> no new DB round trip.
	if _, rej := l.Check(context.Background(), identity("key_seed", spend), lim, 0); rej != nil {
		t.Fatalf("unexpected rejection: %+v", rej)
	}
	if _, monthAfter := spend.calls(); monthAfter != monthCalls {
		t.Errorf("month DB lookups %d -> %d: the fast path is not fast", monthCalls, monthAfter)
	}
	_ = dayCalls
}

// A completed request's spend is added to the counters so the NEXT request's
// fast path sees it: the cap must bite at the right value without a DB hit.
func TestSpendAddMovesTheFastPathCounter(t *testing.T) {
	f := vk.NewFake()
	l := limits.New(f)
	spend := &fakeSpend{}
	ident := identity("key_add", spend)
	lim := &store.Limits{MonthlySpendMicro: ptr(int64(100))}

	// Seed the counter from the (zero) DB sum, then record spend.
	if _, rej := l.Check(context.Background(), ident, lim, 0); rej != nil {
		t.Fatal(rej)
	}
	l.SpendAdd(context.Background(), ident, 150)

	_, monthCallsBefore := spend.calls()
	if _, rej := l.Check(context.Background(), ident, lim, 0); rej == nil {
		t.Fatal("spend past the cap was admitted after SpendAdd")
	}
	if _, monthCallsAfter := spend.calls(); monthCallsAfter != monthCallsBefore {
		t.Error("the cap was enforced by a DB round trip instead of the counter")
	}
}
