package store_test

import (
	"context"
	"errors"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

// A `fudrouter/*` name is a virtual model: the router resolves its candidate set
// from the active strategy at request time. Its `model_alias` row (seeded by
// migration 0007) exists only so the catalogue can describe the name — it
// carries NO `model_alias_target` rows.
//
// ResolveModel used to read "alias row found, zero targets" as unroutable and
// return ErrNotFound before the virtual branch could run, so every `fudrouter/*`
// name the catalogue, the playground and the docs advertise answered 404. This
// pins the distinction: an empty NON-virtual alias stays unroutable.
func TestVirtualModelsResolve(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	ctx := context.Background()

	s, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	key := &store.APIKeyRow{WorkspaceID: env.WorkspaceID, ProjectID: env.ProjectID}

	res, err := s.ResolveModel(ctx, key, "fudrouter/auto")
	if err != nil {
		t.Fatalf("fudrouter/auto: %v — the virtual branch is unreachable", err)
	}
	if res.Kind != "virtual" {
		t.Errorf("fudrouter/auto kind = %q, want virtual", res.Kind)
	}
	if len(res.ModelIDs) == 0 {
		t.Error("fudrouter/auto resolved to no candidates")
	}
	if len(res.ModelIDs) != len(res.ModelSlugs) {
		t.Errorf("ModelIDs=%d ModelSlugs=%d, want equal", len(res.ModelIDs), len(res.ModelSlugs))
	}

	// The strategy hint rides the resolution, not the caller's request.
	fast, err := s.ResolveModel(ctx, key, "fudrouter/fast")
	if err != nil {
		t.Fatalf("fudrouter/fast: %v", err)
	}
	if fast.StrategyHint != "lowest_latency" {
		t.Errorf("fudrouter/fast hint = %q, want lowest_latency", fast.StrategyHint)
	}

	// A capability virtual carries its requirement.
	reasoning, err := s.ResolveModel(ctx, key, "fudrouter/reasoning")
	if err != nil {
		t.Fatalf("fudrouter/reasoning: %v", err)
	}
	if !reasoning.RequiredCapabilities["reasoning"] {
		t.Errorf("fudrouter/reasoning caps = %v, want reasoning", reasoning.RequiredCapabilities)
	}

	// A literal slug still resolves as a model, and an unknown name still 404s —
	// the fall-through must not open the door.
	lit, err := s.ResolveModel(ctx, key, env.Slug)
	if err != nil {
		t.Fatalf("literal slug %s: %v", env.Slug, err)
	}
	if lit.Kind != "model" {
		t.Errorf("literal slug kind = %q, want model", lit.Kind)
	}
	if _, err := s.ResolveModel(ctx, key, "no-such-model-xyz"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("unknown model err = %v, want ErrNotFound", err)
	}
}
