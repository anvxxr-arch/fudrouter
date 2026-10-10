package proxy

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/anvxxr-arch/fudrouter/apps/router/internal/store"
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
func (h *Handler) ServeModels(w http.ResponseWriter, r *http.Request) {
	models, err := h.cachedModels(r.Context())
	if err != nil {
		h.writeErrCode(w, "INTERNAL_ERROR", "database error")
		return
	}
	data := make([]map[string]any, 0, len(models))
	for _, m := range models {
		data = append(data, modelObject(m))
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"object": "list",
		"data":   data,
	})
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
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(modelObject(*m))
}

// modelObject renders one catalogue row. The field set is IDENTICAL on both
// endpoints (endpoint-surface §7 acceptance: "/v1/models/{model} returns the
// same fields /v1/models returns, for one slug").
func modelObject(m store.ModelInfo) map[string]any {
	return map[string]any{
		"id":        m.Slug,
		"object":    "model",
		"owned_by":  m.OwnedBy,
		"context":   m.Context,
		"pricing": map[string]any{
			"input":    m.InputPrice,
			"output":   m.OutputPrice,
			"currency": m.Currency,
			"unit":     "micro-units per 1M tokens",
		},
	}
}
