package store_test

// The admission cache's contracts: a hit costs zero queries, the account entry
// expires on its TTL, and a hard-stop crossing drops the entry immediately.
//
// Why this file exists: checkBudgets read the billing account and the scoped
// budget rows from Postgres on EVERY request — 525µs per call measured
// (BenchmarkBudgetGate/no-budgets) against single-digit microseconds for
// everything else in admission. The cache removes that read, which means the
// three ways it can be WRONG are now the things worth testing:
//
//  1. a hit that still queries (the cache silently not caching — only visible as
//     a latency regression, never as a red test);
//  2. a suspended account still being admitted forever (the TTL is the bound,
//     so the TTL has to be observed expiring);
//  3. a balance that crossed the hard stop still being admitted from a stale
//     entry (the charge path drops the entry; that link is asserted, not
//     assumed).
//
// Each test drives the store's own seam rather than sleeping out the production
// TTLs (5s/60s).

import (
	"context"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

func TestAdmissionGateStateServesRepeatReadsFromCache(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	s, tr := startCounting(t, dsn)
	ctx := context.Background()

	// The first read fills the cache and is expected to query.
	if _, err := s.AdmissionGateState(ctx, env.UserID); err != nil {
		t.Fatalf("first AdmissionGateState: %v", err)
	}
	tr.Reset()
	for range 50 {
		acct, err := s.AdmissionGateState(ctx, env.UserID)
		if err != nil {
			t.Fatalf("cached AdmissionGateState: %v", err)
		}
		if acct == nil {
			t.Fatal("cached read lost the account")
		}
	}
	if got := tr.Count(); got != 0 {
		t.Errorf("50 cached reads issued %d queries, want 0: %v", got, tr.Texts())
	}
}

func TestAdmissionBudgetsServeRepeatReadsFromCache(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	s, tr := startCounting(t, dsn)
	ctx := context.Background()
	key, err := s.LookupAPIKey(ctx, env.Prefix)
	if err != nil {
		t.Fatalf("LookupAPIKey: %v", err)
	}

	if _, err := s.AdmissionBudgets(ctx, key); err != nil {
		t.Fatalf("first AdmissionBudgets: %v", err)
	}
	tr.Reset()
	for range 50 {
		if _, err := s.AdmissionBudgets(ctx, key); err != nil {
			t.Fatalf("cached AdmissionBudgets: %v", err)
		}
	}
	if got := tr.Count(); got != 0 {
		t.Errorf("50 cached budget reads issued %d queries, want 0: %v", got, tr.Texts())
	}
}

// The account TTL is what bounds how long a suspension or an exhausted balance
// can be served from stale memory, so the boundary has to be observable. The
// TTL is shortened through the test seam; the production value is gateTTL.
func TestAdmissionCacheExpiresTheAccountEntry(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	s, tr := startCounting(t, dsn)
	ctx := context.Background()
	s.SetAdmissionTTLForTest(time.Millisecond, time.Minute)

	if _, err := s.AdmissionGateState(ctx, env.UserID); err != nil {
		t.Fatalf("first read: %v", err)
	}
	tr.Reset()
	time.Sleep(5 * time.Millisecond)
	if _, err := s.AdmissionGateState(ctx, env.UserID); err != nil {
		t.Fatalf("read after expiry: %v", err)
	}
	if got := tr.Count(); got == 0 {
		t.Error("an expired account entry was served from cache; the TTL is not bounding staleness")
	}
}

// A suspension must not be invisible forever: with the TTL elapsed, the gate has
// to refuse. This is the assertion behind the documented bound — an operator
// flipping billing_account.status sees it take effect within one TTL.
func TestAdmissionRefusesSuspendedAccountAfterTTL(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	s, _ := startCounting(t, dsn)
	ctx := context.Background()
	s.SetAdmissionTTLForTest(time.Millisecond, time.Minute)

	if _, err := s.AdmissionGateState(ctx, env.UserID); err != nil {
		t.Fatalf("first read: %v", err)
	}
	tests.SetBillingAccountStatus(t, dsn, env.UserID, "suspended")
	time.Sleep(5 * time.Millisecond)

	acct, err := s.AdmissionGateState(ctx, env.UserID)
	if err != nil {
		t.Fatalf("read after suspension: %v", err)
	}
	if acct == nil || acct.Status != "suspended" {
		t.Fatalf("account after suspension = %+v, want status suspended", acct)
	}
}

// InvalidateAdmission is the link the charge path relies on: the moment a charge
// crosses the hard stop, the cached PRE-charge balance must stop being served.
func TestInvalidateAdmissionDropsTheAccountEntry(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	s, tr := startCounting(t, dsn)
	ctx := context.Background()

	if _, err := s.AdmissionGateState(ctx, env.UserID); err != nil {
		t.Fatalf("first read: %v", err)
	}
	tr.Reset()
	s.InvalidateAdmission(env.UserID)
	if _, err := s.AdmissionGateState(ctx, env.UserID); err != nil {
		t.Fatalf("read after invalidation: %v", err)
	}
	if got := tr.Count(); got == 0 {
		t.Error("reads after InvalidateAdmission were served from cache; the hard-stop refund path is blind")
	}
}

// The end-to-end version: charge the account past its hard stop and assert the
// very next gate read sees the new balance, without waiting out the TTL. This is
// the money path — the failure it prevents is admitting traffic on a balance
// that no longer exists.
func TestHardStopCrossingIsVisibleToTheNextGateRead(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	s, tr := startCounting(t, dsn)
	// The charge-path invalidation below rests behind the free-access flip:
	// while the gate is off, nothing reads the balance, so dropping the entry
	// would be a pure cache miss. This test pins the invalidation the paid tier
	// will rely on, so it runs with the flip OFF.
	store.FreeAccessNoPaymentGateway = false
	t.Cleanup(func() { store.FreeAccessNoPaymentGateway = true })
	ctx := context.Background()
	key, err := s.LookupAPIKey(ctx, env.Prefix)
	if err != nil {
		t.Fatalf("LookupAPIKey: %v", err)
	}

	// Balance 1000, hard stop 0: the cached account admits. Then charge enough to
	// put the balance AT the hard stop, which is the refusal condition
	// (balance <= hard_stop).
	tests.SetBillingAccountHardStop(t, dsn, env.UserID, 0, 1000)
	s.InvalidateAdmission(env.UserID)
	acct, err := s.AdmissionGateState(ctx, env.UserID)
	if err != nil {
		t.Fatalf("warm read: %v", err)
	}
	if acct == nil || acct.BalanceMicro != 1000 {
		t.Fatalf("warm account = %+v, want balance 1000", acct)
	}

	row := &store.RequestLog{
		ID: "rql_hardstop_visible", UserID: env.UserID, APIKeyID: key.ID, ModelID: env.ModelID,
		TokensIn: 1, TokensOut: 1, Cost: 1000, Currency: "USD", Status: "success",
	}
	res, err := s.ChargeRequest(ctx, row)
	if err != nil {
		t.Fatalf("ChargeRequest: %v", err)
	}
	if !res.HardStop {
		t.Fatalf("charge to the hard stop reported HardStop=false: %+v", res)
	}
	defer func() {
		if _, err := s.DeleteRequestLogForTest(ctx, row.ID); err != nil {
			t.Errorf("cleanup: %v", err)
		}
	}()

	tr.Reset()
	acct, err = s.AdmissionGateState(ctx, env.UserID)
	if err != nil {
		t.Fatalf("read after hard stop: %v", err)
	}
	if acct == nil {
		t.Fatal("account vanished")
	}
	if acct.BalanceMicro > acct.HardStopThresholdMicro {
		t.Errorf("gate still holds balance %d against hard stop %d — the charge path did not drop the entry",
			acct.BalanceMicro, acct.HardStopThresholdMicro)
	}
	if got := tr.Count(); got == 0 {
		t.Error("the post-hard-stop read was served from a stale cache entry")
	}
}
