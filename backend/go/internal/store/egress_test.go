package store_test

// The new policy must survive BOTH candidate queries: changing the schema alone
// leaves the default dispatch intact, and changing only the per-model path
// silently loses policy on the virtual-model batch path. Database constraints
// also protect the operator from a typo selecting a different egress identity.

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/egress"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

func TestConnectionEgressDefaultsAndCandidateQueries(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	s := tests.NewStore(t, dsn)
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	assertPolicy := func(wantMode string, wantTTL int, wantURL string) {
		t.Helper()
		single, err := s.Candidates(ctx, env.ModelID, nil)
		if err != nil {
			t.Fatal(err)
		}
		batch, err := s.CandidatesBatch(ctx, []string{env.ModelID}, nil)
		if err != nil {
			t.Fatal(err)
		}
		for _, rows := range [][]store.Candidate{single, batch[env.ModelID]} {
			if len(rows) != 1 {
				t.Fatalf("fixture has %d candidates, want 1", len(rows))
			}
			c := rows[0]
			if c.EgressMode != wantMode || c.StickyTTLSeconds != wantTTL || c.ProxyURL != wantURL {
				t.Fatalf("candidate egress=(%s,%d,%s), want (%s,%d,%s)", c.EgressMode, c.StickyTTLSeconds, c.ProxyURL, wantMode, wantTTL, wantURL)
			}
		}
	}
	assertPolicy(egress.IPv6Rotate, 3600, "")
	for _, mode := range []string{egress.Direct, egress.StickyOwn, egress.Pool} {
		var proxyURL *string
		url := ""
		if mode == egress.Pool {
			url = "socks5://127.0.0.1:3128"
			proxyURL = &url
		}
		if _, err := conn.Exec(ctx, `update connection set egress_mode=$2, sticky_ttl_seconds=900, proxy_url=$3 where id=$1`, env.ConnectionID, mode, proxyURL); err != nil {
			t.Fatal(err)
		}
		assertPolicy(mode, 900, url)
	}
}

func TestConnectionEgressConstraints(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	for _, clause := range []string{
		"egress_mode='typo'", "sticky_ttl_seconds=0", "sticky_ttl_seconds=86401",
		"proxy_url='http://127.0.0.1:3128'",
		"egress_mode='pool', proxy_url='http://user:password@127.0.0.1:3128'",
	} {
		_, err := conn.Exec(ctx, `update connection set `+clause+` where id=$1`, env.ConnectionID)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "23514" {
			t.Errorf("constraint did not reject %s: %v", clause, err)
		}
	}
}
