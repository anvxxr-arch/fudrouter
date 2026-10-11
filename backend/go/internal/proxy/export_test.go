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
	"testing"
	"time"

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
