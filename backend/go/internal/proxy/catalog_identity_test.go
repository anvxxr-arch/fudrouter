package proxy_test

// Store resolution alone does not prove compatibility: the chat handler must
// accept an old live slug under that exact key allowlist, send the mapping's
// original upstream id, and retain the caller's spelling in the audit record.
// The catalogue rows remain present so this cannot pass only after a rename.

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

func TestOldProviderSlugRoutesWithoutRenaming(t *testing.T) {
	dsn := tests.RequireDB(t)
	ctx := context.Background()
	received := make(chan string, 1)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Model string `json:"model"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		received <- body.Model
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"c1","object":"chat.completion","choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer up.Close()
	env := tests.SeedEnv(t, dsn, up.URL)
	oldSlug := strings.TrimPrefix(env.ProviderID, "prv_") + "/" + env.Slug
	duplicate := ids.New("mdl")
	mapping := ids.New("pmdl")
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(context.Background()) })
	if _, err := conn.Exec(ctx, `
		insert into model (id, provider_id, name, slug, input_price, output_price, status)
		values ($1,$2,'Old live slug',$3,150000,600000,'active')`, duplicate, env.ProviderID, oldSlug); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for _, query := range []string{`delete from request_log where api_key_id = $1`, `delete from model where id = $1`, `delete from model_slug_alias where alias = $1`} {
			arg := env.APIKeyID
			if strings.Contains(query, "model where") {
				arg = duplicate
			} else if strings.Contains(query, "model_slug_alias") {
				arg = oldSlug
			}
			if _, err := conn.Exec(context.Background(), query, arg); err != nil {
				t.Errorf("old-slug fixture teardown: %v", err)
			}
		}
	})
	if _, err := conn.Exec(ctx, `
		insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled, status)
		values ($1,$2,$3,$4,$5,true,'available')`, mapping, duplicate, env.ProviderID, env.ConnectionID, env.Slug); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `insert into model_slug_alias (alias, canonical_model_id) values ($1,$2)`, oldSlug, env.ModelID); err != nil {
		t.Fatal(err)
	}
	policy, err := json.Marshal(map[string]any{"models": []string{oldSlug}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `update api_key set policy = $2::jsonb where id = $1`, env.APIKeyID, string(policy)); err != nil {
		t.Fatal(err)
	}
	seedLocalVirtualPolicy(t, dsn, env)
	h := tests.NewProxy(t, dsn, up.URL)

	body, err := json.Marshal(map[string]any{"model": oldSlug, "messages": []map[string]string{{"role": "user", "content": "hello"}}})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(string(body)))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	rec := httptest.NewRecorder()
	h.ServeCompletions(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("old live slug answered %d: %s", rec.Code, rec.Body.String())
	}
	select {
	case got := <-received:
		if got != env.Slug {
			t.Fatalf("upstream received %q, want original mapping id %q", got, env.Slug)
		}
	default:
		t.Fatal("the local upstream did not receive the old-slug request")
	}
	var requested, status string
	if err := conn.QueryRow(ctx, `select requested_model, status from request_log where id = $1`, rec.Header().Get("x-fudrouter-request-id")).Scan(&requested, &status); err != nil {
		t.Fatal(err)
	}
	if requested != oldSlug || status != "success" {
		t.Fatalf("audit lost old spelling/success: requested=%q status=%q", requested, status)
	}
	st := tests.NewStore(t, dsn)
	published, err := st.PublishedModel(ctx, oldSlug)
	if err != nil {
		t.Fatalf("old live catalogue slug is no longer reachable: %v", err)
	}
	// The catalogue publishes ONE entry per display family, so the prefixed
	// spelling answers with the family's published entry rather than a twin
	// entry of its own. The ROWS stay (routing and billing above prove that);
	// only the listing folds them.
	if published.Slug != env.Slug {
		t.Fatalf("old live catalogue slug resolved to %q, want the published family entry %q", published.Slug, env.Slug)
	}
	t.Log("old prefixed input: HTTP 200, original upstream id, original audit spelling, folds to the published entry")
}
