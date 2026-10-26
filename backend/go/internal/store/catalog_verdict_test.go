package store_test

import (
	"context"
	"errors"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/ids"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
	"github.com/jackc/pgx/v5"
)

// Model identity is evidence, and the catalogue must obey it.
//
// `model_verification` (migration 0018) records what a provider's endpoint
// actually answered when asked for a model by name. Until this gate existed the
// verdicts were recorded and read by an admin endpoint that nothing rendered —
// the router kept advertising and routing to a model whose upstream served a
// DIFFERENT model under the requested name. That is worse than a 404: the caller
// pays for, and believes, a model it is not getting.
//
// The rule is LATEST-VERDICT-WINS. The table is append-only, so a provider that
// fixes its endpoint appends a `pass` and the model returns with no predicate
// change. `error` never withholds: a 5xx or a timeout proves nothing about what
// the provider serves, and treating it as evidence would flag a healthy model on
// every flaky probe.
func TestCatalogueObeysLatestVerificationVerdict(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	ctx := context.Background()

	st, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(context.Background()) })

	// One probe row, appended with an explicit created_at so "newer" is a fact
	// of the test rather than of wall-clock ordering: two inserts inside the
	// same millisecond would otherwise tie and make max(created_at) pick either.
	var seq int
	appendVerdict := func(verdict string, ageMinutes int) {
		seq++
		if _, err := conn.Exec(ctx, `
			insert into model_verification (id, provider_model_id, requested_slug, response_model, verdict, latency_ms, created_at)
			values ($1, $2, $3, $4, $5, 12, now() - make_interval(mins => $6))`,
			ids.New("ver"), env.ProviderModelID, env.Slug, "whatever-the-upstream-said", verdict, ageMinutes); err != nil {
			t.Fatalf("append verdict %s: %v", verdict, err)
		}
	}
	// published is the single question both catalogue views must answer the same
	// way: is this slug in /v1/models, and does /v1/models/{slug} return it?
	published := func(t *testing.T) bool {
		t.Helper()
		models, err := st.ActiveModels(ctx)
		if err != nil {
			t.Fatalf("ActiveModels: %v", err)
		}
		var listed bool
		for _, m := range models {
			if m.Slug == env.Slug {
				listed = true
			}
		}
		_, err = st.PublishedModel(ctx, env.Slug)
		found := err == nil
		if !found && !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("PublishedModel: unexpected error %v", err)
		}
		if listed != found {
			t.Fatalf("the two catalogue views disagree: ActiveModels lists=%v, PublishedModel found=%v", listed, found)
		}
		return listed
	}

	// Baseline: no verdict at all is not evidence of anything, so the seeded
	// model stays published. A gate that hid an unprobed model would empty the
	// catalogue on a fresh deploy.
	if !published(t) {
		t.Fatal("a model with no verification rows must stay published")
	}

	// A mismatch on the LATEST verdict withholds the model.
	appendVerdict("mismatch", 10)
	if published(t) {
		t.Fatal("a model whose latest verdict is 'mismatch' must leave the catalogue")
	}

	// not_served withholds it too: the upstream answered nothing usable.
	appendVerdict("not_served", 9)
	if published(t) {
		t.Fatal("a model whose latest verdict is 'not_served' must leave the catalogue")
	}

	// error does NOT withhold — but it does not clear the older bad verdict
	// either, because it is not evidence about what is served. The latest
	// non-error verdict still governs... except the predicate compares the
	// single newest row, so an `error` as the newest row means "no verdict",
	// and the model returns. Both readings are defensible; this pins the one
	// the predicate implements, which is the plan's: a transient outcome must
	// never withhold a healthy model.
	appendVerdict("error", 8)
	if !published(t) {
		t.Fatal("a transient 'error' verdict must not withhold a model")
	}

	// A pass on the latest verdict restores it, which is what makes a provider
	// fix recoverable without an operator editing rows.
	appendVerdict("mismatch", 7)
	if published(t) {
		t.Fatal("a newer 'mismatch' must withhold again")
	}
	appendVerdict("pass", 6)
	if !published(t) {
		t.Fatal("a newer 'pass' must restore the model to the catalogue")
	}

	// Routing obeys the same rule, not just the catalogue: a withheld model
	// with an otherwise-perfect candidate set must have NO routable target, or
	// the router would serve a model /v1/models refuses to advertise.
	// Candidates reports that as ErrNotFound rather than an empty slice.
	appendVerdict("mismatch", 5)
	if _, err := st.Candidates(ctx, env.ModelID, nil); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("Candidates must refuse a withheld model, got err=%v", err)
	}
	appendVerdict("pass", 4)
	if candidates, err := st.Candidates(ctx, env.ModelID, nil); err != nil {
		t.Fatalf("Candidates: %v", err)
	} else if len(candidates) == 0 {
		t.Fatal("Candidates returned no targets for a verified-pass model")
	}
	// CandidatesBatch — the path a virtual request takes — must agree.
	appendVerdict("mismatch", 3)
	if batch, err := st.CandidatesBatch(ctx, []string{env.ModelID}, nil); err != nil {
		t.Fatalf("CandidatesBatch: %v", err)
	} else if len(batch[env.ModelID]) != 0 {
		t.Fatalf("CandidatesBatch returned %d targets for a withheld model", len(batch[env.ModelID]))
	}
}
