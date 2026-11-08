package store_test

// B2 — the grant writer must persist `subscription.economic_bucket` for every
// window it mints, and a replayed payment must never stack a second window.
// Before this, GrantSubscription ignored the bucket entirely, so a 7-day buyer
// resolved at admission through the precedence chain all the way down to
// `frpayg` — they were sold TIME but metered as prepaid and drained. These
// cases pin the writer's two invariants: a grant writes the bucket it is told,
// and one payment_id is one subscription (sequential AND the durable
// concurrent backstop).

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

func TestGrantSubscriptionWritesEconomicBucket(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	s, err := store.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	ctx := context.Background()

	// A 7-day subscriber buying under the flat-fee subscription bucket.
	sub, err := s.GrantSubscription(ctx, env.UserID, "sub_7d", 7, 30000, "pay_7d_1", store.BucketSubs)
	if err != nil {
		t.Fatalf("GrantSubscription: %v", err)
	}
	if sub.EconomicBucket == nil || *sub.EconomicBucket != string(store.BucketSubs) {
		t.Errorf("economic_bucket = %v, want %q", sub.EconomicBucket, store.BucketSubs)
	}
	if sub.PaymentID == nil || *sub.PaymentID != "pay_7d_1" {
		t.Errorf("payment_id = %v, want pay_7d_1", sub.PaymentID)
	}

	// The admission resolution must see the subscription tier, not frpayg.
	key := &store.APIKeyRow{ID: env.APIKeyID, UserID: env.UserID}
	got, err := s.ResolveBucket(ctx, key)
	if err != nil {
		t.Fatalf("ResolveBucket: %v", err)
	}
	if got != store.BucketSubs {
		t.Errorf("ResolveBucket = %q, want %q (a live frsubs window must win, S3)", got, store.BucketSubs)
	}
}

func TestGrantSubscriptionPaymentReplayIsIdempotent(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	s, err := store.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	ctx := context.Background()

	first, err := s.GrantSubscription(ctx, env.UserID, "sub_7d", 7, 30000, "pay_7d_1", store.BucketSubs)
	if err != nil {
		t.Fatalf("first GrantSubscription: %v", err)
	}
	second, err := s.GrantSubscription(ctx, env.UserID, "sub_7d", 7, 30000, "pay_7d_1", store.BucketSubs)
	if err != nil {
		t.Fatalf("replayed GrantSubscription: %v", err)
	}
	if second.ID != first.ID {
		t.Errorf("replay minted a second row: %s vs %s (want the SAME row)", second.ID, first.ID)
	}

	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(context.Background()) })
	var n int
	if err := conn.QueryRow(ctx,
		`select count(*) from subscription where payment_id = $1`, "pay_7d_1").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("subscription rows for payment_id = %d, want exactly 1", n)
	}
}

func TestGrantSubscriptionBucketHelperWritesStringBucket(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	s, err := store.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	ctx := context.Background()

	// GrantSubscriptionBucket is the bridge for callers that hold a string.
	sub, err := s.GrantSubscriptionBucket(ctx, env.UserID, "sub_14d", "frsubs", 14, 50000, "pay_14d_1")
	if err != nil {
		t.Fatalf("GrantSubscriptionBucket: %v", err)
	}
	if sub.EconomicBucket == nil || *sub.EconomicBucket != "frsubs" {
		t.Errorf("economic_bucket = %v, want frsubs", sub.EconomicBucket)
	}
}
