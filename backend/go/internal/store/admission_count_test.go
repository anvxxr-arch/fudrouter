package store_test

// The admission read chain must be ONE round trip, not four.
//
// Why this file exists: the four calls the hot path makes before it resolves a
// model all key off the SAME api_key row and its ownership chain —
//
//	LookupAPIKey(prefix)       -> the key row (auth)
//	EffectiveLimits(key)       -> rate_limit rows for its 4 scopes + policy
//	BudgetGateState(ws, env)   -> billing_account + environment.monthly_budget
//	BudgetsFor(key)            -> budget rows for its 3 scopes
//
// — and each was its own round trip. Measured on a warm pool, one store query on
// this box is ~360µs, so four is ~1.4ms of pure round-trip latency inside a <5ms
// budget, spent re-deriving ownership from ids the first query already had.
//
// THREE of the four are now served from the in-process admission cache
// (store/admission.go): the rate_limit chain, the billing gate state and the
// budget rows. Only authentication still reads Postgres per request, and that is
// deliberate — a cached key row would delay revocation, and this is the security
// boundary the data plane owns.
//
// The assert is an exact count because a budget ("at most N") passes when a
// query is added without another being removed — the regression worth catching.
// Both states are pinned: COLD (the first request for a workspace, where every
// cache misses) and WARM (the steady state).

import (
	"context"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

// admissionReads runs exactly the reads lifecycle.begin performs before model
// resolution, in the same order, and returns what it read.
//
// It calls the CACHED gate reads (AdmissionGateState/AdmissionBudgets), because
// those are what the request path calls — asserting the uncached methods would
// measure a shape production no longer has.
func admissionReads(t *testing.T, s *store.Store, prefix string) {
	t.Helper()
	ctx := context.Background()
	key, err := s.LookupAPIKey(ctx, prefix)
	if err != nil {
		t.Fatalf("LookupAPIKey: %v", err)
	}
	if _, err := s.AdmissionLimits(ctx, key); err != nil {
		t.Fatalf("AdmissionLimits: %v", err)
	}
	if _, _, err := s.AdmissionGateState(ctx, key.WorkspaceID, key.EnvironmentID); err != nil {
		t.Fatalf("AdmissionGateState: %v", err)
	}
	if _, err := s.AdmissionBudgets(ctx, key); err != nil {
		t.Fatalf("AdmissionBudgets: %v", err)
	}
}

// fullRequestWork drives every store call one non-streaming chat request makes,
// read side and write side, so the round-trip count is the request's and not one
// stage's.
//
// It resolves the SEEDED slug rather than discovering one through the
// `fudrouter/auto` virtual: discovery is the helper's own query, and counting it here
// made the reported total describe this function instead of a request. The
// production shape is `ResolveModel(<the slug the caller asked for>)`.
func fullRequestWork(t *testing.T, s *store.Store, env *tests.Env) {
	t.Helper()
	prefix := env.Prefix
	ctx := context.Background()
	key, err := s.LookupAPIKey(ctx, prefix)
	if err != nil {
		t.Fatalf("LookupAPIKey: %v", err)
	}
	if _, err := s.AdmissionLimits(ctx, key); err != nil {
		t.Fatalf("AdmissionLimits: %v", err)
	}
	if _, _, err := s.AdmissionGateState(ctx, key.WorkspaceID, key.EnvironmentID); err != nil {
		t.Fatalf("AdmissionGateState: %v", err)
	}
	if _, err := s.AdmissionBudgets(ctx, key); err != nil {
		t.Fatalf("AdmissionBudgets: %v", err)
	}
	res, err := s.ResolveModel(ctx, key, env.Slug)
	if err != nil {
		t.Fatalf("ResolveModel: %v", err)
	}
	if _, err := s.CandidatesBatch(ctx, res.ModelIDs, res.RequiredCapabilities); err != nil {
		t.Fatalf("CandidatesBatch: %v", err)
	}
	// Write side: one request_log + ledger row, then one attempt row.
	row := &store.RequestLog{
		ID: "rql_counttest", WorkspaceID: key.WorkspaceID, ProjectID: key.ProjectID,
		EnvironmentID: key.EnvironmentID, APIKeyID: key.ID, ModelID: res.ModelIDs[0],
		TokensIn: 1, TokensOut: 1, Cost: 1, Currency: "USD", Status: "success",
	}
	if _, err := s.ChargeRequest(ctx, row); err != nil {
		t.Fatalf("ChargeRequest: %v", err)
	}
	at := &store.RequestAttempt{ID: "rta_counttest", RequestID: row.ID, Attempt: 1, Reason: "initial"}
	if err := s.InsertRequestAttempts(ctx, []*store.RequestAttempt{at}); err != nil {
		t.Fatalf("InsertRequestAttempts: %v", err)
	}
}

func TestAdmissionReadsAreOneRoundTrip(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	s, tr := startCounting(t, dsn)

	// Warm: nothing here may be a first-connection effect.
	admissionReads(t, s, env.Prefix)

	tr.Reset()
	admissionReads(t, s, env.Prefix)
	warm := tr.Count()
	t.Logf("warm admission read chain: %d queries", warm)
	for i, sql := range tr.Texts() {
		t.Logf("  %d: %.80s", i+1, strings.Join(strings.Fields(sql), " "))
	}
	// WARM is the steady state, and it is 1: authentication (the key row). Every
	// other admission read — the rate_limit chain, the billing gate state and
	// the scoped budget rows — is served in-process, which is the difference
	// between admission costing 525µs per request and 391ns
	// (BenchmarkBudgetGate).
	const wantWarm = 1
	if warm != wantWarm {
		t.Errorf("warm admission issued %d queries, want %d (see the list above); if this changed, update the "+
			"contract in this test AND the note in lifecycle.begin", warm, wantWarm)
	}

	// COLD is a workspace's first request: the gate reads miss the cache and fall
	// back to Postgres, so the shape is the original four PLUS the platform
	// hard-limits row, whose 60s cache is also empty on a fresh Store. Pinned
	// because a cache that quietly stopped caching would otherwise only show up
	// as a latency regression, not a red test.
	s2, tr2 := startCounting(t, dsn)
	tr2.Reset()
	admissionReads(t, s2, env.Prefix)
	cold := tr2.Count()
	t.Logf("cold admission read chain: %d queries", cold)
	const wantCold = 5
	if cold != wantCold {
		t.Errorf("cold admission issued %d queries, want %d (2 uncached + gate state + budgets + platform hard limits)", cold, wantCold)
	}
}

// TestWritePathRoundTrips isolates the finish() write: one request_log row plus
// its credit_ledger row should be ONE round trip, not a transaction's worth.
func TestWritePathRoundTrips(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	s, tr := startCounting(t, dsn)
	ctx := context.Background()
	key, err := s.LookupAPIKey(ctx, env.Prefix)
	if err != nil {
		t.Fatal(err)
	}
	row := &store.RequestLog{
		ID: "rql_writecount", WorkspaceID: key.WorkspaceID, ProjectID: key.ProjectID,
		EnvironmentID: key.EnvironmentID, APIKeyID: key.ID, ModelID: env.ModelID,
		TokensIn: 1, TokensOut: 1, Cost: 1, Currency: "USD", Status: "success",
	}
	// Warm the pool.
	if _, err := s.ChargeRequest(ctx, row); err != nil {
		t.Fatal(err)
	}
	tr.Reset()
	row.ID = "rql_writecount2"
	if _, err := s.ChargeRequest(ctx, row); err != nil {
		t.Fatal(err)
	}
	t.Logf("ChargeRequest (request_log + credit_ledger) = %d round trips", tr.Count())
	for i, sql := range tr.Texts() {
		t.Logf("   %d: %.50s", i+1, strings.Join(strings.Fields(sql), " "))
	}
}

// TestLiteralResolveIsOneQuery isolates the literal-slug branch of ResolveModel.
// The alias branch already has a one-query contract; the literal branch is the
// one a canonical slug takes, and it is the common case.
func TestLiteralResolveIsOneQuery(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	s, tr := startCounting(t, dsn)
	ctx := context.Background()
	key, err := s.LookupAPIKey(ctx, env.Prefix)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ResolveModel(ctx, key, env.Slug); err != nil {
		t.Fatal(err)
	}
	tr.Reset()
	res, err := s.ResolveModel(ctx, key, env.Slug)
	if err != nil {
		t.Fatal(err)
	}
	if res.Kind != "model" {
		t.Fatalf("kind = %q, want model", res.Kind)
	}
	if got := tr.Count(); got != 1 {
		t.Errorf("literal resolution issued %d queries, want 1", got)
	}
	for i, sql := range tr.Texts() {
		t.Logf("   %d: %.60s", i+1, strings.Join(strings.Fields(sql), " "))
	}
}

// TestFullRequestRoundTrips measures the WHOLE request's store round trips.
//
// Why: the <5ms target is for a request, not for one stage, so the number that
// matters is the sum of every stage's queries. Reporting it as a count (not a
// duration) keeps it valid on any box, and lets the budget be reasoned about as
// "N round trips x RTT" instead of a wall-clock guess.
func TestFullRequestRoundTrips(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	s, tr := startCounting(t, dsn)

	// Warm the POOL but not the statement cache: fullRequestWork issues each
	// statement once first, and its own run is what the SQL texts come from.
	warmPool(t, s, tr, env)

	tr.Reset()
	fullRequestWork(t, s, env)
	got := tr.Count()
	t.Logf("one chat request issues %d store round trips", got)
	for i, sql := range tr.Texts() {
		t.Logf("  %2d: %.70s", i+1, strings.Join(strings.Fields(sql), " "))
	}
}

// warmPool runs one full pass and then discards the tracer's record, so the
// traced run below sees only its own queries but the pool (and its prepared
// statements) are already open. The texts would otherwise be empty: pgx sends no
// SQL for a statement it has already described.
func warmPool(t *testing.T, s *store.Store, tr *store.CounterTracer, env *tests.Env) {
	t.Helper()
	// First pass: descriptions get prepared, texts land in the tracer.
	fullRequestWork(t, s, env)
	tr.Reset()
	// Second pass: pooled connections, no dialing. Measured from here.
	fullRequestWork(t, s, env)
	tr.Reset()
}
