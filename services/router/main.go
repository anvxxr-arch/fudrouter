package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"

	"github.com/anvxxr-arch/fudrouter/services/router/internal/crypt"
	"github.com/anvxxr-arch/fudrouter/services/router/internal/proxy"
	"github.com/anvxxr-arch/fudrouter/services/router/internal/store"
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
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatalf("[%s] DATABASE_URL is not set", serviceName)
	}

	ctx := context.Background()
	st, err := store.New(ctx, dsn)
	if err != nil {
		log.Fatalf("[%s] store init: %v", serviceName, err)
	}
	defer st.Close()

	cr, err := crypt.FromEnv()
	if err != nil {
		log.Fatalf("[%s] crypt init: %v", serviceName, err)
	}

	// The OAuth pool needs a refresher; a static-key provider never calls it.
	p := proxy.New(st, cr, nil, proxy.NewXAIRefresher())

	mux := http.NewServeMux()
	mux.Handle("GET /health", newHealthHandler())
	mux.Handle("GET /v1/models", http.HandlerFunc(p.ServeModels))
	mux.Handle("POST /v1/chat/completions", http.HandlerFunc(p.ServeCompletions))
	mux.Handle("/v1/", http.HandlerFunc(p.ServeGeneric))

	log.Printf("[%s] listening on %s", serviceName, addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("[%s] server failed: %v", serviceName, err)
	}
}
