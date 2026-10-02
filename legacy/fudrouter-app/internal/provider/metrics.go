package provider

import (
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Metrics holds per-provider metrics.
type Metrics struct {
	mu sync.RWMutex

	// Request counts
	TotalRequests   map[string]int64
	SuccessRequests map[string]int64
	ErrorRequests   map[string]int64

	// Latency (in milliseconds)
	TotalLatency map[string]int64
	MinLatency   map[string]int64
	MaxLatency   map[string]int64

	// Token usage
	PromptTokens     map[string]int64
	CompletionTokens map[string]int64
	TotalTokens      map[string]int64

	// Cost (in USD)
	TotalCost map[string]float64

	// Last request time
	LastRequest map[string]time.Time
}

// NewMetrics creates a new Metrics instance.
func NewMetrics() *Metrics {
	return &Metrics{
		TotalRequests:   map[string]int64{},
		SuccessRequests: map[string]int64{},
		ErrorRequests:   map[string]int64{},
		TotalLatency:    map[string]int64{},
		MinLatency:      map[string]int64{},
		MaxLatency:      map[string]int64{},
		PromptTokens:    map[string]int64{},
		CompletionTokens: map[string]int64{},
		TotalTokens:     map[string]int64{},
		TotalCost:       map[string]float64{},
		LastRequest:     map[string]time.Time{},
	}
}

// RecordRequest records a request metric.
func (m *Metrics) RecordRequest(providerID string, latencyMs int64, success bool, promptTokens, completionTokens int, cost float64) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.TotalRequests[providerID]++
	if success {
		m.SuccessRequests[providerID]++
	} else {
		m.ErrorRequests[providerID]++
	}

	m.TotalLatency[providerID] += latencyMs
	if m.MinLatency[providerID] == 0 || latencyMs < m.MinLatency[providerID] {
		m.MinLatency[providerID] = latencyMs
	}
	if latencyMs > m.MaxLatency[providerID] {
		m.MaxLatency[providerID] = latencyMs
	}

	m.PromptTokens[providerID] += int64(promptTokens)
	m.CompletionTokens[providerID] += int64(completionTokens)
	m.TotalTokens[providerID] += int64(promptTokens + completionTokens)
	m.TotalCost[providerID] += cost
	m.LastRequest[providerID] = time.Now()
}

// Get returns a copy of the metrics for a provider.
func (m *Metrics) Get(providerID string) map[string]any {
	m.mu.RLock()
	defer m.mu.RUnlock()

	avgLatency := int64(0)
	if m.TotalRequests[providerID] > 0 {
		avgLatency = m.TotalLatency[providerID] / m.TotalRequests[providerID]
	}

	return map[string]any{
		"total_requests":   m.TotalRequests[providerID],
		"success_requests": m.SuccessRequests[providerID],
		"error_requests":   m.ErrorRequests[providerID],
		"avg_latency_ms":   avgLatency,
		"min_latency_ms":   m.MinLatency[providerID],
		"max_latency_ms":   m.MaxLatency[providerID],
		"prompt_tokens":    m.PromptTokens[providerID],
		"completion_tokens": m.CompletionTokens[providerID],
		"total_tokens":     m.TotalTokens[providerID],
		"total_cost_usd":   m.TotalCost[providerID],
		"last_request":     m.LastRequest[providerID],
	}
}

// Handler returns an HTTP handler for Prometheus-compatible metrics.
func (m *Metrics) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		m.mu.RLock()
		defer m.mu.RUnlock()

		for id := range m.TotalRequests {
			fmt.Fprintf(w, "# HELP fudrouter_provider_requests_total Total requests per provider\n")
			fmt.Fprintf(w, "# TYPE fudrouter_provider_requests_total counter\n")
			fmt.Fprintf(w, "fudrouter_provider_requests_total{provider=\"%s\"} %d\n", id, m.TotalRequests[id])

			fmt.Fprintf(w, "# HELP fudrouter_provider_errors_total Total errors per provider\n")
			fmt.Fprintf(w, "# TYPE fudrouter_provider_errors_total counter\n")
			fmt.Fprintf(w, "fudrouter_provider_errors_total{provider=\"%s\"} %d\n", id, m.ErrorRequests[id])

			fmt.Fprintf(w, "# HELP fudrouter_provider_latency_ms Average latency per provider\n")
			fmt.Fprintf(w, "# TYPE fudrouter_provider_latency_ms gauge\n")
			avg := int64(0)
			if m.TotalRequests[id] > 0 {
				avg = m.TotalLatency[id] / m.TotalRequests[id]
			}
			fmt.Fprintf(w, "fudrouter_provider_latency_ms{provider=\"%s\"} %d\n", id, avg)

			fmt.Fprintf(w, "# HELP fudrouter_provider_cost_usd Total cost per provider\n")
			fmt.Fprintf(w, "# TYPE fudrouter_provider_cost_usd counter\n")
			fmt.Fprintf(w, "fudrouter_provider_cost_usd{provider=\"%s\"} %.6f\n", id, m.TotalCost[id])
		}
	})
}
