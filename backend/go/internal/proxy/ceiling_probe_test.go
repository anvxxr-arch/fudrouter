package proxy_test

// Throwaway probe: where does the router actually saturate, measured against
// the platform ceiling the deployment promises (150 rps / 400 concurrent)?
//
// The existing TestLoadSustained tops out at 128 workers and its rps numbers
// are noisy because the box is shared. This walks concurrency up to and past
// the configured ceiling and reports the shape, so the next change is chosen
// from a measurement rather than a guess.
//
// Gated: FUDROUTER_CEILING_PROBE=1.

import (
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

func TestCeilingProbe(t *testing.T) {
	if os.Getenv("FUDROUTER_CEILING_PROBE") == "" {
		t.Skip("set FUDROUTER_CEILING_PROBE=1 to run the ceiling probe")
	}
	dsn := tests.RequireDB(t)
	up := loadUpstream(t)
	env := tests.SeedEnv(t, dsn, up.URL)

	// Only the POOL may see pool_max_conns: pgxpool.ParseConfig deletes it from
	// RuntimeParams, so the pool's connections never send it to Postgres, while
	// a bare pgx.Connect (SeedEnv, RequestLogCount) would FATAL on it.
	poolDSN := dsn
	if n := os.Getenv("FUDROUTER_PROBE_POOL"); n != "" {
		sep := "?"
		if strings.Contains(dsn, "?") {
			sep = "&"
		}
		poolDSN = dsn + sep + "pool_max_conns=" + n
	}
	h := tests.NewProxy(t, poolDSN, up.URL)
	newReq := func() *http.Request { return newLoadRequest(t, env.Key, env.Slug) }

	// The platform ceiling is 9000 rpm / 150 rps / 400 concurrent. Seed the
	// account above it so the LIMITER is not what the probe measures - the
	// question is where the ROUTER saturates, not where it correctly refuses.
	seedAccountRateLimit(t, dsn, env.UserID, 1000000, 100000)

	for _, workers := range []int{1, 16, 64, 128, 256, 400} {
		warmUp(t, h, newReq, workers)
		base := tests.RequestLogCount(t, dsn, env.APIKeyID)
		total := 2000
		if workers >= 256 {
			total = 4000
		}
		res := runLoad(t, h, newReq, workers, total)

		// Drain: the ledger write runs after the client's 200.
		deadline := time.Now().Add(90 * time.Second)
		var logs int64
		for {
			logs = int64(tests.RequestLogCount(t, dsn, env.APIKeyID) - base)
			if logs >= res.ok || time.Now().After(deadline) {
				break
			}
			time.Sleep(250 * time.Millisecond)
		}
		t.Logf("PROBE workers=%d ok=%d ledger=%d lost=%d", workers, res.ok, logs, res.ok-logs)
	}
}
