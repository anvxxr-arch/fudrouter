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

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/crypt"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/proxy"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/vk"
)

const serviceName = "fudrouter-router"

// pinger is the one dependency the health check needs. It is an interface so
// the handler can be tested for both the ready and the not-ready path without a
// live database — the behaviour that matters here is the *decision*, not pgx.
type pinger interface {
	Ping(ctx context.Context) error
}

// cacheReporter is the cache-hit tally the health body reports (owner rule 19:
// the cache must serve ≥60% of reads). It is an interface, not a concrete
// *vk.live, so the handler stays testable without a Valkey server — and so a
// nil client (no cache configured) is a valid, zero-reporting configuration.
type cacheReporter interface {
	CacheStats() vk.CacheStats
}

// newHealthHandler reports service identity, database readiness, and the
// process's cache-hit rate. The data plane must be independently identifiable
// so the control plane can tell it apart from the web app in health checks and
// logs — and it must be *honest*: the router can serve nothing without the
// database, so a DB-down state is a 503, not a 200. Before this the handler
// hardcoded {"ok":true}, so an uptime monitor saw a healthy router that 500'd
// every /v1 call.
//
// The failure body is deliberately generic: /health is unauthenticated, so the
// underlying DB error is logged, never returned.
func newHealthHandler(db pinger, cache cacheReporter) http.Handler {
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
		body := map[string]any{
			"ok":      true,
			"service": serviceName,
		}
		// The cache tally is reported only when a cache is configured: a nil
		// client means "no cache layer", and a 0% hit rate there would read as
		// a failing cache rather than an absent one.
		if cache != nil {
			s := cache.CacheStats()
			body["cache"] = map[string]any{
				"hits":     s.Hits,
				"misses":   s.Misses,
				"hit_rate": s.HitRate(),
			}
		}
		_ = json.NewEncoder(w).Encode(body)
	})
}

// newMux builds the entire public surface.
//
// Delegates to proxy.ServeMux so the entrypoint and the tests agree on ONE route
// table. The copy that lived here was four mux.Handle lines nothing asserted, so
// adding a route, renaming one, or letting an exact pattern drift into the `/v1/`
// catch-all changed the API surface silently. See proxy.ServeMux for why the
// catch-all makes that worth pinning.
func newMux(p *proxy.Handler, db pinger, cache cacheReporter) *http.ServeMux {
	return proxy.ServeMux(p, newHealthHandler(db, cache))
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

	// Valkey is the cache/counter layer (spec §12): rate limits, budgets and
	// circuit state. An absent/empty VALKEY_URL disables it cleanly and the S0
	// in-process limiter takes over — a configuration, not a failure.
	c, err := vk.NewFromEnv()
	if err != nil {
		log.Fatalf("[%s] valkey init: %v", serviceName, err)
	}
	// The OAuth pool needs a refresher; a static-key provider never calls it.
	p := proxy.New(st, cr, nil, proxy.NewXAIRefresher(), c)
	// Model health sweeper: background probes that fill the catalogue's
	// `health` field. Dies with ctx; ctx is process-wide here, so the sweeper
	// lives and dies with main exactly like the pools.
	p.StartHealthSweeper(ctx)

	mux := newMux(p, st, c)

	// RecoverMiddleware wraps the whole mux so a hot-path panic becomes a taxonomy
	// 500 (and a logged stack) instead of a closed connection and a lost
	// request_log row (F7). It lives here, not in ServeMux, because the contracts
	// route extractor records each mux.Handle handler verbatim and wrapping there
	// would rewrite the frozen routes.json (see RecoverMiddleware).
	//
	// ReadHeaderTimeout bounds the header phase (Slowloris); Read/WriteTimeout
	// stay 0 because a streaming completion legitimately runs for minutes. The
	// previous bare ListenAndServe left the header phase unbounded entirely.
	srv := &http.Server{
		Addr:              addr,
		Handler:           proxy.RecoverMiddleware(p, mux),
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
