package store

// Test-only access to the query-tracer seam (store.go's testQueryTracerHook).
//
// Why it is a hook and not a field on Store: pgxpool freezes a connection's
// options when it is created, so a tracer has to be installed before the pool
// opens its first connection. New consults the hook and production never sets
// it — pgxpool.New(nil tracer) is 1.9 ns/op (BenchmarkNewNoTracer), which is
// why this needs no build tag.
//
// CounterTracer is deliberately manual: go vet's copylocks rejects a value
// receiver on a sync.Mutex field, and the counters must not be allowed to be
// copied by accident in a test that passes the tracer around.

import (
	"context"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// DeleteRequestLogForTest removes one request_log row (and, by cascade, its
// request_attempt rows) by id. Test-only: the batch contract tests write request
// rows to satisfy request_attempt's FK and must not leave them behind, because
// ChargeRequest is ON CONFLICT DO NOTHING and a stale row would make a later run
// read its attempts back as written even if the batch never ran.
func (s *Store) DeleteRequestLogForTest(ctx context.Context, id string) (int64, error) {
	tag, err := s.pool.Exec(ctx, `delete from request_log where id = $1`, id)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// SetAdmissionTTLForTest shortens the admission cache's TTLs so a test can watch
// an entry expire without sleeping out the production gateTTL (5s) or policyTTL
// (60s). Both are read under the cache's own lock, so this is race-free against
// a concurrent request path.
func (s *Store) SetAdmissionTTLForTest(accountTTL, policy time.Duration) {
	s.admission.mu.Lock()
	s.admission.ttl = accountTTL
	s.admission.policyTTLOverride = policy
	s.admission.mu.Unlock()
}

// CounterTracer counts the queries a store issues, so a test can assert a
// query-count contract (head "one round trip") instead of inferring it from
// timings that sit inside their own noise band.
type CounterTracer struct {
	mu    sync.Mutex
	n     int
	texts []string
}

// SetQueryTracer installs a tracer for every Store New creates after this call
// and returns a func that removes it. Package-global on purpose: the seam is
// only reachable from tests, and a test that wants per-store control calls
// store.New itself.
func SetQueryTracer(t pgx.QueryTracer) (restore func()) {
	prev := testQueryTracerHook
	testQueryTracerHook = func() pgx.QueryTracer { return t }
	return func() { testQueryTracerHook = prev }
}

// Count returns how many queries have been traced.
func (c *CounterTracer) Count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.n
}

// Reset zeroes the counter (and the recorded texts).
func (c *CounterTracer) Reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.n = 0
	c.texts = nil
}

// Texts returns the SQL of every traced query, in order — what a failure
// message needs to show which extra round trip appeared.
func (c *CounterTracer) Texts() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.texts...)
}

func (c *CounterTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	c.mu.Lock()
	c.n++
	c.texts = append(c.texts, data.SQL)
	c.mu.Unlock()
	return ctx
}

func (c *CounterTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}
