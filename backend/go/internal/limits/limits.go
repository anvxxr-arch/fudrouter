// Package limits enforces the per-request limit chain (spec §7): effective
// limit = minimum across platform hard limit → workspace → project →
// environment → api_key policy, counted in Valkey on the fast path with the S0
// in-process limiter as fallback.
//
// Two distinct failures have two distinct answers (spec §12):
//
//   - Valkey DISABLED (no VALKEY_URL): the in-process limiter enforces. This is
//     the S0 behaviour and it still protects a single-instance deployment.
//   - Valkey DOWN (a command failed): fail OPEN — allow the request. A cache
//     outage must not become a customer outage; PostgreSQL remains the
//     authoritative record and spend caps are re-verified against it.
package limits

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/vk"
)

// Rejection is a limit denial. HTTPStatus and Code give the caller its
// normalized answer (PRD §88): 429 RATE_LIMITED for throughput caps, 402
// INSUFFICIENT_CREDITS for spend caps.
type Rejection struct {
	HTTPStatus int
	Code       string
	Message    string
}

// Key namespaces (spec §12). Both planes MUST spell them identically.
const (
	nsRate  = "rl"    // rl:{scope}:{id}:rpm|tpm|rpd|tpd
	nsConc  = "conc"  // conc:{scope}:{id}
	nsSpend = "spend" // spend:{scope}:{id}:day|month
)

// Limiter enforces limits for one request at admission time.
type Limiter struct {
	vk vk.Client

	// local is the S0 in-process fallback (per-key sliding window + gauge),
	// used when Valkey is disabled. When Valkey is UP it is idle.
	local localLimiter
}

func New(c vk.Client) *Limiter {
	if c == nil {
		c = noopClient{}
	}
	return &Limiter{vk: c, local: newLocalLimiter()}
}

// noopClient is the "no cache configured at all" client used when a caller
// hands New a nil client (tests, embedded use): everything degrades like a
// disabled Valkey so the in-process limiter takes over.
type noopClient struct{}

func (noopClient) AllowRate(context.Context, string, int, time.Duration) (bool, error) {
	return true, vk.ErrDisabled
}
func (noopClient) IncrConc(context.Context, string, time.Duration) (int64, error) {
	return 0, vk.ErrDisabled
}
func (noopClient) DecrConc(context.Context, string) error      { return vk.ErrDisabled }
func (noopClient) GetJSON(context.Context, string, any, time.Duration) error {
	return vk.ErrDisabled
}
func (noopClient) SetJSON(context.Context, string, any, time.Duration) error {
	return vk.ErrDisabled
}
func (noopClient) Lua(context.Context, string, string, ...any) ([]any, error) {
	return nil, vk.ErrDisabled
}

// Admission is the handle that owns a request's in-flight concurrency slot.
// Release MUST be called exactly once (defer it); it is safe to call when no
// slot was taken.
type Admission struct {
	l        *Limiter
	concKeys []string
	released bool
}

// Release frees every concurrency slot this admission took.
func (a *Admission) Release() {
	if a == nil || a.released {
		return
	}
	a.released = true
	for _, key := range a.concKeys {
		if err := a.l.vk.DecrConc(context.Background(), key); err != nil {
			if errors.Is(err, vk.ErrDisabled) {
				a.l.local.decr(key)
			}
			// A transport error here self-heals via the gauge's TTL; the
			// request is already over and must not be failed for it.
			continue
		}
	}
}

// Check admits or rejects a request against `lim`.
//
// order of the chain: RPM and RPD are counted first (they are the cheapest to
// deny), then TPM/TPD and the spend caps (which need a durable lookup when the
// Valkey counter is missing), then the concurrency gauge (taken last because it
// is the only one that must be released).
//
// tokenEstimate is the caller's expected token count for the TPM/TPD window
// (the router does not count tokens itself, so an estimate or 0 is honest);
// spendMicro is the amount about to be spent against the daily/monthly caps.
func (l *Limiter) Check(ctx context.Context, k *APIKeyIdentity, lim *store.Limits, tokenEstimate int64) (*Admission, *Rejection) {
	if lim == nil {
		return &Admission{l: l}, nil
	}
	id := k.KeyID

	if lim.RPM != nil && *lim.RPM > 0 {
		ok, err := l.allow(ctx, key(nsRate, "api_key", id, "rpm"), int(*lim.RPM), time.Minute, id+"rpm", 1)
		if err == nil && !ok {
			return nil, &Rejection{429, "RATE_LIMITED", "rate limit exceeded: too many requests per minute"}
		}
	}
	if lim.RPD != nil && *lim.RPD > 0 {
		ok, err := l.allow(ctx, key(nsRate, "api_key", id, "rpd"), int(*lim.RPD), 24*time.Hour, id+"rpd", 1)
		if err == nil && !ok {
			return nil, &Rejection{429, "RATE_LIMITED", "rate limit exceeded: too many requests per day"}
		}
	}
	if lim.TPM != nil && *lim.TPM > 0 && tokenEstimate > 0 {
		ok, err := l.allowTokens(ctx, key(nsRate, "api_key", id, "tpm"), *lim.TPM, time.Minute, tokenEstimate, id+"tpm")
		if err == nil && !ok {
			return nil, &Rejection{429, "RATE_LIMITED", "rate limit exceeded: too many tokens per minute"}
		}
	}
	if lim.TPD != nil && *lim.TPD > 0 && tokenEstimate > 0 {
		ok, err := l.allowTokens(ctx, key(nsRate, "api_key", id, "tpd"), *lim.TPD, 24*time.Hour, tokenEstimate, id+"tpd")
		if err == nil && !ok {
			return nil, &Rejection{429, "RATE_LIMITED", "rate limit exceeded: too many tokens per day"}
		}
	}

	adm := &Admission{l: l}

	// Spend caps use the durable sum when the counter is absent (spec §7:
	// "counter loss must never make spending unbounded"). The Valkey counter is
	// the fast path only.
	if lim.DailySpendMicro != nil && *lim.DailySpendMicro > 0 {
		used, err := l.spendMicro(ctx, k, key(nsSpend, "api_key", id, "day"), dayStart, 25*time.Hour, l.storeDaily)
		if err == nil && used >= *lim.DailySpendMicro {
			return nil, &Rejection{402, "INSUFFICIENT_CREDITS", "daily spend cap reached for this API key"}
		}
	}
	if lim.MonthlySpendMicro != nil && *lim.MonthlySpendMicro > 0 {
		used, err := l.spendMicro(ctx, k, key(nsSpend, "api_key", id, "month"), monthStart, 32*24*time.Hour, l.storeMonthly)
		if err == nil && used >= *lim.MonthlySpendMicro {
			return nil, &Rejection{402, "INSUFFICIENT_CREDITS", "monthly spend cap reached for this API key"}
		}
	}

	if lim.Concurrency != nil && *lim.Concurrency > 0 {
		ck := key(nsConc, "api_key", id)
		n, err := l.vk.IncrConc(ctx, ck, time.Minute)
		switch {
		case errors.Is(err, vk.ErrDisabled):
			// In-process fallback: the S0 gauge.
			n2, over := l.local.tryIncr(ck, int(*lim.Concurrency))
			if over {
				return nil, &Rejection{429, "RATE_LIMITED", "concurrency limit exceeded for this API key"}
			}
			_ = n2
			adm.concKeys = append(adm.concKeys, ck)
		case err != nil:
			// Valkey down: fail OPEN, no slot to release.
		default:
			if n > *lim.Concurrency {
				_ = l.vk.DecrConc(ctx, ck) // do not hold the slot we refused
				return nil, &Rejection{429, "RATE_LIMITED", "concurrency limit exceeded for this API key"}
			}
			adm.concKeys = append(adm.concKeys, ck)
		}
	}
	return adm, nil
}

// SpendAdd records completed spend against the daily/monthly counters so the
// next request's fast path sees it. Best-effort: a failure here only makes the
// next check fall back to the DB sum.
func (l *Limiter) SpendAdd(ctx context.Context, k *APIKeyIdentity, micro int64) {
	if micro == 0 || k == nil {
		return
	}
	for _, suffix := range []string{"day", "month"} {
		ck := key(nsSpend, "api_key", k.KeyID, suffix)
		_, err := l.vk.Lua(ctx, `
			local v = redis.call('INCRBY', KEYS[1], ARGV[1])
			if v == ARGV[1] then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
			return v`, ck, micro, ttlFor(suffix))
		if err != nil && !errors.Is(err, vk.ErrDisabled) {
			log.Printf("[limits] spend counter update failed for %s: %v", ck, err)
		}
	}
}

func ttlFor(suffix string) int64 {
	if suffix == "day" {
		return int64((25 * time.Hour).Milliseconds())
	}
	return int64((32 * 24 * time.Hour).Milliseconds())
}

// APIKeyIdentity is the minimal identity the counters need: the key id and its
// DB handles for the durable spend fallback.
type APIKeyIdentity struct {
	KeyID       string
	WorkspaceID string
	// Store is consulted only when a Valkey spend counter is missing.
	Store SpendStore
}

// SpendStore is the durable sum source (implemented by *store.Store).
type SpendStore interface {
	DailyCostMicro(ctx context.Context, apiKeyID string) (int64, error)
	MonthlyCostMicro(ctx context.Context, apiKeyID string) (int64, error)
}

func dayStart() time.Time {
	now := time.Now().UTC()
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
}

func monthStart() time.Time {
	now := time.Now().UTC()
	return time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
}

func (l *Limiter) storeDaily(ctx context.Context, k *APIKeyIdentity) (int64, error) {
	if k.Store == nil {
		return 0, nil
	}
	return k.Store.DailyCostMicro(ctx, k.KeyID)
}

func (l *Limiter) storeMonthly(ctx context.Context, k *APIKeyIdentity) (int64, error) {
	if k.Store == nil {
		return 0, nil
	}
	return k.Store.MonthlyCostMicro(ctx, k.KeyID)
}

// spendMicro reads the counter; when it is MISSING it re-verifies against the
// durable sum and re-seeds the counter (spec §7).
func (l *Limiter) spendMicro(ctx context.Context, k *APIKeyIdentity, cacheKey string, since func() time.Time, bucketTTL time.Duration, durable func(context.Context, *APIKeyIdentity) (int64, error)) (int64, error) {
	var cached int64
	err := l.vk.GetJSON(ctx, cacheKey, &cached, 5*time.Second)
	if err == nil {
		return cached, nil
	}
	if errors.Is(err, vk.ErrDisabled) {
		// In-process fallback has no spend memory: go straight to the DB.
		return durable(ctx, k)
	}
	if k == nil || !errors.Is(err, vk.ErrNotFound) {
		if err != nil {
			return 0, err // Valkey down: caller degrades open
		}
	}
	used, derr := durable(ctx, k)
	if derr != nil {
		return 0, derr
	}
	// Re-seed so the next request takes the fast path. The TTL lives just past
	// the end of the counter's own bucket, so a stale sum ages out on rollover.
	ttl := time.Until(since().Add(bucketTTL))
	if ttl < time.Minute {
		ttl = time.Minute
	}
	_ = l.vk.SetJSON(ctx, cacheKey, used, ttl)
	return used, nil
}

// allow runs one fixed-window rate limit: Valkey first, in-process when
// disabled, open when down.
func (l *Limiter) allow(ctx context.Context, cacheKey string, limit int, window time.Duration, localKey string, weight int64) (bool, error) {
	ok, err := l.vk.AllowRate(ctx, cacheKey, limit, window)
	if errors.Is(err, vk.ErrDisabled) {
		return l.local.allow(localKey, limit, window, weight), nil
	}
	return ok, err
}

// allowTokens is allow() for token-count windows: the counter must advance by
// `weight`, so it is an INCRBY-fixed-window rather than a plain INCR.
func (l *Limiter) allowTokens(ctx context.Context, cacheKey string, limit int64, window time.Duration, weight int64, localKey string) (bool, error) {
	res, err := l.vk.Lua(ctx, `
		local v = redis.call('INCRBY', KEYS[1], ARGV[1])
		if v == ARGV[1] then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
		return v`, cacheKey, weight, window.Milliseconds())
	if errors.Is(err, vk.ErrDisabled) {
		return l.local.allow(localKey, int(limit), window, weight), nil
	}
	if err != nil {
		return true, err // degrade OPEN
	}
	if len(res) == 0 {
		return true, nil
	}
	v, ok := toInt64(res[0])
	if !ok {
		return true, nil
	}
	return v <= limit, nil
}

func toInt64(v any) (int64, bool) {
	switch n := v.(type) {
	case int64:
		return n, true
	case int:
		return int64(n), true
	case string:
		var out int64
		for _, c := range n {
			if c < '0' || c > '9' {
				return 0, false
			}
			out = out*10 + int64(c-'0')
		}
		return out, true
	}
	return 0, false
}

func key(parts ...string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += ":"
		}
		out += p
	}
	return out
}

// localLimiter is the S0 in-process limiter: a sliding window per key and an
// in-flight gauge. It is the fallback when Valkey is disabled — still
// enforcing, still local to one instance.
type localLimiter struct {
	mu     sync.Mutex
	window map[string][]time.Time
	weights map[string]int64
	inFlight map[string]int
}

func newLocalLimiter() localLimiter {
	return localLimiter{window: map[string][]time.Time{}, weights: map[string]int64{}, inFlight: map[string]int{}}
}

// allow records `weight` units against the key's window and reports whether it
// is still under `limit`. The window is a sliding list of timestamps (the S0
// shape); a weight > 1 occupies one slot but consumes `limit` units, tracked in
// weights.
func (l *localLimiter) allow(k string, limit int, window time.Duration, weight int64) bool {
	if limit <= 0 {
		return true
	}
	now := time.Now()
	cutoff := now.Add(-window)

	l.mu.Lock()
	defer l.mu.Unlock()

	ts := l.window[k]
	ws := l.weights[k]
	i := 0
	for i < len(ts) && ts[i].Before(cutoff) {
		ws -= slotWeight(k, i)
		i++
	}
	if i > 0 {
		ts = append([]time.Time(nil), ts[i:]...)
		l.weights[k] = ws
	}
	if ws+weight > int64(limit) {
		l.window[k] = ts
		return false
	}
	l.window[k] = append(ts, now)
	l.weights[k] = ws + weight
	slotWeights(k, len(ts)-1, weight)
	return true
}

// tryIncr takes an in-flight slot under `limit`. Second result is true when the
// limit is exhausted.
func (l *localLimiter) tryIncr(k string, limit int) (int, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.inFlight[k] >= limit {
		return l.inFlight[k], true
	}
	l.inFlight[k]++
	return l.inFlight[k], false
}

func (l *localLimiter) decr(k string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.inFlight[k] > 0 {
		l.inFlight[k]--
	}
}

// slot weights bookkeeping: the sliding window must forget a slot's weight
// when it ages out, so the two maps cannot drift.
var (
	slotMu sync.Mutex
	slots  = map[string]map[int]int64{}
)

func slotWeights(k string, i int, w int64) {
	slotMu.Lock()
	defer slotMu.Unlock()
	m := slots[k]
	if m == nil {
		m = map[int]int64{}
		slots[k] = m
	}
	m[i] = w
}

func slotWeight(k string, i int) int64 {
	slotMu.Lock()
	defer slotMu.Unlock()
	w := slots[k][i]
	delete(slots[k], i)
	return w
}
