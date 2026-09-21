package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
)

const serviceName = "fudrouter-router"

// newHealthHandler reports service identity. The data plane must be
// independently identifiable so the control plane can tell it apart from
// the web app in health checks and logs.
func newHealthHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":      true,
			"service": serviceName,
		})
	})
}

func main() {
	addr := os.Getenv("ROUTER_ADDR")
	if addr == "" {
		addr = "0.0.0.0:8100"
	}

	mux := http.NewServeMux()
	mux.Handle("GET /health", newHealthHandler())

	log.Printf("[%s] listening on %s", serviceName, addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("[%s] server failed: %v", serviceName, err)
	}
}
