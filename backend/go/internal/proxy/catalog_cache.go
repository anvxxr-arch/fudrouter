package proxy

import (
	"context"
	"encoding/json"
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
	// 45s is the whole staleness window, and nothing invalidates this entry.
	//
	// Publish happens in the CONSOLE's process — admin.mjs updates `model.status`
	// with raw SQL — so the router has no write to hook. Measured on the deployed
	// box: seeding a model and then listing /v1/models returns the previous list
	// until the entry expires, which is why TestModelDetailMatchesListEntry went
	// red against a real Valkey and green against the disabled client the helper
	// used to build. An operator who publishes a model and sees 404 at
	// /v1/models/{slug} for 45s is looking at this line.
	//
	// Leaving it explicit rather than silently shortening the TTL: the fix is
	// either an invalidation the console publishes (it shares this Valkey) or an
	// ADR agreeing the window is acceptable. Both are decisions, not a drive-by.
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

// fillCandidatePricing resolves each candidate's price through the Valkey
// cache (fail-open to DB) before the cost-aware strategies score them.
// LoadSignals snapshots Store.Price into the scoring fields, so signals are
// reloaded once the price lands — otherwise lowest_cost scores every
// candidate at zero and the order degrades to provider priority. The
// request's own billing snapshot in buildRow is untouched by this.
//
// The cache reads are BATCHED into one MGET. One GetJSON per candidate made a
// `[NAME]/*` virtual pay one round trip per model in the catalogue — measured at
// 500 reads for a 500-model catalogue, ~75ms of pure round-trip latency on the
// admission path before the first upstream byte. A cold cache is the worse case
// and it is not rare (a deploy, a flush, or any newly published model), because
// every miss then became its own pricing query; those misses are now collected
// and resolved together.
func (h *Handler) fillCandidatePricing(ctx context.Context, merged []routing.Candidate) {
	if len(merged) == 0 {
		return
	}
	keys := make([]string, 0, len(merged))
	todo := make([]int, 0, len(merged))
	for i := range merged {
		if merged[i].Store == nil {
			continue
		}
		keys = append(keys, h.pricingKey(merged[i].Store.ModelID, merged[i].Store.ProviderModelID))
		todo = append(todo, i)
	}
	if len(keys) == 0 {
		return
	}

	raw := make(map[string]json.RawMessage, len(keys))
	if err := h.vk.GetJSONMany(ctx, keys, raw, 5*time.Second); err == nil && len(raw) > 0 {
		// Decode the hits in place and remember which candidates are still
		// unresolved.
		pending := todo[:0]
		for n, i := range todo {
			buf, ok := raw[keys[n]]
			if !ok {
				pending = append(pending, i)
				continue
			}
			var p store.Pricing
			if json.Unmarshal(buf, &p) != nil {
				pending = append(pending, i) // undecodable = treat as a miss
				continue
			}
			merged[i].Store.Price = &p
			merged[i].LoadSignals()
		}
		todo = pending
	}
	// Misses (and a failed MGET: the whole set) resolve through the DB in ONE
	// query, then LoadSignals snapshots the price into the scoring fields.
	//
	// The batched resolver is what makes a COLD cache survivable: the single-row
	// form cost one query per model, and measured through this package's tracer a
	// model with no pricing_rule cost TWO (the rule miss, then the legacy
	// model-row fallback) — 61 queries for 31 models. A `[NAME]/*` virtual from a
	// cold cache therefore paid one query per model in the catalogue on the
	// admission path, and every entry expires on the same 60s clock, so that is
	// the state after any deploy or flush, not a rare one.
	//
	// The cache is still written back per key (best-effort, as before): skipping
	// that would leave every subsequent request cold, which is strictly worse
	// than the write round trips it saves.
	if len(todo) > 0 {
		misses := make([]missKey, 0, len(todo))
		pairs := make([][2]string, 0, len(todo))
		for _, i := range todo {
			mk := missKey{
				idx:   i,
				cache: h.pricingKey(merged[i].Store.ModelID, merged[i].Store.ProviderModelID),
				pair:  [2]string{merged[i].Store.ModelID, merged[i].Store.ProviderModelID},
			}
			misses = append(misses, mk)
			pairs = append(pairs, mk.pair)
		}
		resolved, err := h.store.ResolvePricingMany(ctx, pairs, time.Now())
		if err != nil {
			// Fail open, like the single-row path did: a pricing read error must
			// not drop candidates, it just leaves them unpriced (which degrades
			// cost-ranked strategies to provider priority).
			resolved = nil
		}
		for _, mk := range misses {
			p, ok := resolved[mk.pair[0]+"\x00"+mk.pair[1]]
			if !ok {
				continue
			}
			merged[mk.idx].Store.Price = p
			merged[mk.idx].LoadSignals()
			_ = h.vk.SetJSON(ctx, mk.cache, p, 60*time.Second)
		}
	}
}

// missKey ties a candidate's position in the merged slice to the Valkey key that
// would have held its price, so a resolved price can be written BACK under the
// key the next request will read.
type missKey struct {
	idx   int
	cache string
	pair  [2]string
}
