package store

// In-process caching for the two reads admission makes before every dispatch.
//
// Why this file exists: checkBudgets runs before the request is routed, so the
// billing account + environment budget (BudgetGateState) and the scoped budget
// rows (BudgetsFor) were TWO Postgres round trips on EVERY request — measured at
// 525µs per call on this box (BenchmarkBudgetGate/no-budgets), against a hot path
// whose remaining steps are single-digit MICROseconds (routing 4.8µs, token
// estimate 1.6µs, body decode 8.7µs). The gate was 98% of admission cost and it
// made throughput a function of Postgres round-trip latency: one connection at
// 525µs serializes to ~1.9k rps, and every extra request multiplies the query
// load. The target shape is one that does not grow a database round trip per
// request, so the reads are cached in-process and the database sees a handful of
// queries per workspace per TTL instead of one per request.
//
// The TTLs are different on purpose, because the two values age differently:
//
//   - The billing account carries `balance_micro`, which moves with EVERY charge.
//     Its TTL is therefore SHORT (gateTTL), and a charge that crosses the hard
//     stop drops the entry immediately (InvalidateAdmission) so the refusal is
//     not delayed by the TTL. The residual window is a workspace whose balance
//     crosses the line concurrently with an in-flight request: bounded by
//     gateTTL, not by traffic.
//   - The environment's monthly budget and the `budget` rows are operator-set
//     POLICY: they change when someone edits them, not with traffic. They get the
//     same 60s the limits cache already uses (hardLimitCache, EffectiveLimits),
//     so the house already accepts that bound for policy reads.
//
// Failure semantics are the caller's, unchanged: this layer never caches an
// error, so a failed read still surfaces to checkBudgets and still refuses
// (spec §10 — a billing read that cannot be trusted must not admit spend).
//
// One entry is shared per key, so the maps are bounded (a flood of workspaces
// must not grow them without limit) and eviction drops expired entries first,
// then arbitrary ones — never the whole map, which would stampede Postgres.
//
// Every value a getter returns is the CACHED ONE, not a copy: `*Limits`,
// `*BillingAccount` and the `[]Budget` slice are read straight out of the map.
// Callers therefore MUST treat them as read-only — a caller that wrote through
// one (e.g. `acct.BalanceMicro = …`) would poison every reader sharing the
// entry until its TTL, and nothing in the type system stops it. Copying on every
// hit is not the trade: that is an allocation on the request path this cache
// exists to keep free (measured 0 allocs/op). The charge path does not need it
// either — it drops the entry instead (InvalidateAdmission), so a written-through
// value would be discarded anyway.

import (
	"context"
	"sync"
	"time"
)

const (
	// gateTTL bounds how stale the billing account may be. Short because
	// balance_micro is money; the charge path also invalidates the entry the
	// moment it crosses the hard stop.
	gateTTL = 5 * time.Second
	// policyTTL is the bound for operator-set rows: the environment's monthly
	// budget and the `budget` table.
	policyTTL = 60 * time.Second
	// admissionCacheMax caps each map. A workspace that is idle for a TTL is
	// evicted on the next insert past the cap, so the ceiling is memory, not
	// correctness.
	admissionCacheMax = 8192
)

type accountEntry struct {
	acct *BillingAccount
	exp  time.Time
}

type budgetCacheKey struct {
	accountID string
}

type budgetEntry struct {
	budgets []Budget
	exp     time.Time
}

type limitsCacheKey struct {
	accountID string
	apiKeyID  string
}

type limitsEntry struct {
	limits *Limits
	exp    time.Time
}

// admissionCache holds all three maps under one lock. They are read on the same
// request path and written on the same miss path, so a single RWMutex costs one
// uncontended atomic on the hit path and removes any question of lock ordering.
type admissionCache struct {
	mu         sync.RWMutex
	accounts   map[string]accountEntry
	budgets    map[budgetCacheKey]budgetEntry
	limits     map[limitsCacheKey]limitsEntry
	// ttl overrides the account TTL in tests (export_test.go). Zero means
	// gateTTL; production never sets it.
	ttl time.Duration
	// policyTTLOverride does the same for policyTTL.
	policyTTLOverride time.Duration
}

func (c *admissionCache) accountTTL() time.Duration {
	if c.ttl > 0 {
		return c.ttl
	}
	return gateTTL
}

func (c *admissionCache) policyTTL() time.Duration {
	if c.policyTTLOverride > 0 {
		return c.policyTTLOverride
	}
	return policyTTL
}

// AdmissionGateState is BudgetGateState with the in-process cache in front of it.
// It is what checkBudgets calls; BudgetGateState itself stays uncached so its
// query count remains pinned by TestBudgetGateStateIsOneQuery.
func (s *Store) AdmissionGateState(ctx context.Context, accountID string) (*BillingAccount, error) {
	now := time.Now()
	c := &s.admission
	c.mu.RLock()
	acctEntry, acctOK := c.accounts[accountID]
	c.mu.RUnlock()
	if acctOK && now.Before(acctEntry.exp) {
		return acctEntry.acct, nil
	}

	acct, err := s.BudgetGateState(ctx, accountID)
	if err != nil {
		return nil, err
	}
	c.store(accountID, acct, now)
	return acct, nil
}

func (c *admissionCache) store(accountID string, acct *BillingAccount, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.accounts == nil {
		c.accounts = make(map[string]accountEntry, 64)
		c.budgets = make(map[budgetCacheKey]budgetEntry, 64)
	}
	if len(c.accounts) >= admissionCacheMax {
		evictAccounts(c.accounts, now)
	}
	c.accounts[accountID] = accountEntry{acct: acct, exp: now.Add(c.accountTTL())}
}

// AdmissionLimits is EffectiveLimits with the in-process cache in front of it:
// the rate_limit chain is operator policy that changes on an edit, not on
// traffic, so it gets the same 60s bound the platform hard limits already have
// (hardLimitCache) — and the limiter's own counters in Valkey are what actually
// enforce, so the window is a policy-lag, not an enforcement gap.
//
// EffectiveLimits itself stays uncached and keeps its query-count contract.
func (s *Store) AdmissionLimits(ctx context.Context, k *APIKeyRow) (*Limits, error) {
	if k == nil {
		return s.EffectiveLimits(ctx, k)
	}
	key := limitsCacheKey{k.UserID, k.ID}
	now := time.Now()
	c := &s.admission
	c.mu.RLock()
	entry, ok := c.limits[key]
	c.mu.RUnlock()
	if ok && now.Before(entry.exp) {
		return entry.limits, nil
	}
	lim, err := s.EffectiveLimits(ctx, k)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	if c.limits == nil {
		c.limits = make(map[limitsCacheKey]limitsEntry, 64)
	}
	if len(c.limits) >= admissionCacheMax {
		evictLimits(c.limits, now)
	}
	c.limits[key] = limitsEntry{limits: lim, exp: now.Add(c.policyTTL())}
	c.mu.Unlock()
	return lim, nil
}

// InvalidateAdmission drops the cached billing account for one account. Called
// by ChargeRequest when a charge crosses the hard stop: the very next request
// must see the line it just crossed rather than the pre-charge balance the cache
// is still holding.
func (s *Store) InvalidateAdmission(accountID string) {
	if accountID == "" {
		return
	}
	s.admission.mu.Lock()
	delete(s.admission.accounts, accountID)
	s.admission.mu.Unlock()
}

// AdmissionBudgets is BudgetsFor with the in-process cache in front of it.
func (s *Store) AdmissionBudgets(ctx context.Context, k *APIKeyRow) ([]Budget, error) {
	if k == nil {
		return s.BudgetsFor(ctx, k)
	}
	key := budgetCacheKey{k.UserID}
	now := time.Now()
	c := &s.admission
	c.mu.RLock()
	entry, ok := c.budgets[key]
	c.mu.RUnlock()
	if ok && now.Before(entry.exp) {
		return entry.budgets, nil
	}
	budgets, err := s.BudgetsFor(ctx, k)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	if c.budgets == nil {
		c.budgets = make(map[budgetCacheKey]budgetEntry, 64)
	}
	if len(c.budgets) >= admissionCacheMax {
		evictBudgets(c.budgets, now)
	}
	c.budgets[key] = budgetEntry{budgets: budgets, exp: now.Add(c.policyTTL())}
	c.mu.Unlock()
	return budgets, nil
}

// evict* drop every expired entry, then — if the map is still at the ceiling —
// an arbitrary one. Go randomizes map iteration, so the arbitrary victim is not
// a hot key by construction. The alternative (clearing the map) would answer a
// single insert with a stampede of queries for every other workspace.
func evictAccounts(m map[string]accountEntry, now time.Time) {
	for k, v := range m {
		if now.After(v.exp) {
			delete(m, k)
		}
	}
	for k := range m {
		delete(m, k)
		break
	}
}

func evictBudgets(m map[budgetCacheKey]budgetEntry, now time.Time) {
	for k, v := range m {
		if now.After(v.exp) {
			delete(m, k)
		}
	}
	for k := range m {
		delete(m, k)
		break
	}
}

func evictLimits(m map[limitsCacheKey]limitsEntry, now time.Time) {
	for k, v := range m {
		if now.After(v.exp) {
			delete(m, k)
		}
	}
	for k := range m {
		delete(m, k)
		break
	}
}
