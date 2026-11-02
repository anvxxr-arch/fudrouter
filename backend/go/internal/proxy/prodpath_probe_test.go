package proxy_test

// Throwaway probe: measure the request path with the REAL Valkey cache wired,
// which is what production runs.
//
// Every other load test in this package uses tests.NewProxy, which deliberately
// passes vk.Disabled() so tests never share a live cache. That makes those
// numbers the UNCACHED worst case: auth, routing policy and prompt injections
// all fall through to Postgres on every request. Production has Valkey, so the
// real path is shorter — this probe measures that one.
//
// Gated: FUDROUTER_PRODPATH_PROBE=1.

import (
	"context"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/crypt"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/proxy"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/vk"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

func TestProdPathProbe(t *testing.T) {
	if os.Getenv("FUDROUTER_PRODPATH_PROBE") == "" {
		t.Skip("set FUDROUTER_PRODPATH_PROBE=1 to run the production-path probe")
	}
	dsn := tests.RequireDB(t)
	up := loadUpstream(t)
	env := tests.SeedEnv(t, dsn, up.URL)

	// The real cache, from the same env var the router reads.
	vc, err := vk.NewFromEnv()
	if err != nil {
		t.Fatalf("valkey: %v", err)
	}
	if _, ok := vc.(interface{ CacheStats() vk.CacheStats }); !ok {
		t.Fatal("no cache stats")
	}

	ctx := context.Background()
	st, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	cr, err := crypt.New(os.Getenv("CREDENTIALS_MASTER_KEY"))
	if err != nil {
		t.Fatal(err)
	}

	poolDSN := dsn
	if n := os.Getenv("FUDROUTER_PROBE_POOL"); n != "" {
		sep := "?"
		if strings.Contains(dsn, "?") {
			sep = "&"
		}
		poolDSN = dsn + sep + "pool_max_conns=" + n
	}
	st2, err := store.New(ctx, poolDSN)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st2.Close)

	h := proxy.New(st2, cr, &http.Client{Timeout: 30 * time.Second}, nil, vc)
	newReq := func() *http.Request { return newLoadRequest(t, env.Key, env.Slug) }
	seedAccountRateLimit(t, dsn, env.UserID, 1000000, 100000)

	for _, workers := range []int{1, 64, 128, 400} {
		warmUp(t, h, newReq, workers)
		base := tests.RequestLogCount(t, dsn, env.APIKeyID)
		total := 2000
		if workers >= 400 {
			total = 4000
		}
		res := runLoad(t, h, newReq, workers, total)

		deadline := time.Now().Add(90 * time.Second)
		var logs int64
		for {
			logs = int64(tests.RequestLogCount(t, dsn, env.APIKeyID) - base)
			if logs >= res.ok || time.Now().After(deadline) {
				break
			}
			time.Sleep(250 * time.Millisecond)
		}
		cs := vc.CacheStats()
		t.Logf("PROBE workers=%d ok=%d ledger=%d lost=%d hitrate=%.2f",
			workers, res.ok, logs, res.ok-logs, cs.HitRate())
	}
}
