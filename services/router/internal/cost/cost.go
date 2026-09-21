// Package cost computes request cost in integer micro-units of the model's currency.
//
// Prices are numeric(18,6): MINOR currency units per 1M tokens.
// Price("150000.000000") == 150000 micro-USD per 1M input tokens ($0.15/1M).
// Internally scaled by 1e6 so a price's fractional part survives while every
// intermediate stays integer — no float ever touches money.
//
// Compute therefore divides by 1e12: 1e6 tokens for the price's "per 1M" unit,
// times the 1e6 internal scale. Two things make the naive int64 form unsafe here:
//
//  1. The divisor is 1e12, not 1e6. Dividing by 1e6 returns 1e6x the true cost.
//  2. tokens*priceScaled overflows int64 for real inputs. A 50M-token request
//     against grok-4.6 ($2.00/1M -> 2e12 scaled) is 1e20, and int64 tops out at
//     9.22e18. The model table was widened to numeric(18,6) precisely so those
//     real prices fit, which is what makes this reachable.
//
// So the multiply/divide runs through math/big: exact at any legal input, and
// the cost is a couple of big.Int ops per request, not per token.
package cost

import (
	"math/big"
	"strconv"
	"strings"
)

const (
	scale = 1_000_000
	// denominator = tokens-per-1M x internal scale
	denominator = 1_000_000 * 1_000_000
)

// Price parses a numeric(18,6) string into an int64 scaled by 1e6.
func Price(s string) int64 {
	s = strings.TrimSpace(s)
	i := strings.IndexByte(s, '.')
	if i < 0 {
		v, _ := strconv.ParseInt(s, 10, 64)
		return v * scale
	}
	intPart := s[:i]
	frac := s[i+1:]
	for len(frac) < 6 {
		frac += "0"
	}
	if len(frac) > 6 {
		frac = frac[:6]
	}
	v, _ := strconv.ParseInt(intPart, 10, 64)
	f, _ := strconv.ParseInt(frac, 10, 64)
	return v*scale + f
}

// Compute returns total cost in micro-units: tokens x price / 1e12, half-up.
// Tokens and prices are non-negative by construction.
func Compute(tokensIn, tokensOut int64, priceIn, priceOut int64) int64 {
	return divRound(tokensIn, priceIn) + divRound(tokensOut, priceOut)
}

func divRound(tokens, price int64) int64 {
	if tokens == 0 || price == 0 {
		return 0
	}
	var n big.Int
	n.Mul(big.NewInt(tokens), big.NewInt(price))
	n.Add(&n, big.NewInt(denominator/2)) // half-up
	n.Quo(&n, big.NewInt(denominator))
	return n.Int64()
}
