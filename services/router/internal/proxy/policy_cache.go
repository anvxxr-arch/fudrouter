package proxy

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudrouter/services/router/internal/store"
)

// orDash maps an empty scope id to "-" so an unscoped key cannot share a
// cache entry with a scoped one.
func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// cachedRoutingPolicy wraps Store.RoutingPolicyFor with a short Valkey TTL.
// A policy changes only via operator edit, so a 30s skew is acceptable; a
// missing/disabled/failing Valkey degrades to a direct DB read and never
// fails the request (spec §12 fail-open).
func (h *Handler) cachedRoutingPolicy(ctx context.Context, k *store.APIKeyRow) (*store.RoutingPolicy, error) {
	key := "rt:policy:" + orDash(k.EnvironmentID) + "/" + orDash(k.ProjectID) + "/" + orDash(k.WorkspaceID)
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
