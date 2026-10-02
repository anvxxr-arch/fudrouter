package main

import (
	"context"
	"embed"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/anvxxr-arch/fudrouter/internal/api"
	"github.com/anvxxr-arch/fudrouter/internal/catalog"
	"github.com/anvxxr-arch/fudrouter/internal/db"
	"github.com/anvxxr-arch/fudrouter/internal/mitm"
	"github.com/anvxxr-arch/fudrouter/internal/provider"
)

//go:embed web/dist/*
var webFS embed.FS

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	// Production Go-only:
	//   API  :8011
	//   UI   :8012  (also public edge target — proxies /api and /v1 to API)
	apiAddr := env("FUDROUTER_API_ADDR", "0.0.0.0:8011")
	webAddr := env("FUDROUTER_WEB_ADDR", "0.0.0.0:8012")
	dataDir := api.DefaultDataDir()

	database, err := db.Open(dataDir)
	if err != nil {
		slog.Error("db open failed", "error", err)
		os.Exit(1)
	}
	defer database.Close()

	// Bootstrap provider registry from catalog
	cat := catalog.Open(dataDir)
	provider.Bootstrap(cat)

	// No Node fallback. Pure Go production.
	apiSrv := api.New(database, dataDir, "")
	apiHTTP := &http.Server{
		Addr:              apiAddr,
		Handler:           apiSrv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	apiTarget, err := url.Parse("http://" + loopback(apiAddr))
	if err != nil {
		slog.Error("failed to parse API target", "error", err)
		os.Exit(1)
	}
	apiProxy := httputil.NewSingleHostReverseProxy(apiTarget)
	orig := apiProxy.Director
	apiProxy.Director = func(r *http.Request) {
		orig(r)
		r.Host = apiTarget.Host
	}

	sub, err := fs.Sub(webFS, "web/dist")
	if err != nil {
		slog.Error("failed to open web assets", "error", err)
		os.Exit(1)
	}
	files := http.FileServer(http.FS(sub))

	webMux := http.NewServeMux()

	// serve MITM CA cert from data dir (best effort)
	webMux.HandleFunc("/mitm/rootCA.crt", func(w http.ResponseWriter, r *http.Request) {
		caPath := filepath.Join(dataDir, "mitm", "rootCA.crt")
		b, err := os.ReadFile(caPath)
		if err != nil {
			http.Error(w, "CA cert not generated yet — start fudrouter with MITM enabled", 404)
			return
		}
		w.Header().Set("Content-Type", "application/x-x509-ca-cert")
		w.Header().Set("Content-Disposition", `attachment; filename="fudrouter-rootCA.crt"`)
		_, _ = w.Write(b)
	})
	webMux.HandleFunc("/api/", apiProxy.ServeHTTP)
	webMux.HandleFunc("/api", apiProxy.ServeHTTP)
	webMux.HandleFunc("/v1/", apiProxy.ServeHTTP)
	webMux.HandleFunc("/v1", apiProxy.ServeHTTP)
	// legacy Next paths
	webMux.HandleFunc("/dashboard", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/", http.StatusTemporaryRedirect)
	})
	webMux.HandleFunc("/dashboard/", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/", http.StatusTemporaryRedirect)
	})
	webMux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Try to serve static file first
		if r.URL.Path != "/" {
			f, err := sub.Open(r.URL.Path[1:])
			if err == nil {
				defer f.Close()
				files.ServeHTTP(w, r)
				return
			}
		}
		// SPA fallback: serve index.html for all other routes
		f, err := sub.Open("index.html")
		if err != nil {
			http.Error(w, "missing ui", 500)
			return
		}
		defer f.Close()
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.Copy(w, f)
	})

	webHTTP := &http.Server{
		Addr:              webAddr,
		Handler:           webMux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		slog.Info("starting API server", "addr", apiAddr, "data_dir", dataDir)
		if err := apiHTTP.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("API server failed", "error", err)
			os.Exit(1)
		}
	}()
	go func() {
		slog.Info("starting web UI", "addr", webAddr, "api_target", apiAddr)
		if err := webHTTP.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("web server failed", "error", err)
			os.Exit(1)
		}
	}()

	// MITM (optional, default on). Binds :443 or FUDROUTER_MITM_ADDR.
	mitmEnabled := env("FUDROUTER_MITM", "1") != "0"
	if mitmEnabled {
		mitmAddr := env("FUDROUTER_MITM_ADDR", ":443")
		m, err := mitm.New(dataDir, mitmAddr, "http://"+loopback(apiAddr))
		if err != nil {
			slog.Error("MITM init failed", "error", err)
		} else {
			go func() {
				slog.Info("starting MITM proxy", "addr", mitmAddr, "ca", mitm.CAPath(dataDir))
				if err := m.ListenAndServe(); err != nil {
					// :443 often needs cap_net_bind_service — retry high port
					if strings.Contains(err.Error(), "permission denied") || strings.Contains(err.Error(), "bind") {
						alt := env("FUDROUTER_MITM_FALLBACK_ADDR", ":8443")
						slog.Warn("MITM bind failed, falling back", "addr", mitmAddr, "error", err, "fallback", alt)
						m2, err2 := mitm.New(dataDir, alt, "http://"+loopback(apiAddr))
						if err2 != nil {
							slog.Error("MITM fallback init failed", "error", err2)
							return
						}
						if err3 := m2.ListenAndServe(); err3 != nil {
							slog.Error("MITM fallback failed", "error", err3)
						}
						return
					}
					slog.Error("MITM stopped", "error", err)
				}
			}()
			// best-effort hosts entries (needs root)
			if err := mitm.EnsureHosts(); err != nil {
				slog.Warn("MITM hosts entries skipped", "error", err)
			}
		}
	}

	<-ctx.Done()
	slog.Info("shutting down")
	sh, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = apiHTTP.Shutdown(sh)
	_ = webHTTP.Shutdown(sh)
}

func loopback(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	if host == "0.0.0.0" || host == "" || host == "::" {
		host = "127.0.0.1"
	}
	return net.JoinHostPort(host, port)
}
