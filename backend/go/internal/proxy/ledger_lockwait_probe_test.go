package proxy_test

// Deterministic reproduction of the served-but-unbilled loss.
//
// TestLoadLedgerSurvivesPoolOversubscription only reproduces the loss when the
// pool queue is deep enough, and queue depth depends on machine load: the same
// commit measured 0/2000, 2/2000, 5/2000 and 6/2000 lost across four runs. A
// gate that reads green because the box was fast is worse than no gate.
//
// This test makes the same condition deterministic. finish() gives the primary
// charge ledgerWriteBudget (5s) and each fallback attempt ledgerWriteRetryBudget
// (1s), bounded in total by ledgerWriteDeadline (5 min) and in concurrency by
// the handler's writer cap (pool/fraction). Holding the billing_account row lock
// longer than the old code's total budget (5s + 3x5s + 750ms of backoff =
// 20.75s) reproduces exactly what a saturated pool does: every write for the
// account queues behind the lock, each budget expires, and the request is
// answered 200 with neither request_log nor usage_charge written.
//
// The lock is the mechanism, not a proxy for it: ChargeRequest's final CTE arm
// is `update billing_account ... from ledger`, so a concurrent FOR UPDATE on
// the same row blocks the whole statement. Both rows are in that statement, so
// both roll back together — which is why the production symptom is the two
// tables short by the SAME count.
//
// Runs in ~30s and needs a throwaway DATABASE_URL like every DB-backed test.

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
	"github.com/jackc/pgx/v5"
)

// lockHold must exceed the fallback's TOTAL budget (primary 5s + 3 x 5s +
// 750ms of backoff = 20.75s) and stay under whatever the fix allows, so the
// same test fails on the old code and passes on the new one.
const lockHold = 24 * time.Second

func TestLedgerWriteSurvivesLongLockWait(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := loadUpstream(t)
	env := tests.SeedEnv(t, dsn, up.URL)
	h := tests.NewProxy(t, dsn, up.URL)
	newReq := func() *http.Request { return newLoadRequest(t, env.Key, env.Slug) }

	seedAccountRateLimit(t, dsn, env.UserID, 100000, 10000)
	warmUp(t, h, newReq, 2)

	baseLogs := tests.RequestLogCount(t, dsn, env.APIKeyID)

	ctx := context.Background()
	lockConn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("lock connection: %v", err)
	}
	defer lockConn.Close(context.Background())

	tx, err := lockConn.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	var accountID string
	if err := tx.QueryRow(ctx,
		`select id from billing_account where user_id = $1 for update`,
		env.UserID).Scan(&accountID); err != nil {
		t.Fatalf("lock billing_account: %v", err)
	}
	t.Logf("holding billing_account %s row lock for %v", accountID, lockHold)

	released := make(chan struct{})
	go func() {
		time.Sleep(lockHold)
		_ = tx.Rollback(context.Background())
		close(released)
	}()

	t0 := time.Now()
	res := runLoad(t, h, newReq, 1, 1)
	if res.ok != 1 {
		t.Fatalf("%d of 1 request succeeded", res.ok)
	}
	t.Logf("request answered in %v (primary charge budget is %v)", time.Since(t0), 5*time.Second)

	<-released
	t.Logf("row lock released at %v", time.Since(t0))

	// The fallback write is detached from the request goroutine, so poll rather
	// than reading once and racing it.
	deadline := time.Now().Add(60 * time.Second)
	var logs int
	for {
		logs = tests.RequestLogCount(t, dsn, env.APIKeyID) - baseLogs
		if logs >= 1 || time.Now().After(deadline) {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	if logs != 1 {
		t.Fatalf("request_log grew by %d, want 1 — the request was answered 200 and never billed "+
			"(the write budget expired while the account row was locked)", logs)
	}
	t.Logf("recovered: ledger row landed at %v", time.Since(t0))
}
