package proxy_test

// Benchmark for the budget gate's READ path (spec §7, §10).
//
// This used to say the gate "touches Postgres on every single request", which is
// no longer true: the three reads admission makes (the billing account +
// account budget, the scoped budget rows, and the rate_limit chain) are served
// from the in-process cache in store/admission.go, and the account's is the only
// one that is not purely policy-cached. It is kept because it is the number the
// cache was built against: 525,393 ns/op before, 391 ns/op after
// (-benchtime=200000x on the i5-6500T on this box).
//
// A cache that stopped caching would NOT show up here: this loops the gate with one
// warm key, so it measures the hit path either way. The contract that catches it is
// a query count, not a duration — TestAdmissionReadsAreOneRoundTrip (WARM = 1,
// COLD = 5) and the three cases in admission_cache_test.go, which run through
// the CounterTracer seam.
//
// The gate's own correctness is pinned by budget_gate_test.go; this file only
// measures. It calls the real method through export_test.go's
// CheckBudgetsForTest, so it cannot drift into measuring a copy.

import (
	"os"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

func BenchmarkBudgetGate(b *testing.B) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		b.Skip("DATABASE_URL not set; the budget gate needs a throwaway database")
	}
	env := tests.SeedEnv(b, dsn, "http://127.0.0.1:1")
	p := tests.NewProxy(b, dsn, "http://127.0.0.1:1")
	st := tests.NewStore(b, dsn)
	key, err := st.LookupAPIKey(b.Context(), env.Prefix)
	if err != nil {
		b.Fatal(err)
	}

	// The default shape: an active account, no `budget` rows.
	//
	// The first call is OUTSIDE the timed loop: it fills the cache, so a timed
	// run measures the steady state rather than one cache miss amortised over
	// b.N. Without it the number moves with b.N (measured: 285µs at -benchtime=300x
	// vs 4.4µs at 2000x, same code).
	if err := p.CheckBudgetsForTest(b.Context(), key); err != nil {
		b.Fatal(err)
	}
	b.Run("no-budgets", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			if err := p.CheckBudgetsForTest(b.Context(), key); err != nil {
				b.Fatal(err)
			}
		}
	})
}
