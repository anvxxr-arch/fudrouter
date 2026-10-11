package routing

import (
	"strings"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
)

// PlanFromRoutingPolicy maps a `routing_policy` row (store.RoutingPolicy) onto
// the selector's Plan. The jsonb shapes are a cross-plane contract with the
// control plane's routing form (BuildSurfaces), pinned here and in
// TestPlanFromRoutingPolicyShape:
//
//	provider_preferences: {"order": ["<provider slug>", ...]}
//	model_preferences:    {"order": ["<model slug>", ...]}
//	constraints:          subset of {max_input_price_micro, max_output_price_micro,
//	                      max_p95_latency_ms, min_availability, allowed_providers,
//	                      blocked_providers, region_preference}; empty = OMITTED
//	weights:              {price, latency, reliability, capacity} as 0..100 ints
//	                      (emitted only for strategy=balanced)
//
// A missing key constrains NOTHING (missing ≠ zero).
func PlanFromRoutingPolicy(p *store.RoutingPolicy, requestStrategy string, smartEnabled bool) Plan {
	if p == nil {
		p = store.DefaultRoutingPolicy()
	}
	plan := Plan{
		Strategy:         NormalizeStrategy(requestStrategy, p.Strategy, smartEnabled),
		Constraints:      parseConstraints(p.Constraints),
		ProviderPref:     parsePreferences(p.ProviderPreferences),
		ModelPref:        parsePreferences(p.ModelPreferences),
		Weights:          parseWeights(p.Weights),
		MaxAttempts:      p.MaxAttempts,
		RequestTimeoutMs: p.RequestTimeoutMs,
		FallbackEnabled:  p.FallbackEnabled,
	}
	if plan.MaxAttempts < 1 {
		plan.MaxAttempts = 1
	}
	if plan.RequestTimeoutMs <= 0 {
		plan.RequestTimeoutMs = 30000
	}
	return plan
}

// parseConstraints reads spec §9's keys. The form omits empty values, so each
// key is independently optional.
func parseConstraints(m map[string]any) Constraints {
	var c Constraints
	if v, ok := m["max_input_price_micro"]; ok {
		c.MaxInputPriceMicro = int64Ref(v)
	}
	if v, ok := m["max_output_price_micro"]; ok {
		c.MaxOutputPriceMicro = int64Ref(v)
	}
	if v, ok := m["max_p95_latency_ms"]; ok {
		c.MaxP95LatencyMs = int64Ref(v)
	}
	if v, ok := m["min_availability"]; ok {
		if f, isFloat := v.(float64); isFloat && f > 0 {
			c.MinAvailability = &f
		}
	}
	c.AllowedProviders = stringList(m["allowed_providers"])
	c.BlockedProviders = stringList(m["blocked_providers"])
	if s, ok := m["region_preference"].(string); ok {
		c.RegionPreference = strings.TrimSpace(s)
	}
	return c
}

func parsePreferences(m map[string]any) Preferences {
	return Preferences{
		Order:   stringList(m["order"]),
		Weights: floatMap(m["weights"]),
	}
}

// parseWeights reads {price, latency, reliability, capacity} as 0..100 ints and
// normalizes them to sum 1, so the balanced score is scale-independent. An
// empty or partial object falls back to the platform defaults for the missing
// parts (a missing claim is not a claim of zero importance).
func parseWeights(m map[string]any) Weights {
	w := DefaultWeights()
	if len(m) == 0 {
		return w
	}
	got := Weights{
		Price:       floatOf(m["price"]),
		Latency:     floatOf(m["latency"]),
		Reliability: floatOf(m["reliability"]),
		Capacity:    floatOf(m["capacity"]),
	}
	if got.Price <= 0 && got.Latency <= 0 && got.Reliability <= 0 && got.Capacity <= 0 {
		return w
	}
	w = Weights{
		Price:       positiveOr(got.Price, 0.25),
		Latency:     positiveOr(got.Latency, 0.25),
		Reliability: positiveOr(got.Reliability, 0.25),
		Capacity:    positiveOr(got.Capacity, 0.25),
	}
	sum := w.Price + w.Latency + w.Reliability + w.Capacity
	if sum > 0 {
		w.Price /= sum
		w.Latency /= sum
		w.Reliability /= sum
		w.Capacity /= sum
	}
	return w
}

func positiveOr(v, def float64) float64 {
	if v <= 0 {
		return def
	}
	return v
}

// The jsonb decodes numbers as float64; these helpers convert without losing
// the "missing vs zero" distinction (a nil input yields nil).
func int64Ref(v any) *int64 {
	switch n := v.(type) {
	case float64:
		i := int64(n)
		return &i
	case int64:
		return &n
	case int:
		i := int64(n)
		return &i
	}
	return nil
}

func floatOf(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int64:
		return float64(n)
	case int:
		return float64(n)
	}
	return 0
}

func stringList(v any) []string {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, item := range arr {
		if s, isStr := item.(string); isStr && strings.TrimSpace(s) != "" {
			out = append(out, strings.TrimSpace(s))
		}
	}
	return out
}

func floatMap(v any) map[string]float64 {
	m, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	out := make(map[string]float64, len(m))
	for k, val := range m {
		if f := floatOf(val); f > 0 {
			out[k] = f
		}
	}
	return out
}
