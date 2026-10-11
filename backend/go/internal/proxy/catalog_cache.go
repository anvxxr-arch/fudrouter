package proxy

import (
	"context"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/routing"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
)

// Catalogue + pricing cache (Valkey, best-effort, fail-open to DB).
//
// Both catalogue endpoints are public and non-user-specific (models.go:
// spec §2.1), so one shared entry serves every caller. The per-request price
// snapshot in buildRow is untouched, so ledger history stays exact — at most
// 60s of pricing skew in routing decisions.

// cacheKey assembles a Valkey key: rt:<ns>:<name>[:part…].
//
// Every router entry is namespaced by the database the process serves, so two
// deployments that share one Valkey (this drill next to production, a staging
// box) can never answer from each other's rows.
func cacheKey(ns, name string, parts ...string) string {
	var b strings.Builder
	b.WriteString("rt:")
	b.WriteString(ns)
	b.WriteByte(':')
	b.WriteString(name)
	for _, p := range parts {
		b.WriteByte(':')
		b.WriteString(p)
	}
	return b.String()
}

// cacheNS and devProviders are nil-safe on purpose: a Handler assembled by a
// test without a Store must still key deterministically, not panic.
func (h *Handler) cacheNS() string {
	if h.store == nil {
		return "unbound"
	}
	return h.store.CacheNamespace()
}

func (h *Handler) devProviders() bool {
	return h.store != nil && h.store.DevProvidersAllowed()
}

// catalogueKey keys a catalogue entry. Two things live in the key beyond the
// namespace, both learned the hard way:
//
//   - `v2` retires the entries written by the first cut, which keyed the
//     catalogue on the constant "rt:models:v1" — so the drill's second boot
//     (ROUTER_ALLOW_DEV_PROVIDERS=1) read the dev-hidden list its first boot
//     had written moments earlier and reported the flag broken.
//   - `dev=` because ActiveModels/PublishedModel filter on providerServable,
//     which is derived from that flag: with the flag off and on, the two
//     answers are different, so they must not share an entry at all.
func (h *Handler) catalogueKey(name string, parts ...string) string {
	dev := "0"
	if h.devProviders() {
		dev = "1"
	}
	return cacheKey(h.cacheNS(), name, append([]string{"dev=" + dev}, parts...)...)
}

func (h *Handler) pricingKey(modelID, providerModelID string) string {
	return cacheKey(h.cacheNS(), "price:v1", modelID, providerModelID)
}

func (h *Handler) cachedModels(ctx context.Context) ([]store.ModelInfo, error) {
	key := h.catalogueKey("models:v2")
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
	key := h.catalogueKey("model:v2", slug)
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
	key := h.pricingKey(modelID, providerModelID)
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

// fillCandidatePricing resolves each candidate's price through the Valkey
// cache (fail-open to DB) before the cost-aware strategies score them.
// LoadSignals snapshots Store.Price into the scoring fields, so signals are
// reloaded once the price lands — otherwise lowest_cost scores every
// candidate at zero and the order degrades to provider priority. The
// request's own billing snapshot in buildRow is untouched by this.
func (h *Handler) fillCandidatePricing(ctx context.Context, merged []routing.Candidate) {
	for i := range merged {
		if merged[i].Store == nil {
			continue
		}
		if p, err := h.cachedPricing(ctx, merged[i].Store.ModelID, merged[i].Store.ProviderModelID); err == nil {
			merged[i].Store.Price = p
			merged[i].LoadSignals()
		}
	}
}
