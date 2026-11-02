package store_test

// Why this file exists: the sustained-load harness measures the ROUTER, and at
// 128 workers it collapses from 252 rps to 25 rps while logging "charge failed:
// context deadline exceeded". That log line names the symptom, not the cause.
//
// The candidate cause is connection acquisition: poolConfig defaults MaxConns
// to 20 (store.go:169) while the server allows 100, so 128 concurrent writers
// queue 108-deep for a connection and blow the 5s ledgerWriteBudget waiting.
//
// This test isolates that variable. It drives the SAME single-statement write
// ChargeRequest uses, at the same concurrency, against two pools that differ
// only in MaxConns. If the pool is the binding constraint, throughput rises
// with MaxConns and the timeout count falls; if the database itself is the
// constraint, both stay flat and the fix is elsewhere.
//
// It is a measurement, not an assertion of a floor: the absolute numbers are a
// property of this 4-core box, not of the code. What it establishes is the
// SHAPE — whether the ceiling moves when the pool does.

import (
	"context"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// poolProbeDSN returns the throwaway DSN, or skips. It deliberately does NOT
// reuse tests.RequireDB: that helper refuses the app database and skips in CI,
// and this probe is opt-in like the load harness it explains.
func poolProbeDSN(t *testing.T) string {
	t.Helper()
	if os.Getenv("FUDROUTER_POOL_PROBE") == "" {
		t.Skip("set FUDROUTER_POOL_PROBE=1 to run the pool saturation probe")
	}
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set")
	}
	return dsn
}

// probeWrite is the shape ChargeRequest reduces to: one statement, one round
// trip, no explicit transaction. A pool that cannot serve this cannot serve the
// real charge either.
const probeWrite = `
	insert into request_log (id, user_id, status, created_at)
	values ($1, null, 'probe', now())
	on conflict (id) do nothing`

// runProbe drives `workers` goroutines each doing `per` writes and reports
// throughput plus how many blew the budget.
func runProbe(t *testing.T, dsn string, maxConns, workers, per int) (rps float64, timeouts int64) {
	t.Helper()
	ctx := context.Background()

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	cfg.MaxConns = int32(maxConns)
	cfg.MinConns = 2
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()

	// Warm the pool so connection ESTABLISHMENT is not measured as write cost.
	warm := make([]*pgxpool.Conn, 0, maxConns)
	for i := 0; i < maxConns; i++ {
		c, err := pool.Acquire(ctx)
		if err != nil {
			break
		}
		warm = append(warm, c)
	}
	for _, c := range warm {
		c.Release()
	}

	var done, failed atomic.Int64
	start := time.Now()
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < per; i++ {
				// The real budget is ledgerWriteBudget (5s). A write that
				// cannot get a connection inside it is the failure the load
				// harness logs.
				wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
				id := fmt.Sprintf("probe_%d_%d_%d", maxConns, w, i)
				_, err := pool.Exec(wctx, probeWrite, id)
				cancel()
				if err != nil {
					failed.Add(1)
					continue
				}
				done.Add(1)
			}
		}(w)
	}
	wg.Wait()
	elapsed := time.Since(start)

	// Clean up so repeated runs do not grow the table.
	_, _ = pool.Exec(ctx, `delete from request_log where status = 'probe'`)

	return float64(done.Load()) / elapsed.Seconds(), failed.Load()
}

// TestPoolSaturationIsTheCeiling pins the relationship between MaxConns and
// throughput at a fixed, high concurrency. The load harness collapses at 64+
// workers; this asks whether the pool is why.
func TestPoolSaturationIsTheCeiling(t *testing.T) {
	dsn := poolProbeDSN(t)

	const workers, per = 128, 20
	for _, maxConns := range []int{20, 40, 60, 90} {
		rps, failed := runProbe(t, dsn, maxConns, workers, per)
		t.Logf("pool=%2d workers=%d: %6.0f rps, %d/%d writes timed out",
			maxConns, workers, rps, failed, workers*per)
	}
}
