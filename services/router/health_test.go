package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthReportsServiceIdentity(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/health", nil)

	newHealthHandler().ServeHTTP(rec, req)

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
