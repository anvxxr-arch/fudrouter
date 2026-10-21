package store_test

// A retry chain must cost ONE round trip for its attempts, not one per attempt.
//
// Why this file exists: finish() wrote request_attempt rows in a loop — one
// insert per attempt — so a request that fell over three candidates paid three
// sequential round trips AFTER the client already had its answer. A retry chain
// is exactly when the router is behind, so that was the worst place to make cost
// proportional to the thing going wrong.

import (
	"context"
	"crypto/rand"
	"strconv"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

func TestAttemptsAreOneQuery(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	s, tr := startCounting(t, dsn)
	ctx := context.Background()
	// Per-run ids: a fixed id would collide with a row left by a killed run, and
	// ChargeRequest's ON CONFLICT DO NOTHING would then make the test read back
	// rows it never wrote.
	gateID := "rql_gate_" + randSuffix()
	longID := "rql_long_" + randSuffix()
	seedRequestLog(t, s, env, gateID, longID)

	mk := func(n int) []*store.RequestAttempt {
		rows := make([]*store.RequestAttempt, 0, n)
		for i := 1; i <= n; i++ {
			rows = append(rows, &store.RequestAttempt{
				ID:        "rta_gate_" + gateID + "_" + itoa(i),
				RequestID: gateID,
				Attempt:   i,
				Reason:    "initial",
				Metadata:  map[string]any{"upstream_model": "m"},
			})
		}
		return rows
	}

	// An empty slice is not a statement at all.
	tr.Reset()
	if err := s.InsertRequestAttempts(ctx, nil); err != nil {
		t.Fatalf("empty: %v", err)
	}
	if got := tr.Count(); got != 0 {
		t.Errorf("empty batch issued %d queries, want 0", got)
	}

	for _, n := range []int{1, 3, 8} {
		tr.Reset()
		if err := s.InsertRequestAttempts(ctx, mk(n)); err != nil {
			t.Fatalf("n=%d: %v", n, err)
		}
		if got := tr.Count(); got != 1 {
			t.Errorf("n=%d attempts issued %d queries, want 1", n, got)
		}
	}

	// The idempotency the single-row form had, through the same ON CONFLICT
	// (request_id, attempt) DO NOTHING: a replay must not duplicate rows.
	before := attemptCount(t, ctx, s, gateID)
	if err := s.InsertRequestAttempts(ctx, mk(3)); err != nil {
		t.Fatalf("replay: %v", err)
	}
	if after := attemptCount(t, ctx, s, gateID); after != before {
		t.Errorf("replay changed the attempt count: %d -> %d", before, after)
	}
	if before != 8 {
		t.Errorf("attempt rows = %d, want the 8 distinct attempts written", before)
	}
}

// A chain longer than the per-statement bound is written in full, just in more
// round trips — never silently truncated.
func TestLongAttemptChainIsNotTruncated(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	s, tr := startCounting(t, dsn)
	ctx := context.Background()
	longID := "rql_long_" + randSuffix()
	seedRequestLog(t, s, env, longID)

	const n = 70 // more than maxAttemptsPerInsert (32)
	rows := make([]*store.RequestAttempt, 0, n)
	for i := 1; i <= n; i++ {
		rows = append(rows, &store.RequestAttempt{
			ID:        "rta_long_" + longID + "_" + itoa(i),
			RequestID: longID,
			Attempt:   i,
			Reason:    "failover",
		})
	}
	tr.Reset()
	if err := s.InsertRequestAttempts(ctx, rows); err != nil {
		t.Fatalf("long chain: %v", err)
	}
	// Read the query count BEFORE attemptCount, whose own `select count(*)` would
	// otherwise be counted and make the bound look one statement looser.
	queries := tr.Count()
	// ceil(70/32) = 3 statements.
	if queries != 3 {
		t.Errorf("long chain issued %d queries, want 3 (ceil(70/32))", queries)
	}
	if got := attemptCount(t, ctx, s, longID); got != n {
		t.Errorf("wrote %d of %d attempts — a long chain was truncated", got, n)
	}
}

func attemptCount(t *testing.T, ctx context.Context, s *store.Store, requestID string) int {
	t.Helper()
	n, err := s.AttemptCount(ctx, requestID)
	if err != nil {
		t.Fatalf("attempt count: %v", err)
	}
	return n
}

// seedRequestLog writes the parent rows the attempt FK needs. request_attempt
// carries `request_id references request_log(id)`, so a batch of attempts cannot
// be exercised without a request row to hang them off — which the earlier,
// single-row attempt test happened to already have.
//
// It deletes what it wrote rather than relying on a fixed id: ChargeRequest is
// ON CONFLICT DO NOTHING, so a run killed mid-test would leave the row behind and
// the NEXT run would silently reuse it — a batch that never inserted would still
// read back as written. A per-run suffix plus an explicit delete keeps the ids
// distinct and the keyspace clean.
func seedRequestLog(t *testing.T, s *store.Store, env *tests.Env, ids ...string) {
	t.Helper()
	ctx := context.Background()
	for _, id := range ids {
		row := &store.RequestLog{
			ID: id, UserID: env.UserID, APIKeyID: env.APIKeyID, ModelID: env.ModelID,
			TokensIn: 1, TokensOut: 1, Cost: 1, Currency: "USD", Status: "success",
		}
		id := id
		t.Cleanup(func() {
			// attempts first: the FK is ON DELETE CASCADE but being explicit keeps
			// the intent readable, and api_key_id is the seeder's own handle.
			_, _ = s.DeleteRequestLogForTest(context.Background(), id)
		})
		if _, err := s.ChargeRequest(ctx, row); err != nil {
			t.Fatalf("seed request_log %s: %v", id, err)
		}
	}
}

// randSuffix is a short per-run token for fixture ids. The store's own randChars
// lives in the non-test build, so a test needs its own source of uniqueness.
func randSuffix() string {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	const alpha = "abcdefghijklmnopqrstuvwxyz0123456789"
	out := make([]byte, len(b))
	for i, x := range b {
		out[i] = alpha[int(x)%len(alpha)]
	}
	return string(out)
}

// itoa is a local tiny formatter: the store package's is unexported and this
// file only needs it for fixture ids.
func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b [20]byte
	p := len(b)
	neg := i < 0
	if neg {
		i = -i
	}
	for i > 0 {
		p--
		b[p] = byte('0' + i%10)
		i /= 10
	}
	if neg {
		p--
		b[p] = '-'
	}
	return string(b[p:])
}
