package metrics

import (
	"testing"
	"time"
)

func TestMetrics_RecordRequest(t *testing.T) {
	m := New()
	m.RecordRequest("openai", 100, true, 10, 20, 0.01)

	stats := m.GetStats()
	providers := stats["providers"].(map[string]any)
	openai := providers["openai"].(map[string]any)

	if openai["requests"].(int64) != 1 {
		t.Errorf("expected 1 request, got %v", openai["requests"])
	}
	if openai["errors"].(int64) != 0 {
		t.Errorf("expected 0 errors, got %v", openai["errors"])
	}
	if openai["avg_latency_ms"].(int64) != 100 {
		t.Errorf("expected 100ms avg latency, got %v", openai["avg_latency_ms"])
	}
	if openai["prompt_tokens"].(int64) != 10 {
		t.Errorf("expected 10 prompt tokens, got %v", openai["prompt_tokens"])
	}
	if openai["completion_tokens"].(int64) != 20 {
		t.Errorf("expected 20 completion tokens, got %v", openai["completion_tokens"])
	}
	if openai["total_tokens"].(int64) != 30 {
		t.Errorf("expected 30 total tokens, got %v", openai["total_tokens"])
	}
	if openai["total_cost_usd"].(float64) != 0.01 {
		t.Errorf("expected $0.01 cost, got %v", openai["total_cost_usd"])
	}
}

func TestMetrics_RecordRequest_Error(t *testing.T) {
	m := New()
	m.RecordRequest("openai", 200, false, 0, 0, 0)

	stats := m.GetStats()
	providers := stats["providers"].(map[string]any)
	openai := providers["openai"].(map[string]any)

	if openai["requests"].(int64) != 1 {
		t.Errorf("expected 1 request, got %v", openai["requests"])
	}
	if openai["errors"].(int64) != 1 {
		t.Errorf("expected 1 error, got %v", openai["errors"])
	}
}

func TestMetrics_MultipleProviders(t *testing.T) {
	m := New()
	m.RecordRequest("openai", 100, true, 10, 20, 0.01)
	m.RecordRequest("anthropic", 200, true, 15, 25, 0.02)

	stats := m.GetStats()
	providers := stats["providers"].(map[string]any)

	if len(providers) != 2 {
		t.Errorf("expected 2 providers, got %d", len(providers))
	}
}

func TestMetrics_LatencyStats(t *testing.T) {
	m := New()
	m.RecordRequest("openai", 100, true, 10, 20, 0.01)
	m.RecordRequest("openai", 200, true, 10, 20, 0.01)
	m.RecordRequest("openai", 300, true, 10, 20, 0.01)

	stats := m.GetStats()
	providers := stats["providers"].(map[string]any)
	openai := providers["openai"].(map[string]any)

	if openai["avg_latency_ms"].(int64) != 200 {
		t.Errorf("expected 200ms avg latency, got %v", openai["avg_latency_ms"])
	}
	if openai["min_latency_ms"].(int64) != 100 {
		t.Errorf("expected 100ms min latency, got %v", openai["min_latency_ms"])
	}
	if openai["max_latency_ms"].(int64) != 300 {
		t.Errorf("expected 300ms max latency, got %v", openai["max_latency_ms"])
	}
}

func TestMetrics_Uptime(t *testing.T) {
	m := New()
	time.Sleep(10 * time.Millisecond)

	stats := m.GetStats()
	uptime := stats["uptime_seconds"].(float64)

	if uptime < 0.01 {
		t.Errorf("expected uptime > 0.01s, got %f", uptime)
	}
}
