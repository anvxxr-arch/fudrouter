package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/vk"
)

// fakePinger stands in for the store so both health paths are testable without
// a live database. The behaviour that matters is the decision the handler makes
// on Ping's result, not pgx's internals.
type fakePinger struct{ err error }

func (f fakePinger) Ping(context.Context) error { return f.err }

// fakeCache reports a fixed tally so the health body's cache block is testable
// without a Valkey server.
type fakeCache struct{ s vk.CacheStats }

func (f fakeCache) CacheStats() vk.CacheStats { return f.s }

func TestHealthReportsServiceIdentity(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/health", nil)

	newHealthHandler(fakePinger{}, nil).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	var body struct {
		OK      bool   `json:"ok"`
		Service string `json:"service"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if !body.OK {
		t.Error("ok = false, want true")
	}
	if body.Service != "fudrouter-router" {
		t.Errorf("service = %q, want %q", body.Service, "fudrouter-router")
	}
}

// The cache block is reported only when a cache is configured: a nil client
// means "no cache layer", and a 0% hit rate there would read as a failing cache
// rather than an absent one.
func TestHealthOmitsCacheWhenNoCacheConfigured(t *testing.T) {
	rec := httptest.NewRecorder()
	newHealthHandler(fakePinger{}, nil).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))

	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if _, ok := body["cache"]; ok {
		t.Error("cache block present with no cache configured")
	}
}

// With a cache configured the body carries the hit/miss tally and the derived
// rate, so the ≥60% target (owner rule 19) is observable from /health.
func TestHealthReportsCacheHitRate(t *testing.T) {
	rec := httptest.NewRecorder()
	newHealthHandler(fakePinger{}, fakeCache{s: vk.CacheStats{Hits: 3, Misses: 1}}).
		ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))

	var body struct {
		Cache struct {
			Hits    int64   `json:"hits"`
			Misses  int64   `json:"misses"`
			HitRate float64 `json:"hit_rate"`
		} `json:"cache"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if body.Cache.Hits != 3 || body.Cache.Misses != 1 {
		t.Errorf("cache = %+v, want hits=3 misses=1", body.Cache)
	}
	if body.Cache.HitRate != 0.75 {
		t.Errorf("hit_rate = %v, want 0.75", body.Cache.HitRate)
	}
}

// TestHealthFailsWhenDatabaseIsDown pins the fix for the bug where /health
// returned 200 {"ok":true} while the database was unreachable, so an uptime
// monitor saw a healthy router that could not serve a single request.
func TestHealthFailsWhenDatabaseIsDown(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/health", nil)

	newHealthHandler(fakePinger{err: errors.New("connection refused")}, nil).ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}

	var body struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if body.OK {
		t.Error("ok = true, want false when the database is down")
	}
	// The underlying error must not leak on an unauthenticated endpoint.
	if body.Error != "database unreachable" {
		t.Errorf("error = %q, want a generic message", body.Error)
	}
}
