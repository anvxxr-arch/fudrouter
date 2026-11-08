package store

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// ResolveBucket returns the effective economic bucket for an authenticated key,
// per precedence K2 (design §3.1):
//
//	live subscription → subscription.economic_bucket   (latest expiry wins)
//	else             → api_key.economic_bucket        (per-key override)
//	else             → billing_account.bucket          (account canonical)
//	else             → frpayg (PAYG metered — the S0 default)
//
// An empty or NULL column means "not set HERE" and falls through to the next
// layer — never to an error — so a key owned by an account with a bucket but no
// override still resolves the account bucket, and an account-less S0 tenant
// resolves frpayg. The precedence is subscription-first because a paid
// time-window is the member's most recent, specific buying intent and must not
// be silently demoted by a stale key or account default the operator set long
// before the payment (K2: SeniorA + OptA).
//
// It is resolved in ONE round trip (three scalar subqueries) because the design
// (§3.1) resolves it at admission — once per request, cached 60s beside the key
// — and three sequential queries would triple the admission latency; the scalar
// subqueries also keep the "latest expiry wins" ordering (LiveSubscription's
// semantics, subscription.go) and the empty/NULL fallthrough in Go, where the
// precedence is explicit rather than buried in a COALESCE chain that would be
// wrong the moment a layer stores an explicit empty string.
func (s *Store) ResolveBucket(ctx context.Context, key *APIKeyRow) (Bucket, error) {
	if key == nil {
		return BucketPayg, nil
	}
	var subB, keyB, acctB *string
	err := s.pool.QueryRow(ctx, `
		select
		  (select economic_bucket from subscription
		     where account_id = $1 and status = 'active' and expires_at > now()
		     order by expires_at desc limit 1),
		  (select economic_bucket from api_key where id = $2),
		  (select bucket from billing_account where user_id = $1)`,
		key.UserID, key.ID,
	).Scan(&subB, &keyB, &acctB)
	if err != nil {
		return "", err
	}
	if b := nonEmpty(subB); b != "" {
		return Bucket(b), nil
	}
	if b := nonEmpty(keyB); b != "" {
		return Bucket(b), nil
	}
	if b := nonEmpty(acctB); b != "" {
		return Bucket(b), nil
	}
	return BucketPayg, nil
}

// nonEmpty dereferences a nullable column and trims whitespace so a
// whitespace-only value counts as "not set", matching the design's "kolom
// kosong/NULL → lanjut ke lapis berikut" (an empty string and a NULL are the
// same fallthrough signal at every layer).
func nonEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return strings.TrimSpace(*s)
}

// ResolveBucketMargin returns the markup (in millionths, 1_000_000 = 1.0)
// applied to real COGS for one (bucket, model, provider_model) — falling back
// to 1_000_000 (no markup, passthrough) when no bucket_margin row applies.
//
// The fallback is 1.0, NOT 0: markup is a multiplier over provider cost, so a
// missing rule must leave the COGS unchanged (cost = pc × 1.0), never zero it —
// a 0 multiplier would make the customer's charge 0 while the provider still
// bills us, which is exactly the money leak the markup layer exists to prevent.
//
// Ordering mirrors ResolvePricing: a provider_model-specific margin beats a
// model-wide one, then the newest effective_from wins. Unlike the cost rule the
// provider_model dimension is nullable at the ROW level here (a margin may be
// set for a whole model family, not just one upstream mapping), so the
// `(provider_model_id = $3 or provider_model_id is null)` predicate lets a wide
// row still match when the caller has a specific provider_model but no specific
// margin exists for it.
func (s *Store) ResolveBucketMargin(ctx context.Context, bucket Bucket, modelID, providerModelID string, at time.Time) (int64, error) {
	var mm int64
	err := s.pool.QueryRow(ctx, `
		select markup_millionths
		from bucket_margin
		where bucket = $1
		  and model_id = $2
		  and (provider_model_id = $3 or provider_model_id is null)
		  and effective_from <= $4
		  and (effective_until is null or effective_until > $4)
		order by (provider_model_id is not null) desc, effective_from desc
		limit 1`, string(bucket), modelID, providerModelID, at,
	).Scan(&mm)
	switch {
	case err == nil:
		return mm, nil
	case errors.Is(err, pgx.ErrNoRows):
		return 1_000_000, nil
	default:
		return 0, err
	}
}
