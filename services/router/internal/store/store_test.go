package store_test

import (
	"context"
	"testing"

	"github.com/anvxxr-arch/fudrouter/services/router/internal/store"
	"github.com/anvxxr-arch/fudrouter/services/router/tests"
)

// Spec §1 forbids shipping a personal-OAuth provider layer, so non-commercial
// providers are onboarded with status='dev'. This pins the enforcement: the
// exclusion must be a predicate in the data plane, not a promise in a comment.
func TestDevProvidersAreHiddenUnlessOptedIn(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnvWithStatus(t, dsn, "http://127.0.0.1:1", "dev", nil)
	ctx := context.Background()

	// default: no opt-in -> a dev provider must be unreachable
	t.Setenv("ROUTER_ALLOW_DEV_PROVIDERS", "")
	strict, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer strict.Close()

	if _, err := strict.ModelWithProvider(ctx, env.Slug); err == nil {
		t.Error("dev provider served without ROUTER_ALLOW_DEV_PROVIDERS — the spec §1 violation can ship")
	}
	models, err := strict.ActiveModels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range models {
		if m.Slug == env.Slug {
			t.Error("dev model advertised in /v1/models without opt-in")
		}
	}

	// explicit opt-in -> reachable
	t.Setenv("ROUTER_ALLOW_DEV_PROVIDERS", "1")
	loose, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer loose.Close()
	if _, err := loose.ModelWithProvider(ctx, env.Slug); err != nil {
		t.Errorf("dev provider not served despite opt-in: %v", err)
	}

	// a typo must fail CLOSED, not open
	t.Setenv("ROUTER_ALLOW_DEV_PROVIDERS", "maybe")
	typo, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer typo.Close()
	if _, err := typo.ModelWithProvider(ctx, env.Slug); err == nil {
		t.Error("a nonsense ROUTER_ALLOW_DEV_PROVIDERS value failed open")
	}
}

// An active provider must keep working with no opt-in at all — the gate must
// not have quietly broken the commercial path.
func TestActiveProvidersAlwaysServed(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	t.Setenv("ROUTER_ALLOW_DEV_PROVIDERS", "")

	st, err := store.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	if _, err := st.ModelWithProvider(context.Background(), env.Slug); err != nil {
		t.Errorf("active provider not served without opt-in: %v", err)
	}
}
