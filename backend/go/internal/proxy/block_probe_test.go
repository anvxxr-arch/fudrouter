package proxy_test

// Throwaway probe: capture a block profile at the configured ceiling (400
// concurrent) so the serialization point is named by the runtime, not guessed.
//
// Gated: FUDROUTER_BLOCK_PROBE=1.

import (
	"net/http"
	"os"
	"runtime"
	"runtime/pprof"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

func TestBlockProbe(t *testing.T) {
	if os.Getenv("FUDROUTER_BLOCK_PROBE") == "" {
		t.Skip("set FUDROUTER_BLOCK_PROBE=1 to run the block probe")
	}
	dsn := tests.RequireDB(t)
	up := loadUpstream(t)
	env := tests.SeedEnv(t, dsn, up.URL)
	h := tests.NewProxy(t, dsn, up.URL)
	newReq := func() *http.Request { return newLoadRequest(t, env.Key, env.Slug) }
	seedAccountRateLimit(t, dsn, env.UserID, 1000000, 100000)

	const workers = 400
	warmUp(t, h, newReq, workers)

	runtime.SetBlockProfileRate(10000) // sample 1 in 10k ns of blocking
	f, err := os.Create("/tmp/block.prof")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	res := runLoad(t, h, newReq, workers, 4000)
	t.Logf("PROBE ok=%d", res.ok)

	time.Sleep(500 * time.Millisecond)
	if err := pprof.Lookup("block").WriteTo(f, 0); err != nil {
		t.Fatal(err)
	}
}
