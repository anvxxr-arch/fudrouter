package store_test

// CandidatesBatch must be indistinguishable from N calls to Candidates.
//
// Why this file exists: a `[NAME]/*` virtual request resolves its candidate set
// from every active model, and the admission loop used to call Candidates once
// per model — measured at 251 queries for one request against a 251-model
// catalogue. The batch form collapses that to one query, which is only safe if
// it returns EXACTLY what the loop returned: the same targets, in the same order,
// with the same credentials in the same pool order.
//
// Both halves are asserted below: the query count (one, not N) and the equality
// against the per-model path. A batch that dropped a model, reordered a slice or
// lost a credential would pass a "batched" smoke test and fail here.

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

// candidateFingerprint is the comparable shape of one candidate: every field the
// admission loop and the scorer read, plus the credential pool order.
type candidateFingerprint struct {
	ModelID      string
	ProviderID   string
	Priority     int
	ConnectionID string
	Region       string
	Credentials  []string
}

func fingerprint(cs []store.Candidate) []candidateFingerprint {
	out := make([]candidateFingerprint, 0, len(cs))
	for _, c := range cs {
		creds := make([]string, 0, len(c.Credentials))
		for _, cr := range c.Credentials {
			creds = append(creds, cr.ID+":"+cr.Status)
		}
		out = append(out, candidateFingerprint{
			ModelID: c.ModelID, ProviderID: c.ProviderID, Priority: c.Priority,
			ConnectionID: c.ConnectionID, Region: c.Region, Credentials: creds,
		})
	}
	return out
}

func TestCandidatesBatchMatchesPerModel(t *testing.T) {
	dsn := tests.RequireDB(t)
	// Multi-account pool on purpose: with one credential the pool ORDER is
	// invisible, and the order is what Pick round-robins from.
	env := tests.SeedEnvAccounts(t, dsn, "http://127.0.0.1:1", []string{"tok-a", "tok-b", "tok-c"})
	ctx := context.Background()
	s, tr := startCounting(t, dsn)

	// A second model on a SECOND provider, so the batch has to keep two models'
	// slices apart rather than concatenating them.
	second := tests.SeedModels(t, dsn, env, 1)[0]

	want := map[string][]candidateFingerprint{}
	ids := []string{env.ModelID, second}
	for _, id := range ids {
		cs, err := s.Candidates(ctx, id, nil)
		if err != nil {
			t.Fatalf("Candidates(%s): %v", id, err)
		}
		want[id] = fingerprint(cs)
	}

	tr.Reset()
	got, err := s.CandidatesBatch(ctx, ids, nil)
	if err != nil {
		t.Fatalf("CandidatesBatch: %v", err)
	}
	if n := tr.Count(); n != 1 {
		t.Errorf("CandidatesBatch issued %d queries, want 1 for %d models", n, len(ids))
	}

	for _, id := range ids {
		g := fingerprint(got[id])
		w := want[id]
		if len(g) != len(w) {
			t.Fatalf("model %s: batch returned %d candidates, per-model returned %d", id, len(g), len(w))
		}
		for i := range w {
			if !reflect.DeepEqual(g[i], w[i]) {
				t.Errorf("model %s candidate[%d]:\n batch  = %+v\n single = %+v", id, i, g[i], w[i])
			}
		}
	}
	// The credential pool order is the part a json_agg/RANK rewrite breaks
	// silently, so assert it is non-trivial rather than trusting the equality.
	if len(want[env.ModelID][0].Credentials) != 3 {
		t.Fatalf("fixture is degenerate: %d credentials on the first candidate", len(want[env.ModelID][0].Credentials))
	}
}

func TestCandidatesBatchSkipsUnroutableModels(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	ctx := context.Background()
	s, tr := startCounting(t, dsn)

	// A model with NO provider_model mapping is unroutable: Candidates returns
	// ErrNotFound for it, and the batch must leave it out of the map entirely
	// rather than emit an empty slice the caller would treat as a routable model.
	orphan := tests.SeedModel(t, dsn, env, "orphan-model", "1.000000")
	if _, err := s.Candidates(ctx, orphan, nil); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("orphan Candidates err = %v, want ErrNotFound", err)
	}

	// A capability filter that no candidate satisfies must drop them too, with
	// the same rule Candidates uses (only an explicit `false` eliminates).
	tr.Reset()
	got, err := s.CandidatesBatch(ctx, []string{env.ModelID, orphan}, map[string]bool{"no_such_cap": true})
	if err != nil {
		t.Fatalf("CandidatesBatch: %v", err)
	}
	if n := tr.Count(); n != 1 {
		t.Errorf("issued %d queries, want 1", n)
	}
	if _, present := got[orphan]; present {
		t.Errorf("unroutable model %s is present in the batch result", orphan)
	}
	if len(got[env.ModelID]) == 0 {
		t.Errorf("a missing capability claim must not eliminate a candidate (spec §5)")
	}

	// An empty id list must cost no query at all.
	tr.Reset()
	if _, err := s.CandidatesBatch(ctx, nil, nil); err != nil {
		t.Fatalf("empty batch: %v", err)
	}
	if n := tr.Count(); n != 0 {
		t.Errorf("empty batch issued %d queries, want 0", n)
	}
}
