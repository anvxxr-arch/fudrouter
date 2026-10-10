package store_test

import (
	"context"
	"testing"

	"github.com/anvxxr-arch/fudrouter/apps/router/internal/store"
	"github.com/anvxxr-arch/fudrouter/apps/router/tests"
)

// Spec §1 forbids shipping a personal-OAuth provider layer, so non-commercial
// providers are onboarded with `tier = 'dev'` / `status = 'dev'`. This pins the
// enforcement: the exclusion must be a predicate in the data plane, not a
// promise in a comment. The same predicate gates /v1/models (PublishedModel)
// and routing (Candidates), so one mutation covers the catalogue and the hot
// path together.
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

	if _, err := strict.PublishedModel(ctx, env.Slug); err == nil {
		t.Error("dev model published without ROUTER_ALLOW_DEV_PROVIDERS — the spec §1 violation can ship")
	}
	if cands, err := strict.Candidates(ctx, env.ModelID, nil); err == nil && len(cands) > 0 {
		t.Error("dev provider routable without ROUTER_ALLOW_DEV_PROVIDERS")
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
	if _, err := loose.PublishedModel(ctx, env.Slug); err != nil {
		t.Errorf("dev model not published despite opt-in: %v", err)
	}
	if cands, err := loose.Candidates(ctx, env.ModelID, nil); err != nil || len(cands) == 0 {
		t.Errorf("dev provider not routable despite opt-in: cands=%d err=%v", len(cands), err)
	}

	// a typo must fail CLOSED, not open
	t.Setenv("ROUTER_ALLOW_DEV_PROVIDERS", "maybe")
	typo, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer typo.Close()
	if _, err := typo.PublishedModel(ctx, env.Slug); err == nil {
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

	if _, err := st.PublishedModel(context.Background(), env.Slug); err != nil {
		t.Errorf("active model not published without opt-in: %v", err)
	}
	if cands, err := st.Candidates(context.Background(), env.ModelID, nil); err != nil || len(cands) == 0 {
		t.Errorf("active provider not routable without opt-in: cands=%d err=%v", len(cands), err)
	}
}

// The refresh path rewrites the credential secret. That write is the only thing
// keeping a rotated refresh token alive, so it is pinned here — an earlier
// version referenced a non-existent `updated_at` column and would have failed
// on every refresh while still answering requests.
func TestUpdateProviderCredentialsPersists(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	ctx := context.Background()

	st, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	const replacement = "rotated-blob-ciphertext"
	if err := st.UpdateProviderCredentials(ctx, env.ProviderID, replacement); err != nil {
		t.Fatalf("UpdateProviderCredentials: %v", err)
	}

	enc, err := st.ProviderCredentials(ctx, env.ProviderID)
	if err != nil {
		t.Fatal(err)
	}
	if enc != replacement {
		t.Fatalf("credentials_enc = %q, want %q", enc, replacement)
	}
}

// The credential-ROW secret is the new home for per-account secrets (spec §4).
// A rotated token must reach its OWN row — this is what keeps a multi-account
// provider from losing one account's refresh chain.
func TestCredentialSecretRoundTrip(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	ctx := context.Background()

	st, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	cands, err := st.Candidates(ctx, env.ModelID, nil)
	if err != nil || len(cands) == 0 {
		t.Fatalf("no candidates: %v", err)
	}
	credID := ""
	if len(cands[0].Credentials) > 0 {
		credID = cands[0].Credentials[0].ID
	} else {
		t.Skip("seeded provider has no credential rows yet (legacy blob path)")
	}

	const rotated = "rotated-secret-ciphertext"
	if err := st.UpdateCredentialSecret(ctx, credID, rotated); err != nil {
		t.Fatalf("UpdateCredentialSecret: %v", err)
	}
	got, err := st.CredentialSecret(ctx, credID)
	if err != nil {
		t.Fatal(err)
	}
	if got != rotated {
		t.Fatalf("credential secret = %q, want %q", got, rotated)
	}
}
