package provider

import (
	"context"
	"time"
)

// HealthStatus represents the health of a provider.
type HealthStatus struct {
	ProviderID string    `json:"providerId"`
	Healthy    bool      `json:"healthy"`
	Latency    int64     `json:"latencyMs"`
	Error      string    `json:"error,omitempty"`
	CheckedAt  time.Time `json:"checkedAt"`
}

// HealthChecker performs health checks on providers.
type HealthChecker struct {
	providers map[string]Provider
}

// NewHealthChecker creates a new HealthChecker.
func NewHealthChecker() *HealthChecker {
	return &HealthChecker{
		providers: map[string]Provider{},
	}
}

// Register adds a provider to the health checker.
func (h *HealthChecker) Register(p Provider) {
	h.providers[p.ID()] = p
}

// Check performs a health check on a single provider.
func (h *HealthChecker) Check(ctx context.Context, providerID string, creds *Credentials) HealthStatus {
	p, ok := h.providers[providerID]
	if !ok {
		return HealthStatus{
			ProviderID: providerID,
			Healthy:    false,
			Error:      "provider not found",
			CheckedAt:  time.Now(),
		}
	}

	start := time.Now()
	err := p.HealthCheck(ctx, creds)
	latency := time.Since(start).Milliseconds()

	status := HealthStatus{
		ProviderID: providerID,
		Healthy:    err == nil,
		Latency:    latency,
		CheckedAt:  time.Now(),
	}
	if err != nil {
		status.Error = err.Error()
	}
	return status
}

// CheckAll performs health checks on all registered providers.
func (h *HealthChecker) CheckAll(ctx context.Context, credsProvider func(string) *Credentials) []HealthStatus {
	out := make([]HealthStatus, 0, len(h.providers))
	for id := range h.providers {
		creds := credsProvider(id)
		if creds == nil {
			creds = &Credentials{}
		}
		out = append(out, h.Check(ctx, id, creds))
	}
	return out
}
