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
	"encoding/json"
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
func (noopClient) DecrConc(context.Context, string) error { return vk.ErrDisabled }
func (noopClient) GetJSON(context.Context, string, any, time.Duration) error {
	return vk.ErrDisabled
}
func (noopClient) SetJSON(context.Context, string, any, time.Duration) error {
	return vk.ErrDisabled
}
func (noopClient) IncrByBucket(context.Context, []string, int64, time.Duration) ([]int64, error) {
	return nil, vk.ErrDisabled
}
func (noopClient) ReplaceBuckets(context.Context, []string, int64, time.Duration) error {
	return vk.ErrDisabled
}

// GetJSONMany completes the Client surface for the "no cache configured" client.
// It is written out rather than one-lined so the aligned block above stays
// aligned under gofmt.
func (noopClient) GetJSONMany(context.Context, []string, map[string]json.RawMessage, time.Duration) error {
	return vk.ErrDisabled
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
//
// It also carried the ARGV comparison bug the other counters had, so neither
// counter ever got a TTL: a monthly spend total written once stayed authoritative
// for the life of the process, and the only way back was the DB sum behind a MISS
// that could never happen.
func (l *Limiter) SpendAdd(ctx context.Context, k *APIKeyIdentity, micro int64) {
	if micro == 0 || k == nil {
		return
	}
	// Two calls rather than one: the script takes a single TTL and these two
	// windows genuinely differ (25h vs 32d). Sharing the day TTL would make a
	// month-to-date counter expire mid-month.
	for _, w := range [2]struct {
		suffix string
		ttl    time.Duration
	}{
		{"day", 25 * time.Hour},
		{"month", 32 * 24 * time.Hour},
	} {
		ck := key(nsSpend, "api_key", k.KeyID, w.suffix)
		if _, err := l.vk.IncrByBucket(ctx, []string{ck}, micro, w.ttl); err != nil &&
			!errors.Is(err, vk.ErrDisabled) {
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
	_ = l.vk.ReplaceBuckets(ctx, []string{cacheKey}, used, ttl)
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
//
// The script's `if v == ARGV[1]` guard compared a Lua number against a string
// (ARGV is always a string at the server), so it was never true, so PEXPIRE never
// ran: the TPM/TPD counters had no expiry at all and never rolled over. A key
// that reached its daily token cap once stayed capped for the life of the
// process — and since the key name carries no bucket (rl:api_key:<id>:tpd), the
// counter was the ONLY thing that could end the window. The fix lives in
// vk.incrByBucketScript (tonumber + a real server test).
func (l *Limiter) allowTokens(ctx context.Context, cacheKey string, limit int64, window time.Duration, weight int64, localKey string) (bool, error) {
	totals, err := l.vk.IncrByBucket(ctx, []string{cacheKey}, weight, window)
	if errors.Is(err, vk.ErrDisabled) {
		return l.local.allow(localKey, int(limit), window, weight), nil
	}
	if err != nil {
		return true, err // degrade OPEN
	}
	if len(totals) == 0 {
		return true, nil
	}
	return totals[0] <= limit, nil
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
//
// The window is a slice of {timestamp, weight} PER KEY, and the running total is
// kept beside it. Three defects this replaced, all found by measuring rather
// than reading:
//
//   - The weights lived in a PACKAGE-LEVEL map (`slots`) keyed by the key name
//     only, so two Limiter instances shared bookkeeping and the second one's
//     slot overwrote the first's weight (measured: `slots["shared-key"]` held
//     one entry after two limiters wrote to it). It also could not be
//     garbage-collected while the process lived.
//   - Slot indices were derived from the OLD slice (`len(ts)-1` before the
//     append), so the first weight landed at index -1 and every later one was
//     shifted by one. With weight=1 on the RPM path the arithmetic happened to
//     stay correct; on the TOKEN path (allowTokens passes the token estimate as
//     the weight) the pruned weight belonged to a different request, so the
//     window could under- or over-count a key's token budget.
//   - Nothing ever evicted a key: `window`, `weights` and `slots` grew by one
//     entry per key ever seen, forever (measured: 500 keys → 501 slot maps that
//     still existed after their windows had aged out).
type localLimiter struct {
	mu sync.Mutex
	// keys holds each key's live window, oldest slot first. `used` is the sum of
	// the slot weights, maintained in lockstep so a check is O(pruned) and
	// allocates nothing in the steady state.
	keys map[string]*keyWindow
	// inFlight is the concurrency gauge.
	inFlight map[string]int
	// calls drives the opportunistic sweep below.
	calls int
}

// keyWindow is one key's sliding window.
type keyWindow struct {
	slots []slot
	used  int64
	// dur is the window the key was last seen with. Stored so the sweep can tell
	// an abandoned key from an active one without knowing the caller's config.
	dur time.Duration
}

// slot is one admitted request inside a window: when it landed and how much of
// the limit it consumed.
type slot struct {
	at time.Time
	w  int64
}

// sweepEvery is how many allow calls pass between opportunistic sweeps. The
// sweep is what stops a key that never comes back from keeping its entry
// forever — lazy deletion alone would only reclaim keys that are called again.
const sweepEvery = 1024

func newLocalLimiter() localLimiter {
	return localLimiter{
		keys:     map[string]*keyWindow{},
		inFlight: map[string]int{},
	}
}

// allow records `weight` units against the key's window and reports whether it
// is still under `limit`. A weight > 1 occupies one slot but consumes `limit`
// units — that is the token window's shape (allowTokens).
func (l *localLimiter) allow(k string, limit int, window time.Duration, weight int64) bool {
	if limit <= 0 {
		return true
	}
	now := time.Now()
	cutoff := now.Add(-window)

	l.mu.Lock()
	defer l.mu.Unlock()

	l.calls++
	if l.calls%sweepEvery == 0 {
		l.sweepLocked(now)
	}

	w := l.keys[k]
	if w == nil {
		w = &keyWindow{}
		l.keys[k] = w
	}
	w.dur = window

	i := 0
	for i < len(w.slots) && w.slots[i].at.Before(cutoff) {
		w.used -= w.slots[i].w
		i++
	}
	if i > 0 {
		// Reslice rather than reallocate: append below reuses the spare capacity
		// and only reallocates when the window genuinely grows, so a key at a
		// steady rate stops allocating instead of copying its slice per call.
		w.slots = w.slots[i:]
	}
	if w.used+weight > int64(limit) {
		l.evictIfEmpty(k, w)
		return false
	}
	w.slots = append(w.slots, slot{at: now, w: weight})
	w.used += weight
	return true
}

// evictIfEmpty drops a key once its window holds nothing, so a key that is
// refused (or that simply ages out) does not keep a map entry.
func (l *localLimiter) evictIfEmpty(k string, w *keyWindow) {
	if len(w.slots) == 0 {
		delete(l.keys, k)
	}
}

// sweepLocked reclaims keys whose window is empty or whose newest slot is older
// than their own window — the abandoned-key case, which lazy eviction cannot
// reach because nothing calls allow for that key again.
func (l *localLimiter) sweepLocked(now time.Time) {
	for k, w := range l.keys {
		if len(w.slots) == 0 || now.Sub(w.slots[len(w.slots)-1].at) > w.dur {
			delete(l.keys, k)
		}
	}
}

// size reports how many keys hold a window. Test-only accessor for the
// eviction assertions.
func (l *localLimiter) size() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.keys)
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
	// Delete at zero rather than storing it: the gauge is keyed per API key, and
	// a key that is idle forever must not keep an entry forever.
	if n := l.inFlight[k]; n > 1 {
		l.inFlight[k] = n - 1
	} else {
		delete(l.inFlight, k)
	}
}
