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

	key := &store.APIKeyRow{UserID: env.UserID}

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

// A POPULATED alias — the branch TestVirtualModelsResolve never touches, because
// the seeded `[NAME]/*` descriptors carry no targets.
//
// ResolveModel reads the winning alias and its targets in ONE query now (they
// were two). The thing that can silently break in that rewrite is
// `model_alias_target.position` ordering: the CTE pins the winner with the same
// `limit 1`, but the LEFT JOINs are the only thing left deciding the target
// order, and an inlined planner would happily return them by physical order.
// The order is load-bearing: proxy/lifecycle.go copies it onto
// `Plan.ModelPref.Order` when the policy declares no model preference, so it IS
// the routing preference. Scope precedence (account beats global) rides the
// same query for the same reason.
func TestAliasResolutionKeepsScopeAndTargetOrder(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	ctx := context.Background()

	s, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	key := &store.APIKeyRow{UserID: env.UserID}

	// A second model, so an alias has two distinct targets to order. It hangs
	// off the seeded provider (model.provider_id is the only NOT NULL FK), but
	// the alias path reads the `model` row by id and never joins the provider.
	secondID := tests.SeedModel(t, dsn, env, "alias-second", "2.000000")

	// Declare them in the order [second, first] and pin positions 0,1: the
	// resolution must come back in that order, not creation or uuid order.
	tests.SeedAlias(t, dsn, env, "customer-chat", []string{secondID, env.ModelID})

	res, err := s.ResolveModel(ctx, key, "customer-chat")
	if err != nil {
		t.Fatalf("customer-chat: %v", err)
	}
	if res.Kind != "alias" {
		t.Errorf("kind = %q, want alias", res.Kind)
	}
	want := []string{secondID, env.ModelID}
	if len(res.ModelIDs) != 2 {
		t.Fatalf("resolved %d targets, want 2: %v", len(res.ModelIDs), res.ModelIDs)
	}
	for i, wantID := range want {
		if res.ModelIDs[i] != wantID {
			t.Errorf("target[%d] = %q, want %q (position order)", i, res.ModelIDs[i], wantID)
		}
	}
	// The slug list must stay parallel to the id list: the router indexes both.
	if len(res.ModelSlugs) != len(res.ModelIDs) {
		t.Fatalf("ModelSlugs=%d ModelIDs=%d, want equal", len(res.ModelSlugs), len(res.ModelIDs))
	}
	for i := range res.ModelIDs {
		if res.ModelSlugs[i] == "" {
			t.Errorf("slug[%d] empty — the join dropped a target", i)
		}
	}

	// Scope precedence: the SAME name at global scope must lose to the
	// account-scoped row above.
	tests.SeedAliasAtScope(t, dsn, env, "customer-chat", []string{env.ModelID}, "global")
	scoped, err := s.ResolveModel(ctx, key, "customer-chat")
	if err != nil {
		t.Fatalf("customer-chat after global row: %v", err)
	}
	if len(scoped.ModelIDs) != 2 || scoped.ModelIDs[0] != secondID {
		t.Errorf("account alias must beat the global one; got %v", scoped.ModelIDs)
	}

	// A disabled alias is invisible.
	tests.DisableAlias(t, dsn, "customer-chat")
	if _, err := s.ResolveModel(ctx, key, "customer-chat"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("disabled alias err = %v, want ErrNotFound", err)
	}
}
