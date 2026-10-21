package limits_test

// H4, second sighting: the per-API-key spend counter keys must name the PERIOD
// they count, and the read (Check) and write (SpendAdd) paths must spell them
// identically. The same bug was already fixed for the account/api_key budgets
// in proxy/budget.go (budget_keys_test.go) and missed here
// because the per-key path lives in another package.
//
// The bug: the keys were `spend:api_key:<id>:day|month` with no period, and
// the day bucket's 25h TTL outlives the UTC day boundary — yesterday's counter
// was still live this morning and Check read it as today's spend, producing
// false 402 INSUFFICIENT_CREDITS for a key that spent its whole daily cap
// yesterday, until the TTL aged it out.
//
// These tests run against vk.NewFake (no database): a SpendAdd write followed
// by a Check read must hit the counter (the durable sum is never consulted),
// and a counter seeded under the OLD unperioded key must miss — the read falls
// back to the durable sum instead of reading stale spend.

import (
	"context"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/limits"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/vk"
)

// A SpendAdd write must land on the key Check reads: the second cap check must
// be enforced by the counter (1100 against a 1000 cap), not by the durable sum
// — with fakeSpend zeroed, a read/write key mismatch would silently read 0
// from the DB and admit.
func TestSpendAddWritesTheKeyCheckReads(t *testing.T) {
	f := vk.NewFake()
	l := limits.New(f)
	spend := &fakeSpend{}
	ident := identity("key_period", spend)
	lim := &store.Limits{DailySpendMicro: ptr(int64(1000)), MonthlySpendMicro: ptr(int64(1000))}

	l.SpendAdd(context.Background(), ident, 500)
	if _, rej := l.Check(context.Background(), ident, lim, 0); rej != nil {
		t.Fatalf("the counter SpendAdd wrote was not visible to Check: %v", rej)
	}
	l.SpendAdd(context.Background(), ident, 600) // 1100 > both caps
	_, rej := l.Check(context.Background(), ident, lim, 0)
	if rej == nil {
		t.Fatal("1100 against a 1000 cap was admitted — SpendAdd and Check spelled the key differently (H4)")
	}
	if rej.Code != "INSUFFICIENT_CREDITS" || rej.HTTPStatus != 402 {
		t.Fatalf("got %d %s, want 402 INSUFFICIENT_CREDITS", rej.HTTPStatus, rej.Code)
	}
}

// The old unperioded key is exactly what a pre-fix process left behind at the
// UTC boundary. Today's read must NOT see it: it misses and falls back to the
// durable sum (fakeSpend.daily = 100), so the key is admitted instead of
// reading yesterday's 9999 as today's spend.
func TestSpendKeyFromPreviousPeriodMisses(t *testing.T) {
	f := vk.NewFake()
	l := limits.New(f)
	spend := &fakeSpend{daily: 100, monthly: 100}
	ident := identity("key_stale", spend)
	lim := &store.Limits{DailySpendMicro: ptr(int64(1000)), MonthlySpendMicro: ptr(int64(1000))}

	// Seed the OLD unperioded spelling — the key the pre-fix code read and
	// wrote — with yesterday's full daily cap.
	stale := "spend:api_key:key_stale:day"
	if _, err := f.IncrByBucket(context.Background(), []string{stale}, 9_999, 25*time.Hour); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if _, rej := l.Check(context.Background(), ident, lim, 0); rej != nil {
		t.Fatalf("yesterday's 9999 leaked into today's cap check: %v (H4)", rej)
	}
}
