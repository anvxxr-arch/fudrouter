package cost

import "testing"

func TestComputeExact(t *testing.T) {
	// price 150000.000000 micro-USD per 1M input tokens, 600000.000000 output.
	in, out := Price("150000.000000"), Price("600000.000000")
	// 1000 in, 500 out: 1000*150000/1e6 + 500*600000/1e6 = 150 + 300 = 450 micro
	got := Compute(1000, 500, in, out)
	if got != 450 {
		t.Fatalf("cost = %d, want 450", got)
	}
}

func TestComputeZeroTokens(t *testing.T) {
	if Compute(0, 0, Price("150000.000000"), Price("600000.000000")) != 0 {
		t.Fatal("zero tokens must cost zero")
	}
}

func TestComputeRounding(t *testing.T) {
	// 1 token at 150000/1e6 = 0.15 micro -> rounds to 0
	if Compute(1, 0, Price("150000.000000"), Price("0")) != 0 {
		t.Fatal("1 token should round to 0")
	}
	// 3 tokens at 500000/1e6 = 1.5 micro -> rounds to 2 (half up)
	if Compute(3, 0, Price("500000.000000"), Price("0")) != 2 {
		t.Fatal("3 tokens at 500000 should round to 2")
	}
}

func TestPriceParse(t *testing.T) {
	if Price("150000.000000") != 150000_000000 {
		t.Fatalf("Price parse wrong: %d", Price("150000.000000"))
	}
	if Price("0") != 0 {
		t.Fatal("zero price")
	}
}

// Regression for the numeric(18,6) widening. Prices are micro-USD per 1M tokens,
// so a real $2.00/1M upstream stores 2000000.000000 — which the model table
// rejected outright while it was numeric(12,6). The naive int64 form
// tokens*price/1e6 both divides by the wrong constant AND overflows at this
// scale (50M tokens x 2e12 = 1e20 > int64 max), so it must be exact.
func TestComputeLargeRealWorldPrices(t *testing.T) {
	// grok-4.6 list price: $2.00 per 1M in, $6.00 per 1M out.
	in, out := Price("2000000.000000"), Price("6000000.000000")

	// 1M input tokens at $2/1M = $2.00 = 2_000_000 micro-USD
	if got := Compute(1_000_000, 0, in, out); got != 2_000_000 {
		t.Fatalf("1M tokens at $2/1M = %d, want 2000000", got)
	}
	// 500k in + 250k out = $1.00 + $1.50 = $2.50 = 2_500_000 micro-USD
	if got := Compute(500_000, 250_000, in, out); got != 2_500_000 {
		t.Fatalf("got %d, want 2500000", got)
	}
	// a 50M-token request must stay positive, not wrap to a negative int64
	if got := Compute(50_000_000, 50_000_000, in, out); got <= 0 {
		t.Fatalf("overflowed to %d", got)
	}
}
