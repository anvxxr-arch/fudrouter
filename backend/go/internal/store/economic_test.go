package store

import "testing"

// MarkupMicro is the integer money primitive the whole economic layer builds on
// (design §5): cost = (a × markup_millionths + 500_000) / 1_000_000, half-up.
// The multiply runs through math/big so a real COGS × markup cannot overflow
// int64 the way cost.divRound already guards against. These cases pin the
// arithmetic the 0035 CHECK mirrors in SQL (`cost = (provider_cost_micro *
// markup_millionths + 500000) / 1000000`), plus the two zero fast paths and an
// overflow case a naive int64 multiply would wrap.

func TestMarkupMicroArithmetic(t *testing.T) {
	cases := []struct {
		name  string
		a, mm int64
		want  int64
	}{
		{"passthrough 1.0x", 1000, 1_000_000, 1000},
		{"1.3x over 1000", 1000, 1_300_000, 1300},
		{"zero amount", 0, 1_300_000, 0},
		{"zero markup", 1000, 0, 0},
		{"0.75 half-up to 1", 1, 750_000, 1},
		{"1.5 half-up to 2", 2, 750_000, 2},
		{"large COGS x markup must not wrap int64", 9_000_000_000_000, 1_500_000, 13_500_000_000_000},
	}
	for _, c := range cases {
		if got := MarkupMicro(c.a, c.mm); got != c.want {
			t.Errorf("%s: MarkupMicro(%d, %d) = %d, want %d", c.name, c.a, c.mm, got, c.want)
		}
	}
}
