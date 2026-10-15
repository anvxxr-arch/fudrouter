package cost

// Benchmark for the billing funnel's arithmetic (spec §6, PRD §87/§122).
//
// Why it exists: ComputeUsage runs once per request, on the request's critical
// path, and it runs through math/big on purpose (cost.go's header: the divisor
// is 1e12 and tokens*priceScaled overflows int64 for real prices). A big.Int
// implementation is exactly the kind of thing that invites a "this is cheap
// enough to call N times" refactor, so the per-call cost is pinned rather than
// assumed.
//
// Token counts are 1M-scale on purpose: a 1000-token request costs 0 micro
// (0.15 micro rounds down), so a small fixture would benchmark the early
// return instead of the multiply.

import "testing"

func BenchmarkCostCompute(b *testing.B) {
	// grok-4.6 list price: $2.00/1M in, $6.00/1M out (the real-world fixture
	// cost_test.go already uses), plus the cached and reasoning prices the
	// four-class path needs.
	in := Price("2000000.000000")  // 2e12 scaled
	out := Price("6000000.000000") // 6e12 scaled
	cached := Price("500000.000000")
	reasoning := Price("6000000.000000")

	b.Run("compute-2class", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			// 1M in x $2.00 + 500k out x $6.00 = 2_000_000 + 3_000_000 micro.
			if got := Compute(1_000_000, 500_000, in, out); got != 5_000_000 {
				b.Fatalf("Compute = %d, want 5000000", got)
			}
		}
	})
	b.Run("compute-4class", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			// 1M in + 200k cached + 400k out + 100k reasoning =
			// 2_000_000 + 100_000 + 2_400_000 + 600_000 micro.
			if got := ComputeUsage(1_000_000, 200_000, 400_000, 100_000, in, cached, out, reasoning); got != 5_100_000 {
				b.Fatalf("ComputeUsage = %d, want 5100000", got)
			}
		}
	})
	b.Run("zero-tokens", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			if got := Compute(0, 0, in, out); got != 0 {
				b.Fatalf("Compute = %d, want 0", got)
			}
		}
	})
	b.Run("price-parse", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			if got := Price("2000000.000000"); got != 2000000_000000 {
				b.Fatalf("Price = %d", got)
			}
		}
	})
}
