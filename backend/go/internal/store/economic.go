package store

import "math/big"

// The economic layer (docs/specs/2026-11-08-economic-layer-design.md §3–§5)
// separates three money questions that must never be conflated:
//
//   - what the CUSTOMER pays (request_log.cost, after markup),
//   - what WE pay the provider (request_log.provider_cost_micro, three-valued),
//   - which bucket the request was sold under (request_log.bucket).
//
// The bucket decides which of those are even meaningful: a flat-fee bucket has
// no per-request revenue and no per-token COGS, so writing the customer charge
// into provider_cost_micro (the old `row.ProviderCostMicro = row.Cost`) was a
// lie. These named types make that vocabulary explicit, so a wrong basis cannot
// be passed around as a bare string.

// Bucket is the canonical economic class a request is sold under. The effective
// bucket is resolved once at admission with the precedence (design §3.1):
// live subscription → api_key.economic_bucket → billing_account.bucket → frpayg.
type Bucket string

const (
	// BucketCheap is the flat-fee farm bucket: near-zero marginal supply cost.
	BucketCheap Bucket = "frcheap"
	// BucketPayg is the prepaid, per-token metered bucket.
	BucketPayg Bucket = "frpayg"
	// BucketSubs is the flat-fee subscription bucket (time-based, not token).
	BucketSubs Bucket = "frsubs"
)

// BillingBasis records which price list produced the CUSTOMER charge
// (request_log.billing_basis). `provider` means the charge was derived from
// real provider COGS plus a markup; `retail` means the published retail price
// was used as a passthrough because no COGS exists. Markup is only ever legal
// on `provider` (the 0035 CHECK enforces it).
type BillingBasis string

const (
	BasisRetail   BillingBasis = "retail"
	BasisProvider BillingBasis = "provider"
)

// CostBasis records the PROVENANCE of request_log.provider_cost_micro.
//
// Three-valued COGS is the whole point (design §4.3): `farm_zero` writes a real
// 0 because the credential is proven farmed, so the marginal cost is zero,
// while `subscription_flat` and `retail`/`unknown` write NULL — the flat plan
// was already paid, and an unknown COGS is not zero. Collapsing NULL to 0 is
// exactly the bug the CHECK constraints reject (test T4).
type CostBasis string

const (
	CostFarmZero CostBasis = "farm_zero"
	CostSubFlat  CostBasis = "subscription_flat"
	CostProvider CostBasis = "provider"
	CostRetail   CostBasis = "retail"
	CostUnknown  CostBasis = "unknown"
)

// MarkupMicro applies a markup expressed in millionths (1_000_000 = 1.0x) to a
// micro-unit amount: (a*mm + 500_000) / 1_000_000, half-up.
//
// The multiply runs through math/big, not int64: real COGS times a markup
// overflows int64 for large requests — the same overflow cost.divRound already
// guards against. Inputs are non-negative by construction (token counts are
// clamped upstream and bucket_margin.markup_millionths has CHECK >= 0), so the
// truncated Quo is a floor here.
func MarkupMicro(a, mm int64) int64 {
	if a == 0 || mm == 0 {
		return 0
	}
	var n big.Int
	n.Mul(big.NewInt(a), big.NewInt(mm))
	n.Add(&n, big.NewInt(500_000)) // half-up
	n.Quo(&n, big.NewInt(1_000_000))
	return n.Int64()
}
