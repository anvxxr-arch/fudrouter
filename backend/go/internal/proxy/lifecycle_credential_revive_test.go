package proxy_test

// F3 (HA hardening): a transient 401 parks a credential 'invalid' (see
// lifecycle.go's non-2xx branch), but the only revival used to be the HOURLY
// credential_validation fan-out — one provider-side auth blip cost up to an
// hour of capacity on a 663-account farm. The data plane now records a 2xx as
// proof the credential works and flips it back to 'healthy' with no cooldown.
//
// The first test pins the store contract both directions: parking a credential
// 'invalid' withholds it from the candidate query (the `status not in
// ('disabled','invalid')` filter in catalog.go), and MarkCredentialHealthy
// (what reviveCredential calls on a 2xx) restores its routability. The second
// drives the gated revival through the real hot path.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
	"github.com/jackc/pgx/v5"
)

func TestCredentialReviveRestoresRoutability(t *testing.T) {
	dsn := tests.RequireDB(t)
	// The upstream is never dialed: this test exercises the store's candidate
	// query and credential writes, not the wire.
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1/up")

	ctx := context.Background()
	st, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(st.Close)

	// One credential rides on the seeded candidate; count it so the assertions
	// below cannot pass on a candidate query that happens to drop the row.
	withhold := func() int {
		t.Helper()
		cands, err := st.Candidates(ctx, env.ModelID, nil)
		if err != nil {
			t.Fatalf("Candidates: %v", err)
		}
		if len(cands) == 0 {
			t.Fatal("no candidate for the seeded model")
		}
		return len(cands[0].Credentials)
	}

	if got := withhold(); got != 1 {
		t.Fatalf("seeded credential count = %d, want 1 (healthy)", got)
	}

	// Park it 'invalid' with no cooldown — the exact state a 401 write leaves.
	if err := st.UpdateCredentialState(ctx, env.CredentialID, "invalid", nil); err != nil {
		t.Fatalf("park: %v", err)
	}
	if got := withhold(); got != 0 {
		t.Fatalf("credential count after park = %d, want 0 — 'invalid' must withhold the credential", got)
	}

	// A 2xx through that credential records health and clears the park.
	if err := st.MarkCredentialHealthy(ctx, env.CredentialID); err != nil {
		t.Fatalf("MarkCredentialHealthy: %v", err)
	}
	if got := withhold(); got != 1 {
		t.Fatalf("credential count after revive = %d, want 1 — the successful credential must be routable again", got)
	}
}

// The gated revival on the REAL hot path: a credential parked 'rate_limited'
// whose cooldown has LAPSED is still admitted by the candidate query, so the
// pool picks it — and a 2xx served through it must flip the row back to
// 'healthy' with no cooldown. That is F3 as the request actually experiences
// it. (A row already 'healthy' is deliberately NOT rewritten — R3 — which is
// the unconditional-write regression TestLoadLedgerSurvivesPoolOversubscription
// catches.)
func TestReviveFlipsLapsedRateLimitedCredentialOnSuccess(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer up.Close()
	env := tests.SeedEnv(t, dsn, up.URL)

	// Park 'rate_limited' with a cooldown that already lapsed: the candidate
	// query still admits it, so the pool picks it and the 2xx is served by it.
	ctx := context.Background()
	st, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(st.Close)
	past := time.Now().Add(-time.Minute)
	if err := st.UpdateCredentialState(ctx, env.CredentialID, "rate_limited", &past); err != nil {
		t.Fatalf("park: %v", err)
	}

	if code := postGeneric(t, dsn, up.URL, env); code != http.StatusOK {
		t.Fatalf("status %d, want 200 served through the lapsed-rate-limited credential", code)
	}

	// The revive is a detached goroutine, so poll the row until it flips or the
	// deadline says it never will.
	deadline := time.Now().Add(10 * time.Second)
	for {
		conn, err := pgx.Connect(ctx, dsn)
		if err != nil {
			t.Fatalf("connect: %v", err)
		}
		var status string
		var cooldown *time.Time
		if err := conn.QueryRow(ctx,
			`select status, cooldown_until from credential where id = $1`,
			env.CredentialID).Scan(&status, &cooldown); err != nil {
			_ = conn.Close(ctx)
			t.Fatalf("read credential: %v", err)
		}
		_ = conn.Close(ctx)
		if status == "healthy" {
			if cooldown != nil {
				t.Errorf("cooldown_until = %v, want NULL after a revive", *cooldown)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("credential status = %q, want 'healthy' — a 2xx did not revive the lapsed row", status)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
