package proxy_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/ids"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
	"github.com/jackc/pgx/v5"
)

// A `fudrouter/*` virtual resolves to concrete canonical models, so the body the
// upstream receives must carry the resolved model — not the virtual name the
// client sent. Forwarding the client's body verbatim made every virtual answer
// 400 INVALID_REQUEST ("Model 'fudrouter/auto' not found") while the same slug
// called directly worked.
func TestVirtualRequestRewritesUpstreamModel(t *testing.T) {
	dsn := tests.RequireDB(t)

	var gotModel string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		if m, _ := req["model"].(string); m != "" {
			gotModel = m
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"c1","object":"chat.completion","choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL)
	// With the real catalogue loaded, the default strategy picked a remote
	// provider and this rewrite test answered 503 without ever reaching its
	// local upstream. Scope only this account; do not disable catalogue rows.
	seedLocalVirtualPolicy(t, dsn, env)
	p := tests.NewProxy(t, dsn, up.URL)

	rec := httptest.NewRecorder()
	body := `{"model":"fudrouter/auto","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeCompletions(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	if gotModel == "" {
		t.Fatal("the upstream never received a request")
	}
	if gotModel == "fudrouter/auto" {
		t.Fatalf("the upstream received the virtual name %q — the body was not rewritten", gotModel)
	}
	if gotModel != env.Slug {
		t.Errorf("upstream model = %q, want the resolved canonical %q", gotModel, env.Slug)
	}
}

func seedLocalVirtualPolicy(t *testing.T, dsn string, env *tests.Env) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(context.Background()) })
	id := ids.New("rte")
	constraints, err := json.Marshal(map[string]any{"allowed_providers": []string{env.ProviderID}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		insert into routing_policy (id, account_id, name, strategy, enabled, max_attempts,
		    request_timeout_ms, fallback_enabled, provider_preferences, model_preferences, constraints, weights)
		values ($1,$2,'Local virtual fixture','provider_priority',true,2,30000,true,'{}','{}',$3::jsonb,'{}')`,
		id, env.UserID, string(constraints)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := conn.Exec(context.Background(), `delete from routing_policy where id = $1`, id); err != nil {
			t.Errorf("virtual policy teardown: %v", err)
		}
	})
}
