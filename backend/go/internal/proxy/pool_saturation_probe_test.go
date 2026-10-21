package proxy_test

// Pool-saturation probe for the billing ledger's recovery path.
//
// lifecycle.finish() (backend/go/internal/proxy/lifecycle.go:761-785) writes the
// ledger AFTER the 200 is already on the wire. When ChargeRequest fails it
// retries with a FRESH 5s context — the bug just fixed was that the fallback
// reused the expired primary context, which made the branch structurally dead.
//
// The open question this probe answers: when the pgx POOL is saturated, does
// that fresh context actually get a connection, or does it just re-queue behind
// the same saturation and lose the row anyway?
//
// The deterministic tests never reach the condition: lifecycle_fallback_test.go
// has no pool pressure, and TestLoadLedgerStaysExactlyOnce runs 12 workers
// against the default pool of 20 — headroom. This probe drives concurrency well
// ABOVE the pool size (pool 3 at 8x and 16x oversubscription) and measures
// whether rows are still lost.
//
// MEASUREMENT ONLY: nothing here asserts pass/fail beyond the HTTP status count.
// Gated behind FUDROUTER_POOL_PROBE so it never runs by default.

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
	"github.com/jackc/pgx/v5"
)

// probeLedgerBudget mirrors lifecycle.go:715 (ledgerWriteBudget = 5s). It is
// duplicated rather than imported because this is the external test package.
// The primary charge gets this budget; the fallback gets the same fresh budget,
// so a request that exhausts both has a 10s worst case before its row is lost.
const probeLedgerBudget = 5 * time.Second

// probeDefaultPoolConns mirrors store.go:168 (cfg.MaxConns = 20 when the DSN
// carries no pool_max_conns).
const probeDefaultPoolConns = 20

func TestPoolSaturationProbe(t *testing.T) {
	if os.Getenv("FUDROUTER_POOL_PROBE") == "" {
		t.Skip("set FUDROUTER_POOL_PROBE=1 to run the pool-saturation probe")
	}
	base := tests.RequireDB(t)

	// The recovery path reports its failures through the standard logger
	// (lifecycle.go:763,783). Count them per config and tee to stderr so -v
	// output still shows the lines. Safe to capture globally: this test is
	// gated and never runs alongside the rest of the package.
	cw := &probeLogCounter{}
	old := log.Writer()
	log.SetOutput(cw)
	defer log.SetOutput(old)

	configs := []probeConfig{
		// Control: the exact shape of TestLoadLedgerStaysExactlyOnce — 12
		// workers against the default pool of 20, i.e. headroom. It must read
		// rows==want, which validates the harness itself.
		{name: "baseline-default-pool", poolMax: 0, workers: 12, total: 120},
		// Saturation: 8x and 16x the pool size.
		{name: "pool3-workers24", poolMax: 3, workers: 24, total: 120},
		{name: "pool3-workers48", poolMax: 3, workers: 48, total: 120},
		// Harsher: 32x the pool size. If the failure mode exists on this box,
		// it has to appear here.
		{name: "pool2-workers64", poolMax: 2, workers: 64, total: 120},
	}
	for _, cfg := range configs {
		t.Run(cfg.name, func(t *testing.T) {
			runProbeConfig(t, base, cfg, cw)
		})
	}
}

type probeConfig struct {
	name    string
	poolMax int // 0 = leave the DSN alone (project default 20)
	workers int
	total   int
}

func runProbeConfig(t *testing.T, base string, cfg probeConfig, cw *probeLogCounter) {
	t.Helper()

	// Only the POOL may see pool_max_conns. pgxpool.ParseConfig reads it and
	// DELETES it from RuntimeParams (pgx v5.9.2 pgxpool/pool.go:372-381), so
	// the pool's own connections never send it to Postgres. A bare pgx.Connect
	// — which SeedEnv, RequestLogCount and ledgerRows all use — would forward
	// it as a startup parameter and FATAL, so every non-pool call keeps the
	// base DSN. Both DSNs name the same database, so the rows line up.
	poolDSN := base
	if cfg.poolMax > 0 {
		sep := "?"
		if strings.Contains(base, "?") {
			sep = "&"
		}
		poolDSN = fmt.Sprintf("%s%spool_max_conns=%d", base, sep, cfg.poolMax)
	}
	effectivePool := cfg.poolMax
	if effectivePool == 0 {
		effectivePool = probeDefaultPoolConns
	}

	up := loadUpstream(t)
	env := tests.SeedEnv(t, base, up.URL)

	// The probe's ledger deltas are only meaningful if ChargeRequest actually
	// reaches the ledger insert. store/billing.go:245-251 has an S0 arm: a
	// workspace with NO billing_account row returns ErrNoRows and the charge
	// answers `res, nil` with no ledger row — a seed problem would then read
	// as ledger loss (or mask a real one). Check the assumption instead of
	// trusting the seeder: the key must carry a workspace and that workspace
	// must have its billing_account row. Base DSN, not poolDSN: a bare
	// pgx.Connect would forward pool_max_conns as a startup parameter and
	// FATAL (see the poolDSN comment above).
	{
		ctx := context.Background()
		conn, err := pgx.Connect(ctx, base)
		if err != nil {
			t.Fatalf("probe precondition connect: %v", err)
		}
		defer conn.Close(ctx)
		var ws string
		if err := conn.QueryRow(ctx,
			`select workspace_id from api_key where id = $1`,
			env.APIKeyID).Scan(&ws); err != nil || ws == "" {
			t.Fatalf("probe precondition: seeded key has no workspace_id (%q, err=%v) — the S0 arm would bypass the ledger and the probe would misreport", ws, err)
		}
		var accounts int
		if err := conn.QueryRow(ctx,
			`select count(*) from billing_account where workspace_id = $1`,
			ws).Scan(&accounts); err != nil || accounts == 0 {
			t.Fatalf("probe precondition: workspace %s has no billing_account — ChargeRequest would take the S0 arm", ws)
		}
	}

	h := tests.NewProxy(t, poolDSN, up.URL)
	newReq := func() *http.Request { return newLoadRequest(t, env.Key, env.Slug) }

	// Warm at the worker count. With pool 3 this opens exactly 3 connections
	// and queues the rest — the saturation condition, established BEFORE the
	// measured window so connection setup never lands in the deltas.
	//
	// The warm-up is also where the coldest burst lands (every worker fires at
	// once against an unopened pool), so its failure counts are recorded
	// separately: attributing them to the measured window would be wrong.
	chargeWarm0, insertWarm0, attemptWarm0 := cw.snapshot()
	warmLogs0 := tests.RequestLogCount(t, base, env.APIKeyID)
	warmUp(t, h, newReq, cfg.workers)
	warmLogs1 := tests.RequestLogCount(t, base, env.APIKeyID)
	chargeWarm1, insertWarm1, attemptWarm1 := cw.snapshot()

	conns := probePoolConns(t, base)
	baseLogs := tests.RequestLogCount(t, base, env.APIKeyID)
	baseLedger, _ := ledgerRows(t, base, env)
	baseAttempts := probeAttemptCount(t, base, env)
	chargeBefore, insertBefore, attemptBefore := cw.snapshot()

	t0 := time.Now()
	res := runLoad(t, h, newReq, cfg.workers, cfg.total)
	elapsed := time.Since(t0)

	gotLogs := tests.RequestLogCount(t, base, env.APIKeyID) - baseLogs
	gotLedger, gotDistinct := ledgerRows(t, base, env)
	gotLedger -= baseLedger
	gotAttempts := probeAttemptCount(t, base, env) - baseAttempts
	chargeAfter, insertAfter, attemptAfter := cw.snapshot()

	p50 := pct(res.latencies, 50)
	p95 := pct(res.latencies, 95)
	p99 := pct(res.latencies, 99)
	pmax := pct(res.latencies, 100)

	t.Logf("PROBE-DETAIL pool=%d observed_conns=%d workers=%d requests=%d ok=%d rps=%.1f p50=%v p95=%v p99=%v max=%v",
		effectivePool, conns, cfg.workers, len(res.latencies), res.ok,
		float64(len(res.latencies))/elapsed.Seconds(), p50, p95, p99, pmax)
	t.Logf("PROBE-DELTA request_log=+%d usage_charge=+%d request_attempt=+%d (ledger total=%d distinct=%d)",
		gotLogs, gotLedger, gotAttempts, baseLedger+gotLedger, gotDistinct)
	t.Logf("PROBE-LOGS warmup(charge=%d insert=%d attempt=%d) measured(charge=%d insert=%d attempt=%d)",
		chargeWarm1-chargeWarm0, insertWarm1-insertWarm0, attemptWarm1-attemptWarm0,
		chargeAfter-chargeBefore, insertAfter-insertBefore, attemptAfter-attemptBefore)
	t.Logf("PROBE-BUDGET p99=%v primary=%v over_primary=%v primary+fallback=%v over_both=%v",
		p99, probeLedgerBudget, p99 > probeLedgerBudget,
		2*probeLedgerBudget, p99 > 2*probeLedgerBudget)
	// want is the 2xx count: the loss mode under study is a SUCCESSFUL response
	// whose ledger row was dropped. Non-2xx responses also write a request_log
	// row (lifecycle.go:509-510), so the delta line above carries the total.
	t.Logf("PROBE-WARMUP attempts=%d rows=+%d/%d lost=%d (charge=%d insert=%d attempt=%d)",
		cfg.workers*3, warmLogs1-warmLogs0, cfg.workers*3,
		cfg.workers*3-(warmLogs1-warmLogs0),
		chargeWarm1-chargeWarm0, insertWarm1-insertWarm0, attemptWarm1-attemptWarm0)
	t.Logf("PROBE pool=%d workers=%d rows=%d/%d lost=%d",
		effectivePool, cfg.workers, gotLogs, res.ok, int(res.ok)-gotLogs)
}

// probePoolConns counts live connections to the test database, excluding this
// connection's own backend. The seeder's connection is still open (its Close is
// a t.Cleanup), so the expected reading is pool size + 1.
func probePoolConns(t *testing.T, dsn string) int {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var n int
	if err := conn.QueryRow(ctx, `
		select count(*) from pg_stat_activity
		where datname = current_database() and pid <> pg_backend_pid()`).Scan(&n); err != nil {
		t.Fatalf("pg_stat_activity count: %v", err)
	}
	return n
}

// probeAttemptCount counts request_attempt rows belonging to this environment's
// requests (request_attempt.request_id is an FK to request_log.id).
func probeAttemptCount(t *testing.T, dsn string, env *tests.Env) int {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var n int
	if err := conn.QueryRow(ctx, `
		select count(*) from request_attempt ra
		join request_log rl on rl.id = ra.request_id
		where rl.api_key_id = $1`, env.APIKeyID).Scan(&n); err != nil {
		t.Fatalf("request_attempt count: %v", err)
	}
	return n
}

// probeLogCounter counts the recovery path's failure lines. The standard logger
// emits one Write per Printf, so per-Write substring matching is exact. The
// three lines are distinct: ChargeRequest failing (the fallback then runs),
// the request_log fallback failing (the row is actually lost), and the attempts
// insert failing (the forensic trail is lost).
type probeLogCounter struct {
	mu      sync.Mutex
	charge  int
	insert  int
	attempt int
}

func (w *probeLogCounter) Write(p []byte) (int, error) {
	s := string(p)
	w.mu.Lock()
	if strings.Contains(s, "charge failed") {
		w.charge++
	}
	if strings.Contains(s, "request_log insert failed") {
		w.insert++
	}
	if strings.Contains(s, "request_attempt insert failed") {
		w.attempt++
	}
	w.mu.Unlock()
	return os.Stderr.Write(p)
}

func (w *probeLogCounter) snapshot() (charge, insert, attempt int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.charge, w.insert, w.attempt
}
