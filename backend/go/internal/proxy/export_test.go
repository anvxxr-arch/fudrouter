package proxy

// Test-only hooks. This file is compiled into the package's test binary and
// never into the production build, so anything exported here is invisible to
// main.go.
//
// It exists because the tests for the generic path's upstream bound need to
// shorten genericTimeout from two minutes to something they can wait for, and
// the test file itself has to live in proxy_test (not package proxy) to reuse
// the shared seeder in the tests package — which imports proxy, so an internal
// test in package proxy cannot import it back without an import cycle. This
// export is the standard way out of that: the unexported knob is opened here,
// and the external test drives it through SetGenericTimeoutForTest.

import (
	"context"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/ids"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/routing"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/jackc/pgx/v5"
)

// SetGenericTimeoutForTest overrides the generic path's body-read bound and
// returns a function that restores the previous value. Production never calls
// this; it exists so a test can verify the bound actually fires in under a
// second instead of two minutes.
func SetGenericTimeoutForTest(d time.Duration) (restore func()) {
	prev := genericTimeout
	genericTimeout = d
	return func() { genericTimeout = prev }
}

// ClampTokensForTest exposes the token clamp applied at the billing funnel.
//
// The clamp is the defence against an upstream that reports a NEGATIVE token
// count: cost would go negative, which *lowers* the month's total and lets a key
// walk past its monthly_cost_micro cap. It lived entirely untested, and it is
// the one function in the package where a silent regression directly loses
// money, so it gets a direct unit test rather than only end-to-end coverage.
func ClampTokensForTest(n int64) int64 { return clampTokens(n) }

// MaxTokensPerRequestForTest reports the ceiling the clamp forces counts into.
func MaxTokensPerRequestForTest() int64 { return maxTokensPerRequest }

// CheckBudgetsForTest runs the admission budget gate for one key, exactly as
// begin does — the exported door onto the unexported method, so the budget
// benchmarks measure the real gate instead of a re-implementation.
func (h *Handler) CheckBudgetsForTest(ctx context.Context, key *store.APIKeyRow) error {
	return h.checkBudgets(ctx, &lifecycle{h: h, key: key})
}

// BilledCostForTest reports the cost stored for `env`'s most recent request_log
// row, so a test can prove what was actually billed.
//
// Exported here rather than added to the `tests` package because the proxy test
// files already import `tests`, and `tests` cannot import `proxy` — the same
// asymmetry export_test.go exists to work around.
func BilledCostForTest(t *testing.T, dsn string, apiKeyID string) (tokensIn, tokensOut, costMicro int64) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	// id is the tie-break: request_log has no sub-second guarantee, and two rows
	// inserted in the same millisecond would otherwise make "the last row"
	// arbitrary.
	err = conn.QueryRow(ctx,
		`select tokens_in, tokens_out, cost from request_log
		 where api_key_id = $1 order by created_at desc, id desc limit 1`, apiKeyID).
		Scan(&tokensIn, &tokensOut, &costMicro)
	if err != nil {
		t.Fatalf("last request_log row: %v", err)
	}
	return tokensIn, tokensOut, costMicro
}

// FillCandidatePricingForTest drives the per-candidate pricing pass directly.
//
// It exists because the measurement that justified batching it needs a Handler
// and a candidate slice but NO seeded database: the cost under test is the
// Valkey round trip per candidate, and the state that matters — a COLD cache,
// where each miss also becomes a pricing DB read — cannot be produced through a
// public path without a live DSN, which package proxy cannot obtain (it cannot
// import `tests`, which imports proxy).
func (h *Handler) FillCandidatePricingForTest(ctx context.Context, merged []routing.Candidate) {
	h.fillCandidatePricing(ctx, merged)
}

// deadStoreDSN points at a port nothing listens on. store.New parses the DSN
// and builds the pool without dialing, so this costs a fraction of a
// millisecond and makes finish()'s ledger write fail fast (measured ~1ms)
// instead of hanging — which is what lets the relay be gated without a
// database.
const deadStoreDSN = "postgres://u:p@127.0.0.1:1/stream_ttft_test?pool_min_conns=0"

// relayLifecycle builds the minimum lifecycle a relay loop needs: a writer, a
// request (for clientIP and the detached ledger context), and a store whose
// writes fail fast. Everything else the relays touch — attempts, pricing, the
// limiter — is nil because a relay that never dispatched has none of them, and
// buildRow guards each one.
func relayLifecycle(t *testing.T, w http.ResponseWriter, r *http.Request) *lifecycle {
	t.Helper()
	st, err := store.New(context.Background(), deadStoreDSN)
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(st.Close)
	return &lifecycle{
		h:         &Handler{store: st},
		r:         r,
		w:         w,
		start:     time.Now(),
		requestID: ids.New("req"),
		timing:    map[string]int64{},
	}
}

// SetPoolBuildHookForTest installs fn inside poolFor's build() and returns a
// restore function. Production never calls this: the hook exists so the H2
// race test can hold every poolFor racer inside the rebuild window
// simultaneously — the same override-a-knob pattern as
// SetGenericTimeoutForTest above.
func SetPoolBuildHookForTest(fn func()) (restore func()) {
	old := poolBuildHook
	poolBuildHook = fn
	return func() { poolBuildHook = old }
}

// StreamSSEForTest drives the [OI] chat relay loop directly.
//
// It exists because the property under test — the first event reaches the
// client before the upstream finishes — lives entirely inside the relay loop,
// while every public path to it (ServeCompletions) runs admission first: auth,
// limits, budget and model resolution all need a seeded database. A gate that
// had to seed a database to assert a property of the copy loop would be skipped
// on every DB-less run, which is most of them.
//
// The wiring that CHOOSES the streaming branch (proxy.go:313-316) is not
// covered here — that is what the DB-backed tests exercise.
func StreamSSEForTest(t *testing.T, w http.ResponseWriter, r *http.Request, body io.Reader) {
	t.Helper()
	relayLifecycle(t, w, r).streamSSE(w, body)
}

// AnthropicStreamSSEForTest drives the Anthropic relay loop directly, for the
// same reason as StreamSSEForTest: the flush-per-line shape is duplicated
// rather than shared, so a buffering regression lands in one relay and the
// other must still be pinned.
func AnthropicStreamSSEForTest(t *testing.T, w http.ResponseWriter, r *http.Request, body io.Reader) {
	t.Helper()
	relayLifecycle(t, w, r).anthropicStreamSSE(w, body, "test-model")
}
