package metrics

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Metrics holds global metrics for the gateway.
type Metrics struct {
	mu sync.RWMutex

	// Request metrics
	RequestCount   map[string]int64 // by provider
	ErrorCount     map[string]int64 // by provider
	LatencySum     map[string]int64 // by provider (ms)
	LatencyCount   map[string]int64 // by provider
	MinLatency     map[string]int64 // by provider (ms)
	MaxLatency     map[string]int64 // by provider (ms)

	// Token metrics
	PromptTokens     map[string]int64
	CompletionTokens map[string]int64
	TotalTokens      map[string]int64

	// Cost metrics
	TotalCost map[string]float64

	// Last request time
	LastRequest map[string]time.Time

	// Start time
	StartTime time.Time
}

// New creates a new Metrics instance.
func New() *Metrics {
	return &Metrics{
		RequestCount:    make(map[string]int64),
		ErrorCount:      make(map[string]int64),
		LatencySum:      make(map[string]int64),
		LatencyCount:    make(map[string]int64),
		MinLatency:      make(map[string]int64),
		MaxLatency:      make(map[string]int64),
		PromptTokens:    make(map[string]int64),
		CompletionTokens: make(map[string]int64),
		TotalTokens:     make(map[string]int64),
		TotalCost:       make(map[string]float64),
		LastRequest:     make(map[string]time.Time),
		StartTime:       time.Now(),
	}
}

// RecordRequest records a request metric.
func (m *Metrics) RecordRequest(providerID string, latencyMs int64, success bool, promptTokens, completionTokens int, cost float64) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.RequestCount[providerID]++
	if !success {
		m.ErrorCount[providerID]++
	}

	m.LatencySum[providerID] += latencyMs
	m.LatencyCount[providerID]++
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

// GetStats returns a snapshot of all metrics.
func (m *Metrics) GetStats() map[string]any {
	m.mu.RLock()
	defer m.mu.RUnlock()

	providers := make(map[string]any)
	for id := range m.RequestCount {
		avgLatency := int64(0)
		if m.LatencyCount[id] > 0 {
			avgLatency = m.LatencySum[id] / m.LatencyCount[id]
		}
		providers[id] = map[string]any{
			"requests":          m.RequestCount[id],
			"errors":            m.ErrorCount[id],
			"avg_latency_ms":    avgLatency,
			"min_latency_ms":    m.MinLatency[id],
			"max_latency_ms":    m.MaxLatency[id],
			"prompt_tokens":     m.PromptTokens[id],
			"completion_tokens": m.CompletionTokens[id],
			"total_tokens":      m.TotalTokens[id],
			"total_cost_usd":    m.TotalCost[id],
			"last_request":      m.LastRequest[id],
		}
	}

	return map[string]any{
		"uptime_seconds": time.Since(m.StartTime).Seconds(),
		"providers":      providers,
	}
}

// Handler returns an HTTP handler for Prometheus-compatible metrics.
func (m *Metrics) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		m.mu.RLock()
		defer m.mu.RUnlock()

		fmt.Fprintf(w, "# HELP fudrouter_uptime_seconds Uptime in seconds\n")
		fmt.Fprintf(w, "# TYPE fudrouter_uptime_seconds gauge\n")
		fmt.Fprintf(w, "fudrouter_uptime_seconds %.0f\n", time.Since(m.StartTime).Seconds())

		for id := range m.RequestCount {
			fmt.Fprintf(w, "# HELP fudrouter_requests_total Total requests per provider\n")
			fmt.Fprintf(w, "# TYPE fudrouter_requests_total counter\n")
			fmt.Fprintf(w, "fudrouter_requests_total{provider=\"%s\"} %d\n", id, m.RequestCount[id])

			fmt.Fprintf(w, "# HELP fudrouter_errors_total Total errors per provider\n")
			fmt.Fprintf(w, "# TYPE fudrouter_errors_total counter\n")
			fmt.Fprintf(w, "fudrouter_errors_total{provider=\"%s\"} %d\n", id, m.ErrorCount[id])

			avg := int64(0)
			if m.LatencyCount[id] > 0 {
				avg = m.LatencySum[id] / m.LatencyCount[id]
			}
			fmt.Fprintf(w, "# HELP fudrouter_latency_ms Average latency per provider\n")
			fmt.Fprintf(w, "# TYPE fudrouter_latency_ms gauge\n")
			fmt.Fprintf(w, "fudrouter_latency_ms{provider=\"%s\"} %d\n", id, avg)

			fmt.Fprintf(w, "# HELP fudrouter_prompt_tokens Total prompt tokens per provider\n")
			fmt.Fprintf(w, "# TYPE fudrouter_prompt_tokens counter\n")
			fmt.Fprintf(w, "fudrouter_prompt_tokens{provider=\"%s\"} %d\n", id, m.PromptTokens[id])

			fmt.Fprintf(w, "# HELP fudrouter_completion_tokens Total completion tokens per provider\n")
			fmt.Fprintf(w, "# TYPE fudrouter_completion_tokens counter\n")
			fmt.Fprintf(w, "fudrouter_completion_tokens{provider=\"%s\"} %d\n", id, m.CompletionTokens[id])

			fmt.Fprintf(w, "# HELP fudrouter_total_tokens Total tokens per provider\n")
			fmt.Fprintf(w, "# TYPE fudrouter_total_tokens counter\n")
			fmt.Fprintf(w, "fudrouter_total_tokens{provider=\"%s\"} %d\n", id, m.TotalTokens[id])

			fmt.Fprintf(w, "# HELP fudrouter_cost_usd Total cost per provider\n")
			fmt.Fprintf(w, "# TYPE fudrouter_cost_usd counter\n")
			fmt.Fprintf(w, "fudrouter_cost_usd{provider=\"%s\"} %.6f\n", id, m.TotalCost[id])
		}
	})
}

// JSONHandler returns an HTTP handler for JSON metrics.
func (m *Metrics) JSONHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		stats := m.GetStats()
		json.NewEncoder(w).Encode(stats)
	})
}
