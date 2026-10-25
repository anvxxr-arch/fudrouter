package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
)

// The public model catalogue (endpoint-surface spec §3 rows 4–5, §6 P1).
//
// Both endpoints are UNAUTHENTICATED and public — the same catalogue is
// already published at GET /models and GET /pricing on the web app, so a key
// would hide nothing while breaking every client whose only capability is the
// catalogue (spec §2.1). `/v1/models` keeps its S0 shape plus the additive
// `context`/`pricing` fields (schema spec §14 promise 4); `/v1/models/{model}`
// returns the same fields for one slug (endpoint-surface §7 acceptance).

// ServeModels lists the published catalogue.
//
// The response body is cached fully rendered (renderCache on Handler): the
// catalogue is public and identical for every caller, so the per-request work
// is one write, not a re-encode of the whole list. The cache is refreshed
// through cachedModels on the same 45 s window the Valkey entry uses, so
// publish latency is unchanged.
func (h *Handler) ServeModels(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("health") == "1" {
		if body, ok := h.renderedModelsWithHealth(r.Context()); ok {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(body)
			return
		}
		h.writeErrCode(w, "INTERNAL_ERROR", "database error")
		return
	}
	body, ok := h.renderedModels(r.Context())
	if !ok {
		h.writeErrCode(w, "INTERNAL_ERROR", "database error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
}

// renderedModels returns the cached rendered list body, rebuilding it once
// when the 45 s window has passed. ok is false only when the catalogue cannot
// be read at all (database error) — a stale body is still served in that case,
// because a 45 s-old list beats a 500 for a public endpoint.
func (h *Handler) renderedModels(ctx context.Context) ([]byte, bool) {
	dev := h.devProviders()
	h.renderMu.Lock()
	if h.render != nil && h.renderDev == dev && time.Now().Before(h.renderExp) {
		body := h.render
		h.renderMu.Unlock()
		return body, true
	}
	// Expired (or never rendered): a body for THIS dev state may still exist.
	// Capture it now, under the same lock and the same dev-keyed predicate as
	// the fresh check above — a body rendered under dev=true must never reach
	// a dev=false caller, stale or not. h.render is only ever assigned a whole
	// new slice (the store below), never mutated in place, so the reference is
	// safe to hold across the unlock.
	//
	// The capture is what breaks the queueing defect: the stale-serve used to
	// run INSIDE the renderOnce gate, so on a DB outage the one goroutine that
	// won the gate blocked in cachedModels until it failed while every other
	// request queued behind it — and each loser, once admitted, re-ran the
	// same failing read, because the re-check below only helps when the winner
	// SUCCEEDS and refreshes renderExp. A public, unauthenticated endpoint
	// serialized into a queue of failing DB reads with a perfectly good
	// 45 s-old body sitting unreachable in h.render.
	var stale []byte
	if h.render != nil && h.renderDev == dev {
		stale = h.render
	}
	h.renderMu.Unlock()

	// One render at a time. TryLock, not Lock, is load-bearing: a caller that
	// finds a refresh already in flight and holds a stale body is answered
	// immediately instead of queueing, which caps the batch at one refresh
	// attempt; with Lock every loser still reached cachedModels after the
	// winner failed, so the batch cost stayed N reads. A caller with nothing
	// to serve (first-ever render) waits — there is no alternative. Rejected:
	// serving stale unconditionally on expiry (publish latency would become
	// unbounded — the flow stays expired → try refresh → stale only on
	// failure), a background refresher, and a knob; the 45 s window remains
	// the only staleness bound.
	if !h.renderOnce.TryLock() {
		if stale != nil {
			return stale, true
		}
		h.renderOnce.Lock()
	}
	defer h.renderOnce.Unlock()
	h.renderMu.Lock()
	if h.render != nil && h.renderDev == dev && time.Now().Before(h.renderExp) {
		body := h.render
		h.renderMu.Unlock()
		return body, true
	}
	h.renderMu.Unlock()

	models, err := h.cachedModels(ctx)
	if err != nil {
		// Serve the captured stale body rather than 500 a public endpoint;
		// only a catalogue that has never rendered fails.
		if stale != nil {
			return stale, true
		}
		return nil, false
	}
	view := h.healthView(ctx)
	data := make([]map[string]any, 0, len(models))
	for _, m := range models {
		obj := modelObject(m)
		attachHealth(obj, view)
		data = append(data, obj)
	}
	var buf bytes.Buffer
	_ = json.NewEncoder(&buf).Encode(map[string]any{
		"object": "list",
		"data":   data,
	})
	body := buf.Bytes()
	h.renderMu.Lock()
	h.render, h.renderDev, h.renderExp = body, dev, time.Now().Add(45*time.Second)
	h.renderMu.Unlock()
	return body, true
}

// ServeModel answers GET /v1/models/{model} with one catalogue object, 404
// otherwise. Public like /v1/models (spec §2.1).
func (h *Handler) ServeModel(w http.ResponseWriter, r *http.Request) {
	slug := strings.TrimPrefix(r.URL.Path, "/v1/models/")
	slug = strings.Trim(slug, "/")
	if slug == "" {
		// /v1/models/ with no slug is the list, not a model.
		h.ServeModels(w, r)
		return
	}
	m, err := h.cachedModel(r.Context(), slug)
	if err != nil {
		// A truthful 404 for unknown AND unpublished slugs (spec §6 P1) — the
		// answer must not distinguish "never existed" from "not published".
		h.writeErrCode(w, "MODEL_NOT_FOUND", "model not found: "+slug)
		return
	}
	obj := modelObject(*m)
	// Health is OPT-IN (`?health=1`): the default object keeps the literal
	// §6 P1 field set (exactly id/object/owned_by/context/pricing, mirrored
	// 1:1 by the list). No record yet = field omitted, which is the honest
	// "not probed yet" signal — the probe loop fills it within a sweep.
	if r.URL.Query().Get("health") == "1" {
		if e, ok := h.healthView(r.Context())[slug]; ok {
			obj["health"] = e
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(obj)
}

// modelObject renders one catalogue row. The field set is IDENTICAL on both
// endpoints (endpoint-surface §7 acceptance: "/v1/models/{model} returns the
// same fields /v1/models returns, for one slug").
func modelObject(m store.ModelInfo) map[string]any {
	return map[string]any{
		"id":       m.Slug,
		"object":   "model",
		"owned_by": m.OwnedBy,
		"context":  m.Context,
		"pricing": map[string]any{
			"input":    m.InputPrice,
			"output":   m.OutputPrice,
			"currency": m.Currency,
			"unit":     "micro-units per 1M tokens",
		},
	}
}
