package store_test

// Query-count contracts for the two store calls on a chat request's critical
// path (spec §5).
//
// Why they exist: these functions are a SEQUENCE OF QUERIES executed before any
// upstream byte moves, and every extra query is a full round trip the client
// waits for. The count cannot be asserted from wall-clock time — on a loopback
// Postgres, removing one round trip from Candidates moved it 322µs → 338µs,
// i.e. inside the noise — so these tests count queries through the tracer seam
// (export_test.go SetQueryTracer) instead.
//
// They are written as exact counts on purpose. A budget ("at most N") would
// pass when a query is added without another being removed, which is precisely
// the regression worth catching.

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

// startCounting opens a store whose queries are counted by the returned tracer.
// The tracer must be installed before New: a pool freezes a connection's
// options when it opens the connection.
func startCounting(t *testing.T, dsn string) (*store.Store, *store.CounterTracer) {
	t.Helper()
	tr := &store.CounterTracer{}
	restore := store.SetQueryTracer(tr)
	t.Cleanup(restore)
	ctx := context.Background()
	s, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s, tr
}

// A populated alias resolves in ONE query — the row and its targets together.
// It used to be two (row, then targets), which cost a round trip for an id the
// first query had just produced.
func TestResolveModelAliasIsOneQuery(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	s, tr := startCounting(t, dsn)
	ctx := context.Background()
	key := &store.APIKeyRow{UserID: env.UserID}

	tests.SeedAlias(t, dsn, env, "counted-alias", []string{env.ModelID})

	tr.Reset()
	res, err := s.ResolveModel(ctx, key, "counted-alias")
	if err != nil {
		t.Fatalf("counted-alias: %v", err)
	}
	if res.Kind != "alias" {
		t.Fatalf("kind = %q, want alias", res.Kind)
	}
	if got := tr.Count(); got != 1 {
		t.Errorf("alias resolution issued %d queries, want 1: %v", got, tr.Texts())
	}

	// A name that is NOT an alias used to pay the alias probe AND then its own
	// slug lookup: 2 queries. The literal branch is now a UNION ALL arm of the
	// same statement, so first-match-wins still holds (the arm guards on the
	// identical alias predicate) while the round trip is gone. Measured on a
	// warm pool, one store query here is ~360µs, and this is the path a
	// canonical slug always takes.
	tr.Reset()
	if _, err := s.ResolveModel(ctx, key, "fudrouter/auto"); err != nil {
		t.Fatalf("fudrouter/auto: %v", err)
	}
	if got := tr.Count(); got != 2 {
		t.Errorf("virtual resolution issued %d queries, want 2 (alias probe + active models): %v", got, tr.Texts())
	}

	tr.Reset()
	if _, err := s.ResolveModel(ctx, key, env.Slug); err != nil {
		t.Fatalf("literal %s: %v", env.Slug, err)
	}
	if got := tr.Count(); got != 1 {
		t.Errorf("literal resolution issued %d queries, want 1 (alias and slug in one statement): %v", got, tr.Texts())
	}
}

// BudgetGateState reads the user's billing account — the hard stop the
// admission gate refuses at — in ONE round trip. Migration 0019 flattened the
// hierarchy: the environment monthly-budget column this query used to
// left-join is gone, so the gate state is the account row alone (the scoped
// `budget` rows are BudgetsFor's read, pinned below).
//
// The account read keeps its fail-CLOSED shape: an unknown user comes back as
// a nil account and a nil error — the S0-tenant case the gate treats as "no
// hard stop".
func TestBudgetGateStateIsOneQuery(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	s, tr := startCounting(t, dsn)
	ctx := context.Background()

	tr.Reset()
	acct, err := s.BudgetGateState(ctx, env.UserID)
	if err != nil {
		t.Fatalf("BudgetGateState: %v", err)
	}
	if got := tr.Count(); got != 1 {
		t.Errorf("gate state issued %d queries, want 1: %v", got, tr.Texts())
	}
	if acct == nil {
		t.Fatal("seeded user has no billing account")
	}
	if acct.Status == "" || acct.ID == "" {
		t.Errorf("account came back half-populated: %+v", acct)
	}

	// The account-scoped `budget` row (migration 0019's replacement for the
	// environment's monthly_budget_micro column) must surface through
	// BudgetsFor WITHOUT a second query, and the gate-state read must not grow
	// now that a budget row exists — a decode or scope bug here is what would
	// make an account budget silently unenforceable.
	budgetID := "bdg_count_" + randSuffix()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx,
		`insert into budget (id, scope, scope_id, period, amount_micro)
		 values ($1, 'account', $2, 'monthly', 42)`, budgetID, env.UserID); err != nil {
		t.Fatalf("seed account budget: %v", err)
	}
	t.Cleanup(func() {
		c, err := pgx.Connect(context.Background(), dsn)
		if err != nil {
			t.Errorf("cleanup connect: %v", err)
			return
		}
		defer c.Close(context.Background())
		if _, err := c.Exec(context.Background(),
			`delete from budget where id = $1`, budgetID); err != nil {
			t.Errorf("cleanup budget row: %v", err)
		}
	})

	key := &store.APIKeyRow{UserID: env.UserID, ID: env.APIKeyID}
	tr.Reset()
	budgets, err := s.BudgetsFor(ctx, key)
	if err != nil {
		t.Fatalf("BudgetsFor: %v", err)
	}
	if got := tr.Count(); got != 1 {
		t.Errorf("budgets read issued %d queries, want 1: %v", got, tr.Texts())
	}
	if len(budgets) != 1 {
		t.Fatalf("account budget rows = %d, want 1", len(budgets))
	}
	if budgets[0].Scope != "account" || budgets[0].ScopeID != env.UserID || budgets[0].AmountMicro != 42 {
		t.Errorf("budget row = %+v, want the seeded account/monthly/42 row", budgets[0])
	}

	tr.Reset()
	if _, err := s.BudgetGateState(ctx, env.UserID); err != nil {
		t.Fatalf("BudgetGateState after budget insert: %v", err)
	}
	if got := tr.Count(); got != 1 {
		t.Errorf("gate state issued %d queries after the budget insert, want 1: %v", got, tr.Texts())
	}

	// A user with NO account must come back with a nil account and a nil
	// error — that is the S0-tenant case the gate must treat as "no hard stop".
	tr.Reset()
	acct, err = s.BudgetGateState(ctx, "usr_does_not_exist")
	if err != nil {
		t.Fatalf("unknown account: %v", err)
	}
	if acct != nil {
		t.Errorf("unknown account returned a billing account: %+v", acct)
	}
	if got := tr.Count(); got != 1 {
		t.Errorf("unknown-account state issued %d queries, want 1: %v", got, tr.Texts())
	}
}

// Candidates resolves the candidate rows AND their connection credentials in
// ONE query. It used to be two: the rows, then a batched credential query for
// every distinct connection — the same connections the first query had just
// read.
func TestCandidatesIsOneQuery(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnvAccounts(t, dsn, "http://127.0.0.1:1", []string{"tok-1", "tok-2", "tok-3"})
	s, tr := startCounting(t, dsn)
	ctx := context.Background()

	tr.Reset()
	cands, err := s.Candidates(ctx, env.ModelID, nil)
	if err != nil {
		t.Fatalf("Candidates: %v", err)
	}
	if len(cands) == 0 {
		t.Fatal("no candidates")
	}
	if got := tr.Count(); got != 1 {
		t.Errorf("candidates resolution issued %d queries, want 1: %v", got, tr.Texts())
	}

	// Every seeded credential must have survived the aggregate: a json_agg
	// typo drops fields, and a dropped credential silently shrinks a pool.
	total := 0
	for _, c := range cands {
		total += len(c.Credentials)
		for _, cr := range c.Credentials {
			if cr.ID == "" || cr.SecretEnc == "" {
				t.Errorf("credential came back empty through json_agg: %+v", cr)
			}
		}
	}
	if total != 3 {
		t.Errorf("candidates carry %d credentials, want 3", total)
	}
}
