package proxy_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/ids"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/proxy"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
	"github.com/jackc/pgx/v5"
)

// chatUpstream answers the probe's one-token completion like a real upstream:
// 200 + a choices array. The in-repo echoUpstream returns no choices (an
// accepted-in-prod but malformed-by-OpenAI body), which is exactly the case
// the probe must classify as down, so the ok-path needs its own server.
func chatUpstream(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "chatcmpl-probe", "object": "chat.completion", "model": "up-model",
			"choices": []any{map[string]any{"index": 0, "message": map[string]string{"role": "assistant", "content": "pong"}, "finish_reason": "stop"}},
			"usage":   map[string]any{"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
		})
	}))
	t.Cleanup(srv.Close)
	return srv
}

// TestProbeOnceOk pins the headline promise: a probe through the REAL routing
// walk against a live upstream lands as status=ok with non-negative latency.
func TestProbeOnceOk(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := chatUpstream(t)
	env := tests.SeedEnv(t, dsn, up.URL)
	h := tests.NewProxy(t, dsn, up.URL)

	e := h.ProbeOnce(context.Background(), env.Slug)
	if e.Status != "ok" {
		t.Fatalf("probe status = %q (err %q), want ok", e.Status, e.ErrCode)
	}
	if e.LatencyMs < 0 {
		t.Fatalf("latency = %d, want >= 0", e.LatencyMs)
	}
	if e.CheckedAt.IsZero() {
		t.Fatal("checked_at must be stamped")
	}
}

// TestProbeOnceDown pins the failure contract: a dead upstream answers down
// with a routing-layer error code, never a fabricated ok.
func TestProbeOnceDown(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := chatUpstream(t)
	env := tests.SeedEnv(t, dsn, up.URL)
	// Close the upstream AFTER seeding: the candidate targets its URL, which
	// now refuses connections — the honest "provider is down" scenario.
	up.Close()
	h := tests.NewProxy(t, dsn, up.URL)

	e := h.ProbeOnce(context.Background(), env.Slug)
	if e.Status != "down" {
		t.Fatalf("probe status = %q against a dead upstream, want down", e.Status)
	}
	if e.ErrCode == "" {
		t.Fatal("a dead upstream must carry a non-empty error code")
	}
}

// TestModelDetailOptInAbsentBeforeSweep pins the opt-in contract: without a
// health flag the object keeps the literal §6 P1 field set (exactly 5 fields),
// and with the flag a never-probed model OMITS health — absent = not probed.
func TestModelDetailOptInAbsentBeforeSweep(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := chatUpstream(t)
	env := tests.SeedEnv(t, dsn, up.URL)
	mux := proxy.ServeMux(tests.NewProxy(t, dsn, up.URL), readyHealth{})

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/models/"+env.Slug, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET detail = %d, want 200", rec.Code)
	}
	var plain map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &plain); err != nil {
		t.Fatalf("detail not JSON: %s", rec.Body.String())
	}
	if len(plain) != 5 {
		t.Fatalf("default detail fields = %v (%d), want exactly the 5 P1 fields", keysOf(plain), len(plain))
	}

	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/models/"+env.Slug+"?health=1", nil))
	var optIn map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &optIn); err != nil {
		t.Fatalf("opt-in detail not JSON: %s", rec.Body.String())
	}
	if _, present := optIn["health"]; present {
		t.Fatalf("never-probed model must OMIT health, got %v", optIn["health"])
	}
}

// TestHealthVisibleAfterProbeOnce is the closed loop: one successful probe
// makes the opt-in surfaces answer with the recorded status immediately.
func TestHealthVisibleAfterProbeOnce(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := chatUpstream(t)
	env := tests.SeedEnv(t, dsn, up.URL)
	h := tests.NewProxy(t, dsn, up.URL)
	mux := proxy.ServeMux(h, readyHealth{})

	if e := h.ProbeOnce(context.Background(), env.Slug); e.Status != "ok" {
		t.Fatalf("probe = %q (%q), want ok", e.Status, e.ErrCode)
	}

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/models/"+env.Slug+"?health=1", nil))
	var detail map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &detail); err != nil {
		t.Fatalf("detail not JSON: %s", rec.Body.String())
	}
	hv, present := detail["health"].(map[string]any)
	if !present {
		t.Fatalf("probed model must carry health after ProbeOnce, got %v", detail)
	}
	if hv["status"] != "ok" {
		t.Fatalf("health.status = %v, want ok", hv["status"])
	}

	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/models?health=1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET list?health=1 = %d", rec.Code)
	}
	var list struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("list not JSON: %s", rec.Body.String())
	}
	var hit bool
	for _, m := range list.Data {
		if m["id"] == env.Slug {
			_, hit = m["health"].(map[string]any)
		}
	}
	if !hit {
		t.Fatalf("opt-in list entry must carry health after the probe")
	}
}

// TestModelsListStaysValid keeps the additive-field promise honest: the list
// endpoint still answers 200 with the S0 envelope, whatever health data exists.
func TestModelsListStaysValid(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := chatUpstream(t)
	tests.SeedEnv(t, dsn, up.URL)
	mux := proxy.ServeMux(tests.NewProxy(t, dsn, up.URL), readyHealth{})

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/models", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /v1/models = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"object":"list"`) {
		t.Fatal("list envelope lost")
	}
}

// TestProbeOkWhenOnlyFallbackProviderAlive is the failover-aware health
// contract. A published model is a COMBO: one canonical model reachable through
// several providers. When the first provider is down and a later one serves,
// the model is serving — a probe that reports "down" tells an operator the
// opposite of the truth and invites them to debug a model that works.
//
// The probe used to fire exactly one attempt (`MaxAttempts = 1`,
// `FallbackEnabled = false`), so it reported whichever provider the walk ranked
// first. Now it dials the whole display family, bounded by its candidate count.
func TestProbeOkWhenOnlyFallbackProviderAlive(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := chatUpstream(t)
	// Two independent providers: the first one's upstream refuses connections.
	deadEnv := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	liveEnv := tests.SeedEnv(t, dsn, up.URL)
	ctx := context.Background()

	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(context.Background()) })

	// Fold the live provider's row into the dead row's display family, so the
	// two rows are ONE published combo.
	if _, err := conn.Exec(ctx, `insert into model_slug_alias (alias, canonical_model_id) values ($1,$2)`,
		liveEnv.Slug, deadEnv.ModelID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := conn.Exec(context.Background(), `delete from model_slug_alias where alias = $1`, liveEnv.Slug); err != nil {
			t.Errorf("teardown leaked an alias row: %v", err)
		}
	})
	// The dead provider ranks FIRST, so a single-shot probe hits it and only it.
	if _, err := conn.Exec(ctx, `update provider set priority = 1 where id = $1`, deadEnv.ProviderID); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `update provider set priority = 2 where id = $1`, liveEnv.ProviderID); err != nil {
		t.Fatal(err)
	}

	h := tests.NewProxy(t, dsn, up.URL)
	e := h.ProbeOnce(ctx, deadEnv.Slug)
	if e.Status != "ok" {
		t.Fatalf("probe status = %q (err %q), want ok: a sibling provider still serves this model", e.Status, e.ErrCode)
	}

	// Negative control: remove the live row from the family. With only the dead
	// provider left, the same probe must report down — the failover is what
	// earns the ok, not a weakened failure contract.
	if _, err := conn.Exec(ctx, `delete from model_slug_alias where alias = $1`, liveEnv.Slug); err != nil {
		t.Fatal(err)
	}
	if e := h.ProbeOnce(ctx, deadEnv.Slug); e.Status != "down" {
		t.Fatalf("probe status = %q with no live provider, want down", e.Status)
	}
}

// TestFoldedVariantDetailCarriesFamilyHealth closes the loop between the
// catalogue fold and the health field. The sweep probes the PUBLISHED entry
// (the family's plain slug), so a client that names a folded spelling must read
// that entry's record — including its id and health — not a 404 and not an
// object missing the health it just saw in the list.
func TestFoldedVariantDetailCarriesFamilyHealth(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := chatUpstream(t)
	env := tests.SeedEnv(t, dsn, up.URL)
	ctx := context.Background()

	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(context.Background()) })

	base := "foldhealth-" + tests.RandChars(6)
	if _, err := conn.Exec(ctx, `update model set slug = $2, capabilities = '{"chat":true}'::jsonb where id = $1`,
		env.ModelID, base); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := conn.Exec(context.Background(), `update model set slug = $2 where id = $1`, env.ModelID, env.Slug); err != nil {
			t.Errorf("restore base slug: %v", err)
		}
	})
	variant := base + ":free"
	variantID := ids.New("mdl")
	if _, err := conn.Exec(ctx, `
		insert into model (id, provider_id, name, slug, context, input_price, output_price, currency, status, capabilities)
		values ($1,$2,$3,$4,128000,'150000.000000','600000.000000','USD','active','{"chat":true}'::jsonb)`,
		variantID, env.ProviderID, variant, variant); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled, status)
		values ($1,$2,$3,$4,$5,true,'available')`,
		ids.New("pmdl"), variantID, env.ProviderID, env.ConnectionID, variant); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := conn.Exec(context.Background(), `delete from provider_model where model_id = $1`, variantID); err != nil {
			t.Errorf("teardown leaked a provider_model row: %v", err)
		}
		if _, err := conn.Exec(context.Background(), `delete from model where id = $1`, variantID); err != nil {
			t.Errorf("teardown leaked a model row: %v", err)
		}
	})

	h := tests.NewProxy(t, dsn, up.URL)
	if e := h.ProbeOnce(ctx, base); e.Status != "ok" {
		t.Fatalf("probe = %q (%q), want ok", e.Status, e.ErrCode)
	}
	mux := proxy.ServeMux(h, readyHealth{})

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/models/"+variant+"?health=1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /v1/models/%s = %d body %s", variant, rec.Code, rec.Body.String())
	}
	var detail map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &detail); err != nil {
		t.Fatalf("detail not JSON: %s", rec.Body.String())
	}
	if detail["id"] != base {
		t.Errorf("detail id = %v, want the published family entry %q", detail["id"], base)
	}
	hv, present := detail["health"].(map[string]any)
	if !present {
		t.Fatalf("folded spelling must carry its family's health, got %v", detail)
	}
	if hv["status"] != "ok" {
		t.Errorf("health.status = %v, want ok", hv["status"])
	}
}
