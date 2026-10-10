package proxy

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudrouter/services/router/internal/store"
)

// Catalogue + pricing cache (Valkey, best-effort, fail-open to DB).
//
// Both catalogue endpoints are public and non-user-specific (models.go:
// spec §2.1), so one shared entry serves every caller. The per-request price
// snapshot in buildRow is untouched, so ledger history stays exact — at most
// 60s of pricing skew in routing decisions.
func (h *Handler) cachedModels(ctx context.Context) ([]store.ModelInfo, error) {
	const key = "rt:models:v1"
	var models []store.ModelInfo
	if err := h.vk.GetJSON(ctx, key, &models, 5*time.Second); err == nil {
		return models, nil
	}
	// Any miss or error falls through to the DB read below.
	m, err := h.store.ActiveModels(ctx)
	if err != nil {
		return nil, err
	}
	_ = h.vk.SetJSON(ctx, key, m, 45*time.Second) // best-effort
	return m, nil
}

func (h *Handler) cachedModel(ctx context.Context, slug string) (*store.ModelInfo, error) {
	key := "rt:model:" + slug
	var m store.ModelInfo
	if err := h.vk.GetJSON(ctx, key, &m, 5*time.Second); err == nil {
		return &m, nil
	}
	// Any miss or error falls through to the DB read below.
	got, err := h.store.PublishedModel(ctx, slug)
	if err != nil {
		return nil, err
	}
	_ = h.vk.SetJSON(ctx, key, got, 45*time.Second) // best-effort
	return got, nil
}

func (h *Handler) cachedPricing(ctx context.Context, modelID, providerModelID string) (*store.Pricing, error) {
	key := "rt:price:" + modelID + ":" + providerModelID
	var p store.Pricing
	if err := h.vk.GetJSON(ctx, key, &p, 5*time.Second); err == nil {
		return &p, nil
	}
	// Any miss or error falls through to the DB read below.
	got, err := h.store.ResolvePricing(ctx, modelID, providerModelID, time.Now())
	if err != nil {
		return nil, err
	}
	_ = h.vk.SetJSON(ctx, key, got, 60*time.Second) // best-effort
	return got, nil
}
