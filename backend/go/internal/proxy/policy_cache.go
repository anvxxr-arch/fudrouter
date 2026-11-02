package proxy

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/routing"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
)

// orDash maps an empty scope id to "-" so an unscoped key cannot share a
// cache entry with a scoped one.
func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// policyKey keys a resolved routing policy by the key's account — the only
// input RoutingPolicyFor reads (store.RoutingPolicyFor) — under the process's
// database namespace.
//
// The cache key used to carry an environment/project/workspace triple; those
// levels were removed in migration 0019, and keeping them in the key would have
// meant a stale entry per key that could never be reached again.
func (h *Handler) policyKey(account string) string {
	return cacheKey(h.cacheNS(), "policy:v2", orDash(account))
}

// cachedRoutingPolicy wraps Store.RoutingPolicyFor with a short Valkey TTL.
// A policy changes only via operator edit, so a 30s skew is acceptable; a
// missing/disabled/failing Valkey degrades to a direct DB read and never
// fails the request (spec §12 fail-open).
func (h *Handler) cachedRoutingPolicy(ctx context.Context, k *store.APIKeyRow) (*store.RoutingPolicy, error) {
	key := h.policyKey(k.UserID)
	var pol store.RoutingPolicy
	if err := h.vk.GetJSON(ctx, key, &pol, 5*time.Second); err == nil {
		return &pol, nil
	}
	// Any miss or error (ErrNotFound, ErrDisabled, transport failure) falls
	// through to the DB read below; vk logs transport errors itself.
	p, err := h.store.RoutingPolicyFor(ctx, k)
	if err != nil {
		return nil, err
	}
	_ = h.vk.SetJSON(ctx, key, p, 30*time.Second) // best-effort: a failed Set never fails the request
	return p, nil
}

// breakerConfigKey namespaces the circuit-breaker config cache under the same
// process database namespace as the routing policy, so two deployments sharing
// one Valkey cannot answer from each other's rows.
func (h *Handler) breakerConfigKey() string {
	return cacheKey(h.cacheNS(), "breaker:v1")
}

// cachedBreakerConfig wraps Store.CircuitBreakers with a short Valkey TTL, the
// same shape as cachedRoutingPolicy. A breaker row changes only by operator
// edit, so 30s of skew is acceptable; a missing/disabled/failing Valkey or a DB
// error returns nil and the caller keeps its last good config (D4 fail-open).
func (h *Handler) cachedBreakerConfig(ctx context.Context) map[string]routing.BreakerDefaults {
	if h.vk == nil || h.store == nil {
		return nil
	}
	key := h.breakerConfigKey()
	var rows map[string]store.CircuitBreakerConfig
	if err := h.vk.GetJSON(ctx, key, &rows, 5*time.Second); err == nil {
		return breakerDefaultsFrom(rows)
	}
	// Any miss or error falls through to the DB read below; vk logs transport
	// errors itself.
	loaded, err := h.store.CircuitBreakers(ctx)
	if err != nil {
		return nil
	}
	_ = h.vk.SetJSON(ctx, key, loaded, 30*time.Second) // best-effort: a failed Set never fails the request
	return breakerDefaultsFrom(loaded)
}

// breakerDefaultsFrom translates store rows into routing defaults, dropping
// disabled rows: BreakerDefaults has no Enabled field, so a disabled row would
// otherwise be applied as if enabled. The map key (Target + ":" + TargetID) is
// what both Store.CircuitBreakers and CircuitBreaker.config already produce.
func breakerDefaultsFrom(rows map[string]store.CircuitBreakerConfig) map[string]routing.BreakerDefaults {
	out := make(map[string]routing.BreakerDefaults, len(rows))
	for k, c := range rows {
		if !c.Enabled {
			continue
		}
		out[k] = routing.BreakerDefaults{
			FailureThreshold: c.FailureThreshold,
			WindowSeconds:    c.WindowSeconds,
			OpenMs:           c.OpenMs,
			HalfOpenProbes:   c.HalfOpenProbes,
		}
	}
	return out
}
