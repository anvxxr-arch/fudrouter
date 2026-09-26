package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/anvxxr-arch/fudrouter/services/router/internal/crypt"
	"github.com/anvxxr-arch/fudrouter/services/router/internal/proxy"
	"github.com/anvxxr-arch/fudrouter/services/router/internal/store"
)

const serviceName = "fudrouter-router"

// pinger is the one dependency the health check needs. It is an interface so
// the handler can be tested for both the ready and the not-ready path without a
// live database — the behaviour that matters here is the *decision*, not pgx.
type pinger interface {
	Ping(ctx context.Context) error
}

// newHealthHandler reports service identity AND database readiness. The data
// plane must be independently identifiable so the control plane can tell it
// apart from the web app in health checks and logs — and it must be *honest*:
// the router can serve nothing without the database, so a DB-down state is a
// 503, not a 200. Before this the handler hardcoded {"ok":true}, so an uptime
// monitor saw a healthy router that 500'd every /v1 call.
//
// The failure body is deliberately generic: /health is unauthenticated, so the
// underlying DB error is logged, never returned.
func newHealthHandler(db pinger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := db.Ping(ctx); err != nil {
			log.Printf("[%s] health: database unreachable: %v", serviceName, err)
			w.WriteHeader(http.StatusServiceUnavailable)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":      false,
				"service": serviceName,
				"error":   "database unreachable",
			})
			return
		}
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
	mux.Handle("GET /health", newHealthHandler(st))
	mux.Handle("GET /v1/models", http.HandlerFunc(p.ServeModels))
	mux.Handle("POST /v1/chat/completions", http.HandlerFunc(p.ServeCompletions))
	mux.Handle("/v1/", http.HandlerFunc(p.ServeGeneric))

	// ReadHeaderTimeout bounds the header phase (Slowloris); Read/WriteTimeout
	// stay 0 because a streaming completion legitimately runs for minutes. The
	// previous bare ListenAndServe left the header phase unbounded entirely.
	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	// Graceful shutdown: on SIGINT/SIGTERM drain in-flight requests and run the
	// deferred st.Close(), instead of being killed mid-write.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-stop
		log.Printf("[%s] shutting down", serviceName)
		shCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := srv.Shutdown(shCtx); err != nil {
			log.Printf("[%s] shutdown error: %v", serviceName, err)
		}
	}()

	log.Printf("[%s] listening on %s", serviceName, addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("[%s] server failed: %v", serviceName, err)
	}
}
