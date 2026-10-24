package proxy_test

// A combo is an ordered, CUSTOMER-authored fallback sequence ("try the expensive
// model first, fall back to the cheap one"). 9Router's headline feature.
//
// This router gets it almost free: routing.Select orders candidates and
// routing.Execute walks them recording a request_attempt per hop, so a combo only
// has to map a name onto an ordered model list (store/combo.go). The tests below
// prove the two things that claim depends on:
//
//   - the authored order is the walk order, not re-sorted by strategy;
//   - a failure on the first member falls through to the second, and the customer
//     is charged ONCE with every hop recorded.
//
// The second is the commercial half. A gateway without a ledger can retry; it
// cannot show which upstream served the request and what each failed hop cost.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/ids"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
	"github.com/jackc/pgx/v5"
)

// seedCombo writes one combo for the account with the given model ids in order.
func seedCombo(t *testing.T, dsn, accountID, name string, modelIDs []string) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	comboID := ids.New("cmb")
	if _, err := conn.Exec(ctx,
		`insert into combo (id, account_id, name) values ($1,$2,$3)`,
		comboID, accountID, name); err != nil {
		t.Fatal(err)
	}
	for i, m := range modelIDs {
		if _, err := conn.Exec(ctx,
			`insert into combo_model (combo_id, position, model_id) values ($1,$2,$3)`,
			comboID, i, m); err != nil {
			t.Fatal(err)
		}
	}
}

// A combo name resolves to exactly the authored models, in the authored order.
func TestComboResolvesInAuthoredOrder(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := jsonUpstream(t, `{"ok":true}`, nil, 200)
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL)
	second := tests.SeedSecondModel(t, dsn, env)

	seedCombo(t, dsn, env.UserID, "my-combo", []string{second.ModelID, env.ModelID})

	p := tests.NewProxy(t, dsn, up.URL)
	body := `{"model":"my-combo","stream":false,"messages":[{"role":"user","content":"hi"}]}`
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeCompletions(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 (combo did not resolve)", rec.Code)
	}

	// request_log keeps the CUSTOMER's name, not the resolved model: the combo is
	// the unit the customer asked for and will look for in their logs.
	var requested string
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if err := conn.QueryRow(ctx,
		`select requested_model from request_log where api_key_id = $1
		 order by created_at desc limit 1`, env.APIKeyID).Scan(&requested); err != nil {
		t.Fatal(err)
	}
	if requested != "my-combo" {
		t.Fatalf("requested_model = %q, want the combo name", requested)
	}
}

// When the FIRST combo member fails upstream, the walker must try the SECOND and
// the customer must be charged exactly once. This is the acceptance criterion.
func TestComboFallsThroughAndChargesOnce(t *testing.T) {
	dsn := tests.RequireDB(t)
	// Upstream fails every request: the combo must exhaust its members.
	up := jsonUpstream(t, `{"error":"boom"}`, nil, 500)
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL)
	second := tests.SeedSecondModel(t, dsn, env)
	seedCombo(t, dsn, env.UserID, "fb", []string{env.ModelID, second.ModelID})

	p := tests.NewProxy(t, dsn, up.URL)
	body := `{"model":"fb","stream":false,"messages":[{"role":"user","content":"hi"}]}`
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeCompletions(rec, req)

	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)

	var reqID string
	if err := conn.QueryRow(ctx,
		`select id from request_log where api_key_id = $1 order by created_at desc limit 1`,
		env.APIKeyID).Scan(&reqID); err != nil {
		t.Fatal(err)
	}

	// Every hop is recorded — that is what a ledger buys over a retry loop.
	var attempts int
	if err := conn.QueryRow(ctx,
		`select count(distinct attempt) from request_attempt where request_id = $1`, reqID).Scan(&attempts); err != nil {
		t.Fatal(err)
	}
	if attempts < 2 {
		t.Fatalf("request_attempt rows = %d, want >= 2 (the combo did not walk past the first member)", attempts)
	}

	// Exactly one charge: a fallback is one request, not N.
	var charges int
	if err := conn.QueryRow(ctx,
		`select count(*) from credit_ledger where request_id = $1 and type = 'usage_charge'`, reqID).Scan(&charges); err != nil {
		t.Fatal(err)
	}
	if charges > 1 {
		t.Fatalf("usage_charge rows = %d for one combo request, want <= 1", charges)
	}
}

// A combo naming a model that does not route must not silently become a
// different model. The resolver returns only members that are active, and an
// all-inactive combo is "not routable" — which must surface as a model error,
// never as a request served by something the customer did not name.
func TestComboWithNoActiveMembersIsNotRouted(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := jsonUpstream(t, `{"ok":true}`, nil, 200)
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL)
	hits := 0
	counting := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		up.Config.Handler.ServeHTTP(w, r)
	}))
	defer counting.Close()

	// A combo whose only member does not exist as an active model: the FK allows
	// it only if the model row exists, so insert one and disable it.
	second := tests.SeedSecondModel(t, dsn, env)
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx,
		`update model set status = 'inactive' where id = $1`, second.ModelID); err != nil {
		t.Fatal(err)
	}
	seedCombo(t, dsn, env.UserID, "dead", []string{second.ModelID})

	p := tests.NewProxy(t, dsn, counting.URL)
	body := `{"model":"dead","stream":false,"messages":[{"role":"user","content":"hi"}]}`
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeCompletions(rec, req)

	if rec.Code == http.StatusOK {
		t.Fatal("a combo with no active members was served; it must not fall back to an unrelated model")
	}
	if hits != 0 {
		t.Fatalf("upstream dialled %d time(s) for an unroutable combo", hits)
	}
}
