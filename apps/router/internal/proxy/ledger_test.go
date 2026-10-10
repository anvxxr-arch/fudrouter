package proxy_test

// The billing/attempt acceptance lines (assignment + PRD §118/§128, spec §6/§8):
//
//   - a streaming call records non-zero tokens_in AND non-zero cost WITH a
//     usage_charge credit_ledger row;
//   - ChargeRequest is idempotent: `usage:<request id>` can never double-debit;
//   - the price snapshot is frozen at REQUEST START — a price change mid-flight
//     or later never rewrites history, and the next request picks the new rule;
//   - a 429-then-200 failover persists two request_attempt rows and
//     fallback_used = true.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/apps/router/internal/ids"
	"github.com/anvxxr-arch/fudrouter/apps/router/internal/store"
	"github.com/anvxxr-arch/fudrouter/apps/router/tests"
)

func TestStreamedCallIsBilledToTheLedger(t *testing.T) {
	dsn := tests.RequireDB(t)
	var gotAuth, gotBody string
	up := newUpstream(t, []string{
		`{"id":"c1","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hel"}}]}`,
		`{"id":"c1","object":"chat.completion.chunk","choices":[{"delta":{"content":"lo"}}]}`,
		`{"id":"c1","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}`,
	}, &gotAuth, &gotBody)
	defer up.Close()
	env := tests.SeedEnv(t, dsn, up.URL)
	p := tests.NewProxy(t, dsn, up.URL)
	rec := httptest.NewRecorder()
	body := `{"model":"` + env.Slug + `","stream":true,"messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeCompletions(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	log := tests.LastRequestLog(t, dsn, env.APIKeyID)
	if !log.Stream {
		t.Error("request_log.stream = false for a streamed call")
	}
	if log.TokensIn == 0 {
		t.Error("tokens_in = 0 — a streamed call must record the usage the provider reported (PRD §87)")
	}
	if log.Cost == 0 {
		t.Error("cost = 0 — the streamed call is unbilled")
	}
	rows := tests.LedgerRows(t, dsn, log.ID)
	if len(rows) != 1 {
		t.Fatalf("credit_ledger rows for the request = %d, want exactly one usage_charge (PRD §128)", len(rows))
	}
	if rows[0].Type != "usage_charge" {
		t.Errorf("ledger type = %q, want usage_charge", rows[0].Type)
	}
	if rows[0].AmountMicro != -log.Cost {
		t.Errorf("ledger amount = %d, want -%d (a usage_charge debits the balance)", rows[0].AmountMicro, log.Cost)
	}
	if rows[0].IdempotencyKey != "usage:"+log.ID {
		t.Errorf("idempotency_key = %q, want %q (PRD §118)", rows[0].IdempotencyKey, "usage:"+log.ID)
	}
}

func TestChargeRequestIsIdempotent(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1") // never dialed: this is a ledger test
	ctx := context.Background()
	st, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	newRow := func() *store.RequestLog {
		return &store.RequestLog{
			ID: ids.New("req"), UserID: env.UserID, APIKeyID: env.APIKeyID,
			WorkspaceID: env.WorkspaceID, ProjectID: env.ProjectID, EnvironmentID: env.EnvironmentID,
			Endpoint: "/v1/chat/completions", ModelID: env.ModelID, ProviderID: env.ProviderID,
			Status: "success", TokensIn: 11, TokensOut: 7, Cost: 6, Currency: "USD",
		}
	}
	row := newRow()
	res, err := st.ChargeRequest(ctx, row)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Charged {
		t.Fatal("first charge did not happen")
	}
	// Seeded balance is 10_000_000_000 micro (tests.SeedEnv); the 6 debits it.
	if res.BalanceMicro != 9_999_999_994 {
		t.Errorf("balance after charge = %d, want 9999999994", res.BalanceMicro)
	}
	rows := tests.LedgerRows(t, dsn, row.ID)
	if len(rows) != 1 || rows[0].Type != "usage_charge" || rows[0].AmountMicro != -6 {
		t.Fatalf("ledger rows = %+v, want one usage_charge of -6", rows)
	}
	if rows[0].IdempotencyKey != "usage:"+row.ID {
		t.Errorf("idempotency_key = %q, want %q", rows[0].IdempotencyKey, "usage:"+row.ID)
	}
	// Replay (same request id, as a retry would): no second debit, no balance move.
	replay := newRow()
	replay.ID = row.ID
	res2, err := st.ChargeRequest(ctx, replay)
	if err != nil {
		t.Fatal(err)
	}
	if res2.Charged {
		t.Error("a replayed charge was applied again — one request can never be charged twice (PRD §118)")
	}
	if res2.BalanceMicro != res.BalanceMicro {
		t.Errorf("balance moved on replay: %d -> %d", res.BalanceMicro, res2.BalanceMicro)
	}
	if rows := tests.LedgerRows(t, dsn, row.ID); len(rows) != 1 {
		t.Errorf("ledger rows after replay = %d, want 1", len(rows))
	}
	log := tests.RequestLogByID(t, dsn, row.ID)
	if log.CreditCharged != 6 {
		t.Errorf("credit_charged_micro = %d, want 6 (the charge mirrors on the ledger row, spec §8)", log.CreditCharged)
	}
}

func TestPriceSnapshotIsFrozenAtRequestStart(t *testing.T) {
	dsn := tests.RequireDB(t)
	reached := make(chan struct{})
	gate := make(chan struct{})
	var once sync.Once
	const reply = `{"id":"c1","object":"chat.completion","model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"PONG"},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}`
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		once.Do(func() { close(reached) })
		<-gate // hold the request open so the v2 rule lands MID-FLIGHT
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(reply))
	}))
	defer up.Close()
	env := tests.SeedEnv(t, dsn, up.URL) // v1: in 150000.000000 / out 600000.000000
	p := tests.NewProxy(t, dsn, up.URL)
	call := func() int {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
			strings.NewReader(`{"model":"`+env.Slug+`","messages":[{"role":"user","content":"hi"}]}`))
		req.Header.Set("Authorization", "Bearer "+env.Key)
		req.Header.Set("Content-Type", "application/json")
		p.ServeCompletions(rec, req)
		return rec.Code
	}
	done := make(chan int)
	go func() { done <- call() }()
	<-reached
	// v2 becomes effective while the first request is in flight. As-of-START
	// resolution must still bill it at v1 (spec §6).
	tests.InsertPricingRule(t, dsn, env.ModelID, 2, "300000.000000", "600000.000000", time.Now())
	close(gate)
	if code := <-done; code != http.StatusOK {
		t.Fatalf("first request status = %d, want 200", code)
	}
	first := tests.LastRequestLog(t, dsn, env.APIKeyID)
	if first.InputPriceMicro == nil || *first.InputPriceMicro != "150000.000000" {
		t.Errorf("first input_price_micro = %v, want 150000.000000 — the snapshot is taken at request start, not at finish", first.InputPriceMicro)
	}
	if first.Cost != 6 { // per-class half-up (cost.Compute): 1.65->2 + 4.2->4 = 6 micro
		t.Errorf("first cost = %d, want 6 at v1 prices", first.Cost)
	}
	// A request STARTING now sees v2 — history stays, new work is priced live.
	if code := call(); code != http.StatusOK {
		t.Fatalf("second request status = %d, want 200", code)
	}
	second := tests.LastRequestLog(t, dsn, env.APIKeyID)
	if second.ID == first.ID {
		t.Fatal("second request wrote no new row")
	}
	if second.InputPriceMicro == nil || *second.InputPriceMicro != "300000.000000" {
		t.Errorf("second input_price_micro = %v, want 300000.000000 (the effective version)", second.InputPriceMicro)
	}
	if second.Cost != 7 { // per-class half-up (cost.Compute): 3.3->3 + 4.2->4 = 7 micro
		t.Errorf("second cost = %d, want 7 at v2 prices", second.Cost)
	}
	// The literal acceptance: the earlier row is unchanged after the price change.
	frozen := tests.RequestLogByID(t, dsn, first.ID)
	if frozen.InputPriceMicro == nil || *frozen.InputPriceMicro != "150000.000000" || frozen.Cost != 6 {
		t.Errorf("the v1 row was rewritten by the price change: price=%v cost=%d", frozen.InputPriceMicro, frozen.Cost)
	}
}

func TestFailoverRecordsTwoAttemptsAndFallback(t *testing.T) {
	dsn := tests.RequireDB(t)
	var goodHits int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(r.Header.Get("Authorization"), "good") {
			atomic.AddInt32(&goodHits, 1)
			_, _ = w.Write([]byte(`{"id":"x","object":"chat.completion","model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"PONG"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}`))
			return
		}
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"message":"rate limit exceeded"}}`))
	}))
	defer up.Close()
	env := tests.SeedEnvAccounts(t, dsn, up.URL, []string{"bad", "good"})
	p := tests.NewProxy(t, dsn, up.URL)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"`+env.Slug+`","messages":[{"role":"user","content":"say OK"}],"max_tokens":8}`))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	req.Header.Set("Content-Type", "application/json")
	p.ServeCompletions(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s — the 429 did not fail over", rec.Code, rec.Body.String())
	}
	if atomic.LoadInt32(&goodHits) != 1 {
		t.Fatalf("healthy account saw %d requests, want 1", goodHits)
	}
	log := tests.LastRequestLog(t, dsn, env.APIKeyID)
	if log.Attempts != 2 {
		t.Errorf("request_log.attempts = %d, want 2", log.Attempts)
	}
	if !log.FallbackUsed {
		t.Error("fallback_used = false after a 429-then-200 failover (spec §8)")
	}
	attempts := tests.AttemptRecs(t, dsn, log.ID)
	if len(attempts) != 2 {
		t.Fatalf("request_attempt rows = %d, want exactly one per exchange (spec §8)", len(attempts))
	}
	first, second := attempts[0], attempts[1]
	if first.Attempt != 1 || second.Attempt != 2 {
		t.Errorf("attempt numbers = %d,%d, want 1,2", first.Attempt, second.Attempt)
	}
	if first.HTTPStatus == nil || *first.HTTPStatus != http.StatusTooManyRequests {
		t.Errorf("attempt 1 http_status = %v, want 429", first.HTTPStatus)
	}
	if first.ErrorCode == "" {
		t.Error("attempt 1 recorded no error_code — the failed exchange must be classified (spec §8)")
	}
	if first.Retryable == nil || !*first.Retryable {
		t.Error("attempt 1 retryable = false — 429 is in the spec §9 retry set, and this request DID retry")
	}
	if first.Reason == "" {
		t.Error("attempt 1 has no reason — spec §8 records why the candidate won")
	}
	if second.ErrorCode != "" {
		t.Errorf("attempt 2 error_code = %q, want empty (it succeeded)", second.ErrorCode)
	}
	if second.HTTPStatus == nil || *second.HTTPStatus != http.StatusOK {
		t.Errorf("attempt 2 http_status = %v, want 200", second.HTTPStatus)
	}
}
