package proxy

// H4: the spend counter keys must name the PERIOD they count, and the read
// (budgetSpent) and write (budgetSpendAdd) paths must spell them identically.
//
// The bug: the keys were `spend:{scope}:{id}:{day|month}` with no period, and
// the day bucket's 25h TTL outlives the UTC day boundary — yesterday's counter
// was still live this morning and budgetSpent read it as today's spend,
// producing false 402 INSUFFICIENT_CREDITS until the TTL aged it out.
//
// These tests run against vk.NewFake (no database): a write followed by a read
// must hit the counter (the durable sum is never consulted), and a counter
// seeded under a PREVIOUS period's key must miss — the read falls back to the
// durable sum instead of reading stale spend.

import (
	"context"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/vk"
)

func TestBudgetSpendKeysCarryThePeriod(t *testing.T) {
	f := vk.NewFake()
	h := &Handler{vk: f}
	lc := &lifecycle{h: h, key: &store.APIKeyRow{
		ID:     "key_1",
		UserID: "usr_1",
	}}

	// Write, then read: the read must see the counter, not the durable sum.
	h.budgetSpendAdd(context.Background(), lc, 500)

	b := &store.Budget{Scope: "account", ScopeID: "usr_1", Period: "daily"}
	used, err := h.budgetSpent(context.Background(), lc, b)
	if err != nil {
		t.Fatalf("budgetSpent: %v", err)
	}
	if used != 500 {
		t.Fatalf("read %d after writing 500 — read and write keys disagree (H4)", used)
	}

	bm := &store.Budget{Scope: "account", ScopeID: "usr_1", Period: "monthly"}
	used, err = h.budgetSpent(context.Background(), lc, bm)
	if err != nil {
		t.Fatalf("budgetSpent monthly: %v", err)
	}
	if used != 500 {
		t.Fatalf("monthly read %d after writing 500 — read and write keys disagree (H4)", used)
	}
}

func TestBudgetSpendKeyFromPreviousPeriodMisses(t *testing.T) {
	f := vk.NewFake()
	// The durable fallback needs a non-nil store; the dead DSN (export_test.go's
	// pattern) makes SpendMicro fail fast instead of dialing anything.
	st, err := store.New(context.Background(), deadStoreDSN)
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(st.Close)
	h := &Handler{vk: f, store: st}
	lc := &lifecycle{h: h, key: &store.APIKeyRow{
		ID:     "key_2",
		UserID: "usr_2",
	}}

	// Seed the counter under YESTERDAY's period-named key, exactly as the old
	// unperioded key left behind at the UTC boundary.
	yesterday := time.Now().UTC().AddDate(0, 0, -1).Format("20060102")
	stale := "spend:account:usr_2:day:" + yesterday
	if _, err := f.IncrByBucket(context.Background(), []string{stale}, 9_999, 25*time.Hour); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// Today's read must NOT see yesterday's counter: it misses and falls
	// back to the durable sum, which errors against the dead DSN. The
	// assertions are two-sided: not 9999 (the stale bucket was not read) and
	// an error (the fallback WAS consulted — the key missed rather than
	// silently returning zero).
	b := &store.Budget{Scope: "account", ScopeID: "usr_2", Period: "daily"}
	used, err := h.budgetSpent(context.Background(), lc, b)
	if used == 9_999 {
		t.Fatal("read 9999 from a previous period's key — the stale bucket leaked into today's budget (H4)")
	}
	if err == nil {
		t.Fatal("the read did not fall back to the durable sum — the stale key was satisfied instead of missing (H4)")
	}
}
