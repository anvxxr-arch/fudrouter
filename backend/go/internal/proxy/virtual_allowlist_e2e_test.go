package proxy_test

// The allowlist tier seen from the request path (card t_47709e15).
//
// store's virtual_allowlist_test.go proves the RESOLUTION: a populated
// `model_alias_target` set is what a virtual resolves to, and an empty one falls
// back to the fan-out. What it cannot prove is that the resolved set is what the
// PROXY actually routes to — the lifecycle is free to re-widen the set, to let
// the fan-out leak back in through CandidatesBatch, or to rewrite the upstream
// model from the wrong member.
//
// This test closes that gap end to end: it seeds two routable models on the
// local upstream, allowlists ONE of them, and requires the upstream to receive
// exactly that one. The decoy is routable and on the SAME provider, so a
// fall-through to the fan-out would pick it up and fail the assertion.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
	"github.com/jackc/pgx/v5"
)

func TestAllowlistTierRoutesTheProxiedRequest(t *testing.T) {
	dsn := tests.RequireDB(t)

	var mu sync.Mutex
	var seenModels []string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		if m, _ := req["model"].(string); m != "" {
			mu.Lock()
			seenModels = append(seenModels, m)
			mu.Unlock()
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"c1","object":"chat.completion","choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL)
	// Only this account's provider may be used, so the request cannot escape to
	// a remote provider and pass without touching the local upstream.
	seedLocalVirtualPolicy(t, dsn, env)

	// The allowlisted model, and a decoy on the same provider that is fully
	// routable but deliberately NOT in the tier.
	wanted := tests.SeedRoutableModel(t, dsn, env, "tier-wanted-"+strings.ToLower(tests.RandChars(6)))
	decoy := tests.SeedRoutableModel(t, dsn, env, "tier-decoy-"+strings.ToLower(tests.RandChars(6)))
	tests.SeedGlobalVirtualAllowlist(t, dsn, "fudrouter/worker", []string{wanted})

	wantedSlug := modelSlug(t, dsn, wanted)
	decoySlug := modelSlug(t, dsn, decoy)
	if wantedSlug == decoySlug {
		t.Fatal("fixture bug: the two seeded models share a slug")
	}

	p := tests.NewProxy(t, dsn, up.URL)
	rec := httptest.NewRecorder()
	body := `{"model":"fudrouter/worker","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeCompletions(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	mu.Lock()
	defer mu.Unlock()
	if len(seenModels) == 0 {
		t.Fatal("the upstream never received a request")
	}
	if seenModels[0] == "fudrouter/worker" {
		t.Fatalf("the upstream received the virtual name %q — the body was not rewritten", seenModels[0])
	}
	if seenModels[0] == decoySlug {
		t.Fatalf("the request reached the DECOY %q, which is routable but not allowlisted — the tier fell through to the fan-out", decoySlug)
	}
	if seenModels[0] != wantedSlug {
		t.Fatalf("upstream model = %q, want the allowlisted %q", seenModels[0], wantedSlug)
	}
}

// TestEmptyAllowlistTierStillServes is invariant A from the request path: a tier
// with no allowlist must still answer 200. This is the compatibility half — an
// operator who deletes a tier's rows must not take the tier offline.
func TestEmptyAllowlistTierStillServes(t *testing.T) {
	dsn := tests.RequireDB(t)

	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"c1","object":"chat.completion","choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL)
	seedLocalVirtualPolicy(t, dsn, env)
	tests.SeedGlobalVirtualAllowlist(t, dsn, "fudrouter/medium", nil)

	p := tests.NewProxy(t, dsn, up.URL)
	rec := httptest.NewRecorder()
	body := `{"model":"fudrouter/medium","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeCompletions(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("empty allowlist answered %d (%s); deleting a tier's rows must restore the fan-out, not break the tier",
			rec.Code, rec.Body.String())
	}
}

// modelSlug reads a model's slug so the assertion names what the upstream was
// actually sent.
func modelSlug(t *testing.T, dsn, modelID string) string {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var slug string
	if err := conn.QueryRow(ctx, `select slug from model where id = $1`, modelID).Scan(&slug); err != nil {
		t.Fatalf("read slug of %s: %v", modelID, err)
	}
	return slug
}
