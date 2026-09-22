// Package freebuff speaks the Codebuff/Freebuff private protocol natively, so a
// fudrouter provider can serve Freebuff's free-tier models without a sidecar
// gateway.
//
// The protocol was reverse-engineered (see the Freebuff2API project) and is not
// [OI]: a chat request needs a live freebuff session, a root agent run, and a
// `codebuff_metadata` block injected into the body. Upstream is
// `https://www.codebuff.com`; the token is a Codebuff Bearer token.
package freebuff

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
)

//go:embed models.json
var modelsJSON []byte

// DefaultModel is the fallback when a requested model is unknown or unusable.
// Mirrors Freebuff2API's DEFAULT_MODEL.
const DefaultModel = "z-ai/glm-5.3-flash"

// ModelMeta is one row of the static, measured model table. It is the
// authority for which free-tier models exist, which are still admitted, their
// reasoning-effort ladder, and where an unavailable one falls back to.
type ModelMeta struct {
	ID           string   `json:"id"`
	Agent        string   `json:"agent"`
	Premium      bool     `json:"premium"`
	Multimodal   bool     `json:"multimodal"`
	Available    bool     `json:"available"`
	Namespace    bool     `json:"namespace,omitempty"`
	Efforts      []string `json:"efforts"`
	Fallback     *string  `json:"fallback"`
	Availability string   `json:"availability"`
}

var (
	registryOnce sync.Once
	registry     []ModelMeta
	registryErr  error
)

func loadRegistry() ([]ModelMeta, error) {
	registryOnce.Do(func() {
		var rows []ModelMeta
		if err := json.Unmarshal(modelsJSON, &rows); err != nil {
			registryErr = fmt.Errorf("freebuff: parsing embedded models.json: %w", err)
			return
		}
		registry = rows
	})
	return registry, registryErr
}

// Models returns the full static table (available and unavailable rows).
func Models() ([]ModelMeta, error) { return loadRegistry() }

// AvailableModels returns concrete models the free tier currently admits —
// what an onboarding script should seed. Namespace rows (e.g. `anthropic/`)
// are excluded because they are not callable model ids.
func AvailableModels() ([]ModelMeta, error) {
	all, err := loadRegistry()
	if err != nil {
		return nil, err
	}
	out := make([]ModelMeta, 0, len(all))
	for _, m := range all {
		if m.Available && !m.Namespace {
			out = append(out, m)
		}
	}
	return out, nil
}

// Lookup returns the metadata row for a model id. Namespace prefixes match by
// prefix, so `anthropic/` covers `anthropic/some-model`.
func Lookup(id string) (ModelMeta, bool) {
	all, err := loadRegistry()
	if err != nil {
		return ModelMeta{}, false
	}
	for _, m := range all {
		if m.ID == id {
			return m, true
		}
	}
	for _, m := range all {
		if m.Namespace && strings.HasPrefix(id, m.ID) {
			return m, true
		}
	}
	return ModelMeta{}, false
}

// Resolve maps a requested model to the one actually sent upstream. An unknown
// model is passed through untouched (the upstream then returns a readable
// error); a known-but-unavailable model resolves to its fallback, or to
// DefaultModel when it has none.
func Resolve(requested string) (resolved, reason string) {
	meta, ok := Lookup(requested)
	if !ok {
		return requested, ""
	}
	if meta.Available {
		return requested, ""
	}
	if meta.Fallback != nil && *meta.Fallback != "" {
		return *meta.Fallback, fmt.Sprintf(
			"freebuff model %q is paused/unavailable upstream; served by fallback %q",
			requested, *meta.Fallback)
	}
	return DefaultModel, fmt.Sprintf(
		"freebuff model %q is paused/unavailable upstream; served by default %q",
		requested, DefaultModel)
}

// ClampEffort returns the reasoning_effort value to send for a model. A model
// with no effort ladder (solar/minimax/mimo/kimi) returns ("", false) so the
// caller strips the field; an out-of-range value downgrades to the nearest
// supported rung.
func ClampEffort(model, requested string) (string, bool) {
	if strings.TrimSpace(requested) == "" {
		return "", false
	}
	meta, ok := Lookup(model)
	if !ok || len(meta.Efforts) == 0 {
		return "", false
	}
	want := strings.ToLower(strings.TrimSpace(requested))
	for _, e := range meta.Efforts {
		if e == want {
			return want, true
		}
	}
	switch want {
	case "max", "xhigh", "high":
		return meta.Efforts[len(meta.Efforts)-1], true
	case "minimal", "low":
		return meta.Efforts[0], true
	default:
		return meta.Efforts[0], true
	}
}
