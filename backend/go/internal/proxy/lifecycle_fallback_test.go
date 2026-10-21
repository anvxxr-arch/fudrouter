package proxy

// The recovery inserts must run on LIVE contexts.
//
// Why this file exists: finish() built one 5s context and reused it for both
// the charge and the fallback. An expired context never revives, so whenever
// the charge timed out — the exact failure the fallback exists to repair —
// Begin(ctx) failed instantly and the request_log + credit_ledger row was lost
// after the client already had its 200. The load test reproduced it only under
// DB contention (116/120, four rows unbilled); this gate is deterministic.
//
// The store is a real *store.Store pointed at a listener that accepts and never
// answers. The primary charge dials once and hangs until its budget expires;
// the only way a SECOND connection can appear is the fallback dialing with a
// live context — net.Dialer refuses an already-expired context without
// connecting. No database, no contention, no sleeps.
//
// The attempts insert is pinned the same way, and the pin is sharper than the
// fallback's: the fallback's connection is HELD until its own budget expires,
// so by the time the attempts insert runs, ledgerCtx (the fallback's context)
// is dead too. A lifecycle carrying one attempt must therefore produce a THIRD
// dial — primary → fallback → attempts — proving the attempts insert got a
// fresh live context rather than riding the fallback's. Without the hold, a
// revert of the attempts write to ledgerCtx would still dial (the fallback's
// context is still live at that point) and the gate would pass while the
// saturation probe keeps losing 18/144 attempt rows. Cost: two budgets.
//
// Verified by mutation: passing ctx to InsertRequestLogWithLedger turns it red
// (one connection, no fallback dial); passing ledgerCtx to
// InsertRequestAttempts turns it red (two connections, no attempts dial).

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/routing"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
)

func TestFallbackLedgerWriteUsesLiveContext(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	var accepts atomic.Int32
	var mu sync.Mutex
	var held []net.Conn
	t.Cleanup(func() {
		mu.Lock()
		defer mu.Unlock()
		for _, c := range held {
			_ = c.Close()
		}
	})

	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			switch accepts.Add(1) {
			case 1:
				// The primary's dial: hold it open so ChargeRequest blocks
				// until its context expires.
				mu.Lock()
				held = append(held, c)
				mu.Unlock()
			case 2:
				// The fallback's dial: hold this one too. Its context must be
				// DEAD by the time the attempts insert runs, so a revert of
				// that write to ledgerCtx cannot ride a still-live context.
				mu.Lock()
				held = append(held, c)
				mu.Unlock()
			default:
				// The attempts' dial: a live context, proven. Fail it fast so
				// finish() returns instead of burning its whole budget.
				_ = c.Close()
			}
		}
	}()

	// The primary issues exactly one query, so the second accept can only be
	// the fallback's dial and the third only the attempts' dial.
	// connect_timeout must not fire before the contexts do, or the primary
	// would fail early with a live context still.
	dsn := "postgres://u:p@" + ln.Addr().String() +
		"/fallback_ctx_test?pool_min_conns=0&connect_timeout=30"
	st, err := store.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(st.Close)

	lc := relayLifecycle(t, httptest.NewRecorder(),
		httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil))
	lc.h.store = st
	// One attempt so finish() has an insert to make; attemptRow guards the
	// nil Candidate, so a bare attempt is enough.
	lc.attempts = []*routing.Attempt{{Attempt: 1}}

	lc.finish()

	if got := accepts.Load(); got < 3 {
		t.Fatalf("expected 3 dials (primary, fallback, attempts), got %d: "+
			"a recovery write reused an expired context", got)
	}
}
