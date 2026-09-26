package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// fakePinger stands in for the store so both health paths are testable without
// a live database. The behaviour that matters is the decision the handler makes
// on Ping's result, not pgx's internals.
type fakePinger struct{ err error }

func (f fakePinger) Ping(context.Context) error { return f.err }

func TestHealthReportsServiceIdentity(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/health", nil)

	newHealthHandler(fakePinger{}).ServeHTTP(rec, req)

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

// TestHealthFailsWhenDatabaseIsDown pins the fix for the bug where /health
// returned 200 {"ok":true} while the database was unreachable, so an uptime
// monitor saw a healthy router that could not serve a single request.
func TestHealthFailsWhenDatabaseIsDown(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/health", nil)

	newHealthHandler(fakePinger{err: errors.New("connection refused")}).ServeHTTP(rec, req)

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
