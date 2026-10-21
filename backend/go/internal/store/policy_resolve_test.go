package store_test

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

// A key with no account binding must still resolve the platform default
// policy. The lookup's outer `coalesce(...)` returned SQL NULL
// when no account row bound a policy, and scanning NULL into a string made
// RoutingPolicyFor fail for EVERY unscoped key. The proxy swallows that error
// and falls back to DefaultRoutingPolicy(), so the stored policy —
// max_attempts, weights, constraints, strategy — silently never applied.
// Symptom: the fallback walk stopped after two attempts no matter what the
// policy row said, so a request could not step past two failing candidates.
func TestRoutingPolicyForUnscopedKey(t *testing.T) {
	dsn := tests.RequireDB(t)
	ctx := context.Background()

	// What the database actually holds for the platform default.
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var wantID string
	var wantMax int
	if err := conn.QueryRow(ctx, `
		select rp.id, rp.max_attempts
		from routing_policy rp
		where rp.id = (select value->>'id' from system_setting where key = 'default_routing_policy')`,
	).Scan(&wantID, &wantMax); err != nil {
		t.Fatalf("read the platform default policy: %v", err)
	}

	s, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	pol, err := s.RoutingPolicyFor(ctx, &store.APIKeyRow{})
	if err != nil {
		t.Fatalf("RoutingPolicyFor on an unscoped key: %v — the NULL scan is back", err)
	}
	if pol.ID != wantID {
		t.Errorf("policy id = %q, want %q", pol.ID, wantID)
	}
	if pol.MaxAttempts != wantMax {
		t.Errorf("max_attempts = %d, want the stored %d (the hardcoded default is %d — the stored row was ignored)",
			pol.MaxAttempts, wantMax, store.DefaultRoutingPolicy().MaxAttempts)
	}
}
