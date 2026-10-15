package limits_test

// Benchmark for the S0 in-process limiter (spec §12: Valkey DISABLED ->
// in-process enforcement).
//
// Why it exists: this is the fallback path of last resort, and the least
// exercised — a box with VALKEY_URL set never runs it, so nothing catches a
// regression in localLimiter.allow's sliding-window bookkeeping until someone
// deploys without Valkey. Pinning its cost also keeps the "just do the DB sum
// every request instead" temptation honest: the in-process window is cheap.
//
// No Valkey is needed: limits.New(nil) installs the noop client, every call
// returns ErrDisabled, and Check falls through to the in-process limiter.
//
// The limits are unreachable on purpose: a fixed window that rejects mid-run
// would make the benchmark measure the denial path, or fail outright once the
// counter fills (it did — RPM 6000 rejected at iteration 6001).

import (
	"context"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/limits"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
)

func BenchmarkLimiterCheckInProcess(b *testing.B) {
	l := limits.New(nil)
	ctx := context.Background()
	ident := identity("key_bench", &fakeSpend{})

	b.Run("rpm-only", func(b *testing.B) {
		lim := &store.Limits{RPM: ptr(int64(1 << 40))}
		b.ReportAllocs()
		for b.Loop() {
			adm, rej := l.Check(ctx, ident, lim, 0)
			if rej != nil {
				b.Fatalf("rejected: %+v", rej)
			}
			adm.Release()
		}
	})
	b.Run("full-chain", func(b *testing.B) {
		lim := &store.Limits{
			RPM:         ptr(int64(1 << 40)),
			RPD:         ptr(int64(1 << 40)),
			TPM:         ptr(int64(1 << 40)),
			TPD:         ptr(int64(1 << 40)),
			Concurrency: ptr(int64(1 << 20)),
		}
		b.ReportAllocs()
		for b.Loop() {
			adm, rej := l.Check(ctx, ident, lim, 2048)
			if rej != nil {
				b.Fatalf("rejected: %+v", rej)
			}
			adm.Release()
		}
	})
}
