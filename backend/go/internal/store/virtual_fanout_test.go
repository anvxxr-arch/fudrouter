package store_test

// The admission fan-out for a `[NAME]/*` virtual request must be a CONSTANT
// number of queries, not one per model in the catalogue.
//
// Why this file exists: the admission loop called Candidates once per model id,
// and a virtual name resolves its candidate set from every active model.
// Measured before the fix: 251 Candidates queries for ONE request against a
// 251-model catalogue, each carrying the credential json_agg. At the stated
// 100k rps target that is 25M queries/second — so this is a scalability gate,
// not a micro-optimisation.
//
// The tracer is package-internal (export_test.go), which is why the assertion
// lives here rather than in proxy_test: it counts the store round trips the
// admission path would issue for the same model set the router resolves.
//
// Scaling is asserted as well as the absolute count: a fix that lowered the
// constant would pass a fixed-count assertion and still be O(catalogue).

import (
	"context"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

// admissionQueries is what the router's model-resolution step costs for a
// virtual name: resolve, then fetch every model's candidates the way
// lifecycle.begin does.
func admissionQueries(t *testing.T, s *store.Store, tr *store.CounterTracer, key *store.APIKeyRow, name string) (int, int) {
	t.Helper()
	ctx := context.Background()
	res, err := s.ResolveModel(ctx, key, name)
	if err != nil {
		t.Fatalf("ResolveModel(%s): %v", name, err)
	}
	tr.Reset()
	if _, err := s.CandidatesBatch(ctx, res.ModelIDs, res.RequiredCapabilities); err != nil {
		t.Fatalf("CandidatesBatch: %v", err)
	}
	return tr.Count(), len(res.ModelIDs)
}

func TestVirtualFanOutIsConstant(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	s, tr := startCounting(t, dsn)
	key := &store.APIKeyRow{UserID: env.UserID}

	// Grow the catalogue 10x and require the same cost. Each seeded model is
	// routable (SeedModels inserts the provider_model mapping), so the virtual
	// name's candidate set really does grow.
	tests.SeedModels(t, dsn, env, 20)
	smallQ, smallN := admissionQueries(t, s, tr, key, "fudrouter/auto")
	tests.SeedModels(t, dsn, env, 200)
	bigQ, bigN := admissionQueries(t, s, tr, key, "fudrouter/auto")

	t.Logf("virtual candidate fetch: %d queries for %d models, %d queries for %d models",
		smallQ, smallN, bigQ, bigN)
	if bigN < smallN*5 {
		t.Fatalf("fixture did not grow: %d models then %d", smallN, bigN)
	}
	if smallQ != bigQ {
		t.Fatalf("candidate fetch scales with the catalogue: %d -> %d queries", smallQ, bigQ)
	}
	if bigQ != 1 {
		t.Errorf("candidate fetch for %d models issued %d queries, want 1", bigN, bigQ)
	}

	// The regression this replaced, measured through the same tracer: the
	// per-model loop the admission path used to run. Asserting the contrast keeps
	// the fix honest — if Candidates ever becomes the only path available, this
	// line shows what the admission cost would be.
	res, err := s.ResolveModel(context.Background(), key, "fudrouter/auto")
	if err != nil {
		t.Fatal(err)
	}
	tr.Reset()
	for _, id := range res.ModelIDs {
		_, _ = s.Candidates(context.Background(), id, res.RequiredCapabilities)
	}
	perModel := tr.Count()
	t.Logf("per-model loop for %d models: %d queries (batch: 1)", len(res.ModelIDs), perModel)
	if perModel != len(res.ModelIDs) {
		t.Fatalf("per-model baseline = %d queries for %d models, expected 1:1", perModel, len(res.ModelIDs))
	}
	if perModel <= bigQ {
		t.Fatalf("batch (%d) is not cheaper than the per-model loop (%d)", bigQ, perModel)
	}
}

// The count assertion must not be satisfiable by looking at fewer models.
func TestVirtualFanOutStillCoversEveryModel(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	s, tr := startCounting(t, dsn)
	key := &store.APIKeyRow{UserID: env.UserID}
	ctx := context.Background()

	tests.SeedModels(t, dsn, env, 40)
	res, err := s.ResolveModel(ctx, key, "fudrouter/auto")
	if err != nil {
		t.Fatal(err)
	}
	tr.Reset()
	byModel, err := s.CandidatesBatch(ctx, res.ModelIDs, res.RequiredCapabilities)
	if err != nil {
		t.Fatal(err)
	}
	if got := tr.Count(); got != 1 {
		t.Errorf("batch issued %d queries, want 1", got)
	}
	routable := 0
	for _, id := range res.ModelIDs {
		if len(byModel[id]) > 0 {
			routable++
		}
	}
	if routable != len(res.ModelIDs) {
		t.Errorf("only %d of %d resolved models returned candidates", routable, len(res.ModelIDs))
	}
	if routable < 40 {
		t.Fatalf("fixture is too small to be meaningful: %d routable", routable)
	}
}
