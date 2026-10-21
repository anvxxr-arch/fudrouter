package proxy_test

// The budget gate at admission (spec §7, §10). These cases went untested end to
// end, and each one decides whether a request is served or refused:
//
//   - the billing hard stop (spec §10) — 402 INSUFFICIENT_CREDITS when the
//     account sits at/under its threshold. The seeded account carries the
//     migration defaults (threshold 0, balance 0, status 'active'); nothing set
//     a NON-default threshold, so the reject branch had no coverage.
//   - a suspended account, which must be refused independently of its balance.
//   - the account's flat `budget` row (spec §2, §7), which checkBudgets folds
//     into the chain as a monthly budget with default thresholds.
//
// checkBudgets is the gate, not the counter: it READS (BudgetGateState,
// BudgetsFor, SpendMicro) and must never write, so a regression that moved
// charging into admission — the ledger's exactly-once property lives in
// ChargeRequest's transaction — would surface here as an unexpected upstream
// call rather than only in production.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/ids"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/proxy"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
	"github.com/jackc/pgx/v5"
)

// callOnce drives one /v1/embeddings request through the full lifecycle and
// returns the status the client would see.
func callOnce(t *testing.T, p *proxy.Handler, env *tests.Env) int {
	t.Helper()
	rec := httptest.NewRecorder()
	body := `{"model":"` + env.Slug + `","input":"hi"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/embeddings", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeGeneric(rec, req)
	return rec.Code
}

// An account at or under its hard stop must be refused before any upstream call
// is made (spec §10). The proxy wrapper counts upstream hits, so "refused at
// admission" is proven by the upstream never being reached — a 402 alone would
// also be consistent with a failure after dispatch.
func TestBillingHardStopRefusesAtAdmission(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := jsonUpstream(t, `{"ok":true}`, nil, 200)
	defer up.Close()
	hits := 0
	counting := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		up.Config.Handler.ServeHTTP(w, r)
	}))
	defer counting.Close()

	env := tests.SeedEnv(t, dsn, counting.URL)
	// Balance exactly AT the hard stop is the boundary the spec calls out
	// ("at or under"): 500 / 500 must refuse, not admit.
	tests.SetBillingAccountHardStop(t, dsn, env.UserID, 500, 500)
	p := tests.NewProxy(t, dsn, counting.URL)

	if code := callOnce(t, p, env); code != http.StatusPaymentRequired {
		t.Fatalf("status %d, want 402 (balance at the hard stop was admitted)", code)
	}
	if hits != 0 {
		t.Errorf("upstream was reached %d time(s) — the hard stop must refuse at admission", hits)
	}

	// One micro above the stop admits. This is the other half of the bound: a
	// gate that refused everything would also satisfy the assertion above.
	tests.SetBillingAccountHardStop(t, dsn, env.UserID, 500, 501)
	if code := callOnce(t, p, env); code != http.StatusOK {
		t.Fatalf("status %d, want 200 (balance above the hard stop was refused)", code)
	}
	if hits != 1 {
		t.Errorf("upstream hits = %d, want 1", hits)
	}
}

// A non-active billing account must be refused regardless of balance: a
// suspended account with money on it is still not allowed to spend (spec §10).
func TestSuspendedBillingAccountRefused(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := jsonUpstream(t, `{"ok":true}`, nil, 200)
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL)
	tests.SetBillingAccountStatus(t, dsn, env.UserID, "suspended")
	tests.SetBillingAccountHardStop(t, dsn, env.UserID, 0, 1_000_000)
	p := tests.NewProxy(t, dsn, up.URL)

	if code := callOnce(t, p, env); code != http.StatusPaymentRequired {
		t.Fatalf("status %d, want 402 (suspended account with a positive balance was admitted)", code)
	}
}

// The account's flat `budget` row is a budget with default thresholds, and
// reaching it refuses the request (spec §2, §7).
func TestAccountMonthlyBudgetRefuses(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := jsonUpstream(t, `{"ok":true}`, nil, 200)
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL)
	// The account budget is measured by SpendMicro('account'), which sums THIS
	// month's request_log cost for the user — a row inserted now is inside the
	// window.
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx,
		`insert into budget (id, scope, scope_id, period, amount_micro, action_at_100)
		 values ($1, 'account', $2, 'monthly', 1, 'block')`,
		ids.New("bdg"), env.UserID); err != nil {
		t.Fatal(err)
	}
	tests.InsertRequestLogRow(t, dsn, env, 2)
	p := tests.NewProxy(t, dsn, up.URL)

	if code := callOnce(t, p, env); code != http.StatusPaymentRequired {
		t.Fatalf("status %d, want 402 (account monthly budget not enforced)", code)
	}
}
