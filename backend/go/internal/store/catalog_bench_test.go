package store_test

// DB-gated benchmarks for model resolution (spec §5) — the first store call on
// every /v1/chat/completions request that names a model.
//
// Why they exist: ResolveModel issues its queries one after another, and every
// round trip sits directly on the request's critical path before any upstream
// byte moves. A benchmark is the only way to tell whether a query-count change
// actually bought anything, and on a loopback Postgres the per-round-trip cost
// is at least visible rather than rounded away.
//
// Skipped without DATABASE_URL, like every other store test — a benchmark that
// needs a live DSN cannot fail a developer's unit run.

import (
	"context"
	"os"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

func benchStore(b *testing.B, dsn string) *store.Store {
	b.Helper()
	s, err := store.New(context.Background(), dsn)
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(s.Close)
	return s
}

// The two dominant shapes a real traffic mix shows: a literal canonical slug
// (the SDK default) and a `[NAME]/*` virtual name (the marketing default).
func BenchmarkResolveModel(b *testing.B) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		b.Skip("DATABASE_URL not set; store benchmarks need a throwaway database")
	}
	env := tests.SeedEnv(b, dsn, "http://127.0.0.1:1")
	ctx := context.Background()
	s := benchStore(b, dsn)
	key := &store.APIKeyRow{UserID: env.UserID}

	// Seed one account-scoped alias with two targets so the alias branch is
	// what the benchmark measures, not the fall-through.
	tests.SeedAlias(b, dsn, env, "bench-alias", []string{env.ModelID})

	cases := []struct {
		label string
		name  string
	}{
		{"literal-slug", env.Slug},
		{"alias", "bench-alias"},
		{"virtual", "fudrouter/auto"},
		{"unknown", "no-such-model-xyz"},
	}
	for _, c := range cases {
		b.Run(c.label, func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				if _, err := s.ResolveModel(ctx, key, c.name); err != nil && c.label != "unknown" {
					b.Fatal(err)
				}
			}
		})
	}
}

// Candidates is the second store call on a chat request, and it used to be two
// queries: the candidate rows, then a batched credential query for the same
// connections. The credentials now ride along in the candidate query, so this
// benchmark is what says whether the round trip actually left.
//
// Seeded with a multi-account pool (SeedEnvAccounts) on purpose: with one
// credential the batch query was nearly free and the win would be invisible.
func BenchmarkCandidates(b *testing.B) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		b.Skip("DATABASE_URL not set; store benchmarks need a throwaway database")
	}
	env := tests.SeedEnvAccounts(b, dsn, "http://127.0.0.1:1", []string{"tok-a", "tok-b", "tok-c"})
	ctx := context.Background()
	s := benchStore(b, dsn)

	b.Run("multi-account", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			cands, err := s.Candidates(ctx, env.ModelID, nil)
			if err != nil {
				b.Fatal(err)
			}
			if len(cands) == 0 {
				b.Fatal("no candidates")
			}
			// The pool order is part of the contract this rewrite could break:
			// the credentials must come back priority-ordered, because Pick
			// round-robins from the front.
			for _, c := range cands {
				for i := 1; i < len(c.Credentials); i++ {
					if c.Credentials[i-1].Priority > c.Credentials[i].Priority {
						b.Fatalf("credentials out of priority order: %d then %d",
							c.Credentials[i-1].Priority, c.Credentials[i].Priority)
					}
				}
			}
		}
	})
}
