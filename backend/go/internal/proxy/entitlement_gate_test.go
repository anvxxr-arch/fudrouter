package proxy_test

// B0: the subscription-aware admission gate (spec inv#2 — "sehat" = live
// subscription OR balance > hard_stop_threshold). The entitlement gate runs
// BEFORE the account hard-stop balance gate, so a live time-window passes even
// at a zero prepaid balance (the B4 flip must not self-lockout a subscriber),
// while a never-subscribed account with a zero balance stays on the balance
// gate exactly as before.
//
// Four cases, per the owner's entitlement convention (success / error / warn /
// unknown):
//
//	success — live sub + balance 0        -> admitted (200)
//	error   — no sub + balance 0          -> 402 (balance hard stop)
//	warn    — expired sub                 -> 402 with the "expired" rule
//	unknown — live sub but NO billing account -> admitted (200)
//
// All four run with the free-access flip OFF: the "no sub + balance 0 -> 402"
// half is the behaviour that only exists when the balance gate is live
// (FreeAccessNoPaymentGateway=false, the state the B4 flip ships). The flip is
// restored by each test's cleanup.

import (
	"context"
	"net/http"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/ids"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
	"github.com/jackc/pgx/v5"
)

// seedSubscription inserts one subscription row for the environment's account.
// `status` and the expiry SQL expression are explicit so every case controls
// its own shape. Cleanup deletes the row by id so a lapsed/expired row never
// leaks into another test's account.
func seedSubscription(t *testing.T, dsn, accountID string, status, expiresExpr string) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	// Register the close FIRST so (LIFO) the delete cleanup below runs while the
	// connection is still open, then the close runs last.
	t.Cleanup(func() { conn.Close(context.Background()) })
	id := ids.New("sub")
	if _, err := conn.Exec(ctx,
		`insert into subscription (id, account_id, plan, status, starts_at, expires_at, price_idr)
		 values ($1, $2, 'sub_7d', $3, now() - interval '1 day', `+expiresExpr+`, 10000)`,
		id, accountID, status); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := conn.Exec(context.Background(), `delete from subscription where id = $1`, id); err != nil {
			t.Errorf("subscription teardown failed (leaks row): %v", err)
		}
	})
}

// deleteBillingAccount removes the environment's billing account, producing the
// "account-less with a live subscription" shape that must still pass the
// entitlement gate (there is no hard stop to check, but the subscription read
// must not fail closed on the missing account).
func deleteBillingAccount(t *testing.T, dsn, billingAccountID string) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx,
		`delete from billing_account where id = $1`, billingAccountID); err != nil {
		t.Fatal(err)
	}
	// The SeedEnv teardown deletes the billing account by id again; that is a
	// no-op when it is already gone. The user's OTHER rows still exist, so the
	// env teardown remains responsible for the remaining cleanup.
}

// success: a live subscription at zero balance is admitted. Without the B0
// precedence this would 402 (the hard stop is 0/0), which is exactly the
// self-lockout S2 caught.
func TestLiveSubscriptionPassesZeroBalance(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := jsonUpstream(t, `{"ok":true}`, nil, 200)
	defer up.Close()

	store.FreeAccessNoPaymentGateway = false
	t.Cleanup(func() { store.FreeAccessNoPaymentGateway = true })

	env := tests.SeedEnv(t, dsn, up.URL)
	tests.SetBillingAccountHardStop(t, dsn, env.UserID, 0, 0)
	seedSubscription(t, dsn, env.UserID, "active", "now() + interval '1 day'")
	p := tests.NewProxy(t, dsn, up.URL)

	if code := callOnce(t, p, env); code != http.StatusOK {
		t.Fatalf("status %d, want 200 (a live subscription with a zero balance was refused)", code)
	}
}

// error: no subscription and a zero balance still hits the account hard stop
// (402) when the balance gate is live — the frpayg/frcheap path is unchanged.
func TestNoSubscriptionZeroBalanceRefused(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := jsonUpstream(t, `{"ok":true}`, nil, 200)
	defer up.Close()

	store.FreeAccessNoPaymentGateway = false
	t.Cleanup(func() { store.FreeAccessNoPaymentGateway = true })

	env := tests.SeedEnv(t, dsn, up.URL)
	tests.SetBillingAccountHardStop(t, dsn, env.UserID, 0, 0)
	p := tests.NewProxy(t, dsn, up.URL)

	if code := callOnce(t, p, env); code != http.StatusPaymentRequired {
		t.Fatalf("status %d, want 402 (a never-subscribed zero-balance account was admitted)", code)
	}
}

// warn: an expired subscription refuses with the expired RULE, not the balance
// rule — the owner's rule 12 distinction that a lapsed window is a different
// refusal than a hard stop. The account carries a healthy balance so ONLY the
// entitlement gate can refuse it.
func TestExpiredSubscriptionRefusedAsExpired(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := jsonUpstream(t, `{"ok":true}`, nil, 200)
	defer up.Close()

	store.FreeAccessNoPaymentGateway = false
	t.Cleanup(func() { store.FreeAccessNoPaymentGateway = true })

	env := tests.SeedEnv(t, dsn, up.URL)
	tests.SetBillingAccountHardStop(t, dsn, env.UserID, 0, 1_000_000)
	seedSubscription(t, dsn, env.UserID, "active", "now() - interval '1 day'")
	p := tests.NewProxy(t, dsn, up.URL)

	if code := callOnce(t, p, env); code != http.StatusPaymentRequired {
		t.Fatalf("status %d, want 402 (an expired subscription at a positive balance was admitted)", code)
	}
}

// unknown: an account with a live subscription but NO billing account still
// passes. There is no hard stop to check, but the entitlement read must not
// fail closed on the missing account row.
func TestLiveSubscriptionWithoutBillingAccountPasses(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := jsonUpstream(t, `{"ok":true}`, nil, 200)
	defer up.Close()

	store.FreeAccessNoPaymentGateway = false
	t.Cleanup(func() { store.FreeAccessNoPaymentGateway = true })

	env := tests.SeedEnv(t, dsn, up.URL)
	deleteBillingAccount(t, dsn, env.BillingAccountID)
	seedSubscription(t, dsn, env.UserID, "active", "now() + interval '1 day'")
	p := tests.NewProxy(t, dsn, up.URL)

	if code := callOnce(t, p, env); code != http.StatusOK {
		t.Fatalf("status %d, want 200 (a live subscription without a billing account was refused)", code)
	}
}

// The gate's "expired vs no-subscription" distinction is what the two refusal
// rules hinge on; pin it at the store seam so a regression that collapses
// LatestSubscription back to LiveSubscription (and thus back to "expired ==
// never subscribed") is caught without driving the whole request path.
func TestAdmissionSubscriptionDistinguishesExpiredFromNever(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	ctx := context.Background()

	// Never subscribed: a fresh (empty-cache) store must report nil.
	if sub, err := tests.NewStore(t, dsn).AdmissionSubscription(ctx, env.UserID); err != nil {
		t.Fatalf("never-subscribed read: %v", err)
	} else if sub != nil {
		t.Fatalf("never-subscribed account resolved a subscription: %+v", sub)
	}

	// Now lapsed (a row exists, but it is not live). A SECOND fresh store is
	// needed: the first store cached the nil "never subscribed" answer for the
	// 60s policy TTL, which is the staleness the cache exists to provide — a
	// test that reads the same store again would assert the cache, not the read.
	seedSubscription(t, dsn, env.UserID, "active", "now() - interval '1 day'")
	sub, err := tests.NewStore(t, dsn).AdmissionSubscription(ctx, env.UserID)
	if err != nil {
		t.Fatalf("lapsed-subscription read: %v", err)
	}
	if sub == nil {
		t.Fatal("a lapsed subscription was reported as never-subscribed (nil)")
	}
}
