package proxy_test

// The finish() write path serializes every concurrent request for one account,
// and this measures by how much.
//
// Why this file exists: ChargeRequest takes `select ... from billing_account for
// update` and holds that row lock for its whole six-round-trip transaction
// (BEGIN, request_log insert, the locking select, credit_ledger insert, balance
// update, COMMIT). Nothing else in the request path is shared per-account, so
// the experiment holds concurrency FIXED and varies only whether the workers
// share an account.
//
// Measured on this box, 12 workers x 10 requests, BEFORE the charge block was
// folded into one statement:
//
//	one  account: p50=89ms   p99=2.07s  43 rps
//	12   accounts: p50=59ms  p99=221ms  152 rps
//
// The throughput gap between the two rows is the lock: same concurrency, same
// code, the only difference being how many accounts the workers contend on.
//
// AFTER — the block is one statement, so the lock is held for the tail of one
// round trip instead of five:
//
//	one  account: p50=22.6ms p99=78ms   422 rps
//	12   accounts: p50=20.3ms p99=100ms  439 rps
//
// READ THE TIMINGS WITH SUSPICION. Repeated runs of this test on this box have
// produced 43, 46, 52, 200, 229 and 422 rps for the SAME code — a spread of ~10x
// — so neither a multiple nor an absolute rps here is a defensible claim. What
// IS reproducible is the structural change, and that is what the other two tests
// pin by COUNT rather than by clock:
//
//	TestWritePathRoundTrips: ChargeRequest 6 round trips -> 1
//	TestFullRequestRoundTrips: one chat request 14 round trips -> 10
//
// and the lock hold, which is what the two rows above differ by, went from five
// round trips to at most one. Treat the numbers in this file as a way to see the
// SHAPE (whether one-account trails many-accounts) and not as a measurement
// of capacity. A real capacity number needs a quiet box and a real Postgres.
//
// Gated: it is a load measurement, so it runs under the same switch as the rest
// of the load harness.

import (
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/proxy"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

func TestWritePathSerializesOneAccount(t *testing.T) {
	if os.Getenv("FUDROUTER_LOAD_TESTS") == "" {
		t.Skip("set FUDROUTER_LOAD_TESTS=1 to run the write-path contention measurement")
	}
	dsn := tests.RequireDB(t)
	up := loadUpstream(t)

	// A sweep, not a single number: the shape of the curve says WHERE the
	// bottleneck is. Per-account locking shows as one-account falling behind
	// many-accounts; a bottleneck global to the process (the pool, the upstream
	// stub, the box) shows as BOTH curves bending at the same worker count.
	for _, workers := range []int{1, 2, 4, 8, 12} {
		const perWorker = 10
		t.Run("spread", func(t *testing.T) {
			h := tests.NewProxy(t, dsn, up.URL)
			reqs := make([]func() *http.Request, workers)
			for i := range workers {
				env := tests.SeedEnv(t, dsn, up.URL)
				key, slug := env.Key, env.Slug
				reqs[i] = func() *http.Request { return newLoadRequest(t, key, slug) }
			}
			for _, r := range reqs {
				warmUp(t, h, r, 1)
			}
			runSpread(t, h, reqs, perWorker)
		})
		t.Run("shared", func(t *testing.T) {
			env := tests.SeedEnv(t, dsn, up.URL)
			h := tests.NewProxy(t, dsn, up.URL)
			newReq := func() *http.Request { return newLoadRequest(t, env.Key, env.Slug) }
			warmUp(t, h, newReq, workers)
			runLoad(t, h, newReq, workers, workers*perWorker)
		})
	}
}

// runSpread drives one request builder PER WORKER, so a fixed worker count can
// be compared with and without a shared account.
func runSpread(t testing.TB, h *proxy.Handler, reqs []func() *http.Request, perWorker int) {
	t.Helper()
	var wg sync.WaitGroup
	lat := make([][]time.Duration, len(reqs))
	start := time.Now()
	for i, mk := range reqs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range perWorker {
				rec := httptest.NewRecorder()
				t0 := time.Now()
				h.ServeCompletions(rec, mk())
				lat[i] = append(lat[i], time.Since(t0))
			}
		}()
	}
	wg.Wait()
	total := len(reqs) * perWorker
	el := time.Since(start)
	all := make([]time.Duration, 0, total)
	for _, l := range lat {
		all = append(all, l...)
	}
	sort.Slice(all, func(a, b int) bool { return all[a] < all[b] })
	t.Logf("spread: %d workers across %d accounts, %d requests in %v = %.0f rps",
		len(reqs), len(reqs), total, el.Round(time.Millisecond), float64(total)/el.Seconds())
	t.Logf("spread: p50=%v p95=%v p99=%v", pct(all, 50), pct(all, 95), pct(all, 99))
}
