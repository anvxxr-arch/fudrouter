package store

import (
	"context"
	"time"
)

// frsubs rolling quota (economic layer F5): the fair-use stop-loss on the
// flat-fee subscription bucket. The meter is RETAIL-EQUIVALENT — it reads
// request_log.quota_usage_micro, never the customer charge — because a frsubs
// request debits cost=0 (its revenue arrives once per period via
// credit_purchase/payment), so a counter over credit_charged_micro/cost would
// count every frsubs request as free and the quota could never be exhausted.
//
// These two functions are the durable half of the quota gate. The fast path is
// a Valkey counter (proxy/budget.go); a missing counter falls back here, and an
// error here refuses the request (fail-closed) rather than admitting unbounded
// paid spend — deliberately unlike the token rate limiter, which degrades
// open, because this gate bounds SPEND, not rate.

// QuotaLimits returns the effective frsubs quota limits keyed by quota_window
// ("5h"/"7d") from bucket_quota. A bucket other than frsubs has no rolling
// quota, so it returns an empty map with no error — the caller treats "no
// window" as "no gate", not as a failure to read.
//
// bucket_quota is versioned by (bucket, quota_window, version): a bump inserts
// a newer version row (with its own effective_from) instead of mutating the
// old limit, so the historical limits stay reproducible. `distinct on
// (quota_window) ... order by version desc` therefore keeps the newest
// effective version per window when two overlap; keep that ordering or an
// effective-until edit could silently resurrect an old limit.
func (s *Store) QuotaLimits(ctx context.Context, bucket Bucket) (map[string]int64, error) {
	if bucket != BucketSubs {
		return map[string]int64{}, nil
	}
	rows, err := s.pool.Query(ctx, `
		select distinct on (quota_window) quota_window, limit_micro_usd
		from bucket_quota
		where bucket = $1
		  and effective_from <= now()
		  and (effective_until is null or effective_until > now())
		order by quota_window, version desc`, string(bucket))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[string]int64{}
	for rows.Next() {
		var window string
		var limit int64
		if err := rows.Scan(&window, &limit); err != nil {
			return nil, err
		}
		out[window] = limit
	}
	return out, rows.Err()
}

// SpendQuotaMicro is the durable frsubs usage aggregate: the sum of
// quota_usage_micro since `since`, for the rows that actually consumed tokens
// (success or cancelled — a cancelled stream may still have a complete
// provider usage block, and that usage is exactly the fair-use this meter
// exists to bound).
//
// The IS NOT NULL predicate is load-bearing, not defensive: the column is NULL
// for every non-frsubs bucket and for legacy rows written before the meter
// existed, and NULL must not poison the sum. It also lets this query use the
// partial index request_log_user_quota_idx (… WHERE quota_usage_micro IS NOT
// NULL) instead of scanning the user's whole ledger. coalece keeps the result
// 0 (not NULL) when the user has no metered rows yet, so the gate's arithmetic
// never needs a NULL special case.
func (s *Store) SpendQuotaMicro(ctx context.Context, userID string, since time.Time) (int64, error) {
	var v int64
	err := s.pool.QueryRow(ctx, `
		select coalesce(sum(quota_usage_micro), 0)::bigint
		from request_log
		where user_id = $1
		  and created_at >= $2
		  and status in ('success','cancelled')
		  and quota_usage_micro is not null`, userID, since).Scan(&v)
	return v, err
}
