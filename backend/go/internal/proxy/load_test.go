package proxy_test

// Sustained-load harness: throughput, latency percentiles and the LEDGER
// INVARIANT under concurrency.
//
// Why this file exists: every other test in this package asserts a single
// request's behaviour. The objective the router is built against is a rate —
// 100k rps and 3B tokens/day — and no test drove the real handler under
// concurrency, so nothing had ever checked the two things that only break at
// rate:
//
//  1. Exactly-once accounting. `usage_charge` is keyed `usage:<request id>` and
//     the ledger is the billing record; a race that double-writes or drops a row
//     under load is invisible at one request per test.
//  2. Where the ceiling actually is. A dev box cannot demonstrate 100k rps, but
//     it CAN show which stage binds first, which is what says whether the target
//     needs a bigger box or a different design.
//
// The upstream is a local stub answering instantly, so the numbers measure the
// ROUTER, not a provider. That is deliberate: the provider's latency is not the
// router's, and mixing them hides the router's own cost.
//
// Scale is gated: a smoke run by default, the sustained run under
// FUDROUTER_LOAD_TESTS=1 (the precedent is FUDROUTER_SLOW_POOL_TESTS). The
// correctness assertions run at BOTH scales — the invariant is the point, the
// perf numbers are the report.

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/proxy"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
	"github.com/jackc/pgx/v5"
)

// loadUpstream answers `/v1/chat/completions` with a minimal valid completion.
// It holds no state and allocates one small body, so it is not the bottleneck
// the measurement is looking for.
func loadUpstream(tb testing.TB) *httptest.Server {
	tb.Helper()
	const resp = `{"id":"c1","object":"chat.completion","choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(resp))
	}))
	tb.Cleanup(srv.Close)
	return srv
}

// loadBody is the exact body every request sends. It is a template, not a
// shared request: a *http.Request carries a one-shot body, so reusing one would
// hand the first caller the bytes and every later caller an empty body (measured:
// 119 of 120 requests answered 400 for a missing model).
const loadBodyTemplate = `{"model":%q,"messages":[{"role":"user","content":"hello there, count to three"}]}`

// newLoadRequest builds a request with its own body reader, so it is safe to
// call per request from any goroutine.
func newLoadRequest(tb testing.TB, key, model string) *http.Request {
	tb.Helper()
	body := fmt.Sprintf(loadBodyTemplate, model)
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	return req
}

// loadResult is one worker's share of the run.
type loadResult struct {
	latencies []time.Duration
	ok        int64
	statuses  map[int]int64
}

// runLoad drives `workers` goroutines for `total` requests against the real
// handler, each with its own recorder and its own request body, and returns the
// per-request latencies.
//
// The handler is the PRODUCTION object built by proxy.New: same auth, same
// admission, same upstream walk, same ledger write. Nothing here re-implements a
// stage, so a number this produces is the router's.
func runLoad(t testing.TB, h *proxy.Handler, newReq func() *http.Request, workers, total int) *loadResult {
	t.Helper()
	res := &loadResult{latencies: make([]time.Duration, 0, total), statuses: map[int]int64{}}
	var mu sync.Mutex
	var issued int64
	var wg sync.WaitGroup

	start := time.Now()
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				if atomic.AddInt64(&issued, 1) > int64(total) {
					return
				}
				// A fresh recorder AND body per request: sharing a request would
				// starve every caller after the first of its body bytes, and
				// sharing a recorder would make the measurement include the
				// harness's own lock.
				rec := httptest.NewRecorder()
				req := newReq()
				t0 := time.Now()
				h.ServeCompletions(rec, req)
				el := time.Since(t0)

				mu.Lock()
				res.latencies = append(res.latencies, el)
				res.statuses[rec.Code]++
				if rec.Code == http.StatusOK {
					res.ok++
				}
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	elapsed := time.Since(start)

	sort.Slice(res.latencies, func(i, j int) bool { return res.latencies[i] < res.latencies[j] })
	t.Logf("load: %d workers, %d requests in %v = %.0f rps",
		workers, total, elapsed.Round(time.Millisecond), float64(total)/elapsed.Seconds())
	t.Logf("load: p50=%v p95=%v p99=%v max=%v",
		pct(res.latencies, 50), pct(res.latencies, 95), pct(res.latencies, 99), pct(res.latencies, 100))
	keys := make([]int, 0, len(res.statuses))
	for k := range res.statuses {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	for _, k := range keys {
		t.Logf("load: status %d x%d", k, res.statuses[k])
	}
	return res
}

func pct(sorted []time.Duration, p int) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	i := (p * len(sorted)) / 100
	if i >= len(sorted) {
		i = len(sorted) - 1
	}
	return sorted[i]
}

// warmUp drives a small number of requests through the handler so the pool,
// pgx's statement descriptions and the in-process hard-limit cache are all
// populated before the measured run. Nothing about those first requests is a
// property of the router's steady state, and leaving them in moves p99 by an
// order of magnitude.
//
// It runs CONCURRENTLY on purpose. A sequential warm-up opens exactly one
// connection, so the measured run then pays to establish the rest — measured as
// `pgxpool.Acquire` + `initResourceValue` blocking for 286ms across 120 requests
// (2.4ms per request) in the block profile, with the pool's MinConns default of
// 2. Warming at the worker count pre-opens the connections the run will use.
func warmUp(t testing.TB, h *proxy.Handler, newReq func() *http.Request, workers int) {
	t.Helper()
	if workers < 1 {
		workers = 1
	}
	perWorker := 3
	var wg sync.WaitGroup
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range perWorker {
				rec := httptest.NewRecorder()
				h.ServeCompletions(rec, newReq())
			}
		}()
	}
	wg.Wait()
}

// TestLoadLedgerStaysExactlyOnce is the invariant half of the harness: under
// concurrency every successful response must leave exactly ONE request_log row
// and ONE usage_charge row. A double-write bills twice; a dropped write bills
// nothing. Both are invisible at one request per test and both are money.
func TestLoadLedgerStaysExactlyOnce(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := loadUpstream(t)
	env := tests.SeedEnv(t, dsn, up.URL)
	h := tests.NewProxy(t, dsn, up.URL)
	newReq := func() *http.Request { return newLoadRequest(t, env.Key, env.Slug) }

	const total = 120
	const workers = 12
	// The pool and the statement cache warm here, BEFORE the delta baseline: the
	// first requests on a fresh handler pay connection setup (~50ms, measured),
	// which is not a property of the router under load and must not land in the
	// measured window or the ledger delta.
	warmUp(t, h, newReq, workers)

	// The warm-up writes its own ledger rows, so the assertion is on the DELTA:
	// counting every row in the database would measure the harness's warm-up too.
	baseLogs := tests.RequestLogCount(t, dsn, env.APIKeyID)
	baseLedger, _ := ledgerRows(t, dsn, env)

	res := runLoad(t, h, newReq, workers, total)

	if res.ok != total {
		t.Fatalf("%d of %d requests succeeded", res.ok, total)
	}
	if got := tests.RequestLogCount(t, dsn, env.APIKeyID) - baseLogs; got != total {
		t.Errorf("request_log grew by %d, want exactly %d — a race duplicated or dropped a ledger row", got, total)
	}
	gotRows, gotDistinct := ledgerRows(t, dsn, env)
	if rows := gotRows - baseLedger; rows != total {
		t.Errorf("usage_charge grew by %d, want exactly %d — a race duplicated or dropped a ledger row", rows, total)
	}
	if gotDistinct != gotRows {
		t.Errorf("usage_charge idempotency keys = %d distinct for %d rows — a key collided", gotDistinct, gotRows)
	}
}

// TestLoadSustained is the throughput half: the same harness at a scale that
// takes long enough for the numbers to mean something.
//
// It reports rather than asserts a floor, because a dev box's absolute rps is
// not a property of the code — the box here is a 4-core i5-6500T. What it DOES
// establish is the shape: which stage saturates first, and whether the per-
// request cost stays flat as concurrency rises.
func TestLoadSustained(t *testing.T) {
	if os.Getenv("FUDROUTER_LOAD_TESTS") == "" {
		t.Skip("set FUDROUTER_LOAD_TESTS=1 to run the sustained load measurement")
	}
	dsn := tests.RequireDB(t)
	up := loadUpstream(t)
	env := tests.SeedEnv(t, dsn, up.URL)
	h := tests.NewProxy(t, dsn, up.URL)
	newReq := func() *http.Request { return newLoadRequest(t, env.Key, env.Slug) }
	warmUp(t, h, newReq, 8)

	// Sweep concurrency: a single number hides the knee, and the knee is where
	// the design decision lives.
	for _, workers := range []int{1, 4, 16, 64, 128} {
		const total = 2000
		baseLogs := tests.RequestLogCount(t, dsn, env.APIKeyID)
		baseLedger, _ := ledgerRows(t, dsn, env)
		res := runLoad(t, h, newReq, workers, total)
		if res.ok != total {
			t.Errorf("workers=%d: %d of %d succeeded", workers, res.ok, total)
		}
		if got := tests.RequestLogCount(t, dsn, env.APIKeyID) - baseLogs; got != total {
			t.Errorf("workers=%d: request_log grew by %d, want %d", workers, got, total)
		}
		if rows, distinct := ledgerRows(t, dsn, env); rows-baseLedger != total || distinct != rows {
			t.Errorf("workers=%d: ledger delta %d (want %d), %d distinct keys for %d rows",
				workers, rows-baseLedger, total, distinct, rows)
		}
	}
}

// ledgerRows returns the usage_charge row count and the number of DISTINCT
// idempotency keys for this account's billing account.
//
// Two numbers, not one, because they fail differently: a count that grew too far
// means a double-write, and distinct < rows means the `usage:<request id>` key —
// the ledger's exactly-once mechanism (spec §10) — stopped being unique.
func ledgerRows(t *testing.T, dsn string, env *tests.Env) (rows, distinct int) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	err = conn.QueryRow(ctx, `
		select count(*), count(distinct idempotency_key) from credit_ledger
		where billing_account_id = $1 and type = 'usage_charge'`,
		env.BillingAccountID).Scan(&rows, &distinct)
	if err != nil {
		t.Fatalf("credit_ledger count: %v", err)
	}
	return rows, distinct
}
