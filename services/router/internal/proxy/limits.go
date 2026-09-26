package proxy

import (
	"context"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/anvxxr-arch/fudrouter/services/router/internal/store"
)

// monthlyCacheTTL is how long a key's month-to-date cost is reused before it is
// re-summed. The counter only moves when a request completes, so a few seconds of
// staleness is harmless, and it keeps a hot key from issuing a SUM per request.
const monthlyCacheTTL = 30 * time.Second

// limiter enforces `api_key.limits`, which the admin console has always written
// ({ rpm, monthly_cost_micro }) but the data plane never read — every key spent
// unbounded. The rpm window is in-process (one router instance); the monthly cost
// is a cached DB sum.
type limiter struct {
	mu     sync.Mutex
	window map[string][]time.Time // api key id -> request timestamps in the last minute

	costMu    sync.Mutex
	costCache map[string]costEntry
}

type costEntry struct {
	micro   int64
	err     error
	expires time.Time
}

func newLimiter() *limiter {
	return &limiter{
		window:    make(map[string][]time.Time),
		costCache: make(map[string]costEntry),
	}
}

// allowRPM records a request against the key's per-minute window and reports
// whether it is still under `rpm`. A non-positive rpm means unlimited.
func (l *limiter) allowRPM(keyID string, rpm int) bool {
	if rpm <= 0 {
		return true
	}
	now := time.Now()
	cutoff := now.Add(-time.Minute)

	l.mu.Lock()
	defer l.mu.Unlock()

	ts := l.window[keyID]
	i := 0
	for i < len(ts) && ts[i].Before(cutoff) {
		i++
	}
	if i > 0 {
		ts = append([]time.Time(nil), ts[i:]...)
	}
	if len(ts) >= rpm {
		l.window[keyID] = ts
		return false
	}
	l.window[keyID] = append(ts, now)
	return true
}

// monthlyUsedMicro returns the key's month-to-date cost, cached briefly.
func (l *limiter) monthlyUsedMicro(ctx context.Context, st *store.Store, keyID string) (int64, error) {
	l.costMu.Lock()
	if e, ok := l.costCache[keyID]; ok && time.Now().Before(e.expires) {
		l.costMu.Unlock()
		return e.micro, e.err
	}
	l.costMu.Unlock()

	micro, err := st.MonthlyCostMicro(ctx, keyID)

	l.costMu.Lock()
	l.costCache[keyID] = costEntry{micro: micro, err: err, expires: time.Now().Add(monthlyCacheTTL)}
	l.costMu.Unlock()
	return micro, err
}

// checkLimits returns the HTTP status and message to reject with, or 0 when the
// request is within its limits. A limit-check error never blocks the request —
// failing open on a DB hiccup beats failing every request closed.
func (h *Handler) checkLimits(ctx context.Context, k *store.APIKeyRow) (int, string) {
	if k == nil {
		return 0, ""
	}
	if k.RPM != nil && !h.limits.allowRPM(k.ID, *k.RPM) {
		return http.StatusTooManyRequests, "rate limit exceeded: too many requests per minute"
	}
	if k.MonthlyCostMicro != nil && *k.MonthlyCostMicro > 0 {
		used, err := h.limits.monthlyUsedMicro(ctx, h.store, k.ID)
		if err != nil {
			log.Printf("[proxy] monthly cost lookup failed for key %s: %v", k.ID, err)
		} else if used >= *k.MonthlyCostMicro {
			return http.StatusPaymentRequired, "monthly cost cap reached for this API key"
		}
	}
	return 0, ""
}
