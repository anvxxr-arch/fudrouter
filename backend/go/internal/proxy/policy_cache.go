package proxy

import (
	"context"
	"time"

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
