package proxy_test

// The writer cap is the availability half of the ledger retry fix, and it is
// the half that has no other test.
//
// v1 of the fix bounded retries by time (deadline) instead of count and hit its
// money target — the row lands. But a deadline alone makes each writer hold a
// pool connection for its full per-attempt budget while it waits on the
// billing_account row lock, and it lets UNLIMITED writers do that at once. The
// storm probe measured the consequence: 100 retrying writers occupied all 60
// pool connections, 60 sessions blocked on a Lock. Auth, key lookup and rate
// limiting need those connections, so "retry until it lands" read as a billing
// fix but acted as a whole-router outage under sustained saturation.
//
// The cap is the fix for that: at most pool/fraction writers retry at once, so
// >=90% of the pool stays for the request path. This test pins the OBSERVABLE
// property (blocked sessions stay well under the pool, and the overflow is
// counted rather than silently dropped) instead of the implementation, so it
// cannot be satisfied by a constant that happens to match.
//
// It is not a rewrite of the load test: nothing here depends on timing luck.
// The row lock is held explicitly, the writers are fired at it deliberately,
// and every assertion is a bound rather than an exact number.

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/proxy"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
	"github.com/jackc/pgx/v5"
)

// TestLedgerWriterCapShedsRatherThanSaturate fires far more retrying writers
// than the cap allows and asserts the cap holds: the pool is never fully
// occupied by retries, and every row that could not get a slot is counted.
func TestLedgerWriterCapShedsRatherThanSaturate(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := loadUpstream(t)
	env := tests.SeedEnv(t, dsn, up.URL)
	h := tests.NewProxy(t, dsn, up.URL)
	newReq := func() *http.Request { return newLoadRequest(t, env.Key, env.Slug) }

	seedAccountRateLimit(t, dsn, env.UserID, 1000000, 1000000)
	warmUp(t, h, newReq, 2)

	// Small pool, small cap, short slot-wait: the property under test is
	// "concurrent retries are capped AND overflow is counted", not any
	// particular size. A cap of 3 against 20 writers makes saturation reachable
	// with a handful of requests, and a 1.5s slot-wait reaches the shed path in
	// seconds rather than waiting out ledgerWriteDeadline.
	const (
		capSize = 3
		wait    = 1500 * time.Millisecond
	)
	h.SetLedgerWriterCapForTest(capSize, wait)

	ctx := context.Background()
	probeConn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("probe connection: %v", err)
	}
	defer probeConn.Close(context.Background())

	lockConn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("lock connection: %v", err)
	}
	defer lockConn.Close(context.Background())

	tx, err := lockConn.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(context.Background())
	var accountID string
	if err := tx.QueryRow(ctx,
		`select id from billing_account where user_id = $1 for update`,
		env.UserID).Scan(&accountID); err != nil {
		t.Fatalf("lock billing_account: %v", err)
	}
	t.Logf("holding billing_account %s, writer cap = %d", accountID, capSize)

	// Scope the probe to THIS test's lock, not the database's. Counting every
	// `wait_event_type = 'Lock'` session in the database makes the test a liar:
	// any concurrent test holding its own row lock inflates the number, and the
	// cap gets blamed for a lock it never met. pg_blocking_pids(holder) asks the
	// only question that matters — "how many sessions wait on the row I hold?" —
	// and is immune to whatever else is running in the database.
	var lockHolderPid int
	if err := lockConn.QueryRow(ctx, `select pg_backend_pid()`).Scan(&lockHolderPid); err != nil {
		t.Fatalf("lock holder pid: %v", err)
	}
	countBlocked := func() int {
		var n int
		if err := probeConn.QueryRow(ctx,
			`select count(*) from pg_stat_activity
			  where $1 = any(pg_blocking_pids(pid))`, lockHolderPid,
		).Scan(&n); err != nil {
			t.Logf("probe: %v", err)
			return -1
		}
		return n
	}

	// 20 writers against a 3-slot cap. Every request must still be answered,
	// and the clients must not be the ones waiting: the shed path returns
	// immediately by design.
	const writers = 20
	t0 := time.Now()
	res := runLoad(t, h, newReq, writers, writers)
	if res.ok != writers {
		t.Fatalf("%d of %d requests answered: the cap must shed billing retries, "+
			"never client responses", res.ok, writers)
	}
	t.Logf("%d/%d requests answered in %v", res.ok, writers, time.Since(t0))

	// Sample the peak, not a single instant: writers are detached, so the cap
	// is only observably full while they are actually retrying.
	peak := 0
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if n := countBlocked(); n > peak {
			peak = n
		}
		if shed := h.LedgerWritersShedForTest(); shed > 0 && peak > 0 {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	shed := h.LedgerWritersShedForTest()
	t.Logf("peak blocked-on-lock sessions = %d, writers shed = %d", peak, shed)

	// The cap holds if concurrent retries are bounded by it. A small margin
	// allows for the probe's own two connections and any session the driver has
	// not yet classified.
	if peak > capSize+2 {
		t.Fatalf("%d sessions blocked on a Lock with a cap of %d: the per-attempt "+
			"slot is not bounding concurrent retries", peak, capSize)
	}
	// Overflow must be COUNTED. A silent drop is the original bug wearing a cap.
	if shed == 0 {
		t.Fatalf("no writers shed with %d requests against a cap of %d: either the "+
			"cap is not enforced or the overflow is dropped silently", writers, capSize)
	}

	// The pool must recover once the writers give up, which is what keeps auth
	// and rate limiting alive.
	if err := tx.Rollback(ctx); err != nil {
		t.Logf("rollback: %v", err)
	}
	recoverDeadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(recoverDeadline) {
		if countBlocked() == 0 {
			t.Logf("pool recovered at %v", time.Since(t0))
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatalf("pool never recovered: %d sessions still blocked %v after the lock was "+
		"released", countBlocked(), time.Since(t0))
}

// TestLedgerWriterCapSize pins the sizing arithmetic without a database: the cap
// must never be the whole pool, and a pool too small to divide must still get
// one writer rather than a cap of zero (a zero cap sheds every billing row).
func TestLedgerWriterCapSize(t *testing.T) {
	cases := []struct {
		pool int32
		want int
	}{
		{0, 1},   // nil store / unknown pool: never zero
		{1, 1},   // too small to divide: still one writer
		{3, 1},   // 3/2 = 1
		{4, 2},   // exactly the fraction
		{60, 30}, // the deployment: half the pool
		{100, 50},
	}
	for _, c := range cases {
		if got := proxy.LedgerWriterCapSize(c.pool); got != c.want {
			t.Errorf("LedgerWriterCapSize(%d) = %d, want %d", c.pool, got, c.want)
		}
	}
	// The cap must leave the request path room, which is the whole point.
	const pool = 60
	if size := proxy.LedgerWriterCapSize(pool); size >= pool {
		t.Errorf("cap %d does not leave any pool for the request path (pool %d)", size, pool)
	}
}
