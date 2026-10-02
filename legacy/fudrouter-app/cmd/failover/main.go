// Zero-delay multi-connection failover proxy for fudrouter (Go rewrite).
//
// Modes:
//   passthrough (default): proxy everything to fudrouter :20128
//   race: race multiple providerConnections for /v1/chat/completions
//
// Build:
//   CGO_ENABLED=0 go build -trimpath -ldflags '-s -w' -o bin/failover ./cmd/failover
//
// Run:
//   FAILOVER_MODE=passthrough ./bin/failover
//   pm2 start bin/failover --name fudrouter-failover --interpreter none
package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "modernc.org/sqlite"
)

type config struct {
	Port              int
	Mode              string // passthrough | race
	Backend           string
	DBPath            string
	ConnTimeout       time.Duration
	RaceTimeout       time.Duration
	DisableCooldown    time.Duration
	MaxRace           int
}

func envInt(key string, def int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

func envDurMS(key string, defMS int) time.Duration {
	return time.Duration(envInt(key, defMS)) * time.Millisecond
}

func loadConfig() config {
	home, _ := os.UserHomeDir()
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = filepath.Join(home, ".fudrouter")
	}
	dbPath := os.Getenv("FAILOVER_DB_PATH")
	if dbPath == "" {
		dbPath = filepath.Join(dataDir, "db", "data.sqlite")
	}
	mode := strings.ToLower(strings.TrimSpace(os.Getenv("FAILOVER_MODE")))
	if mode == "" {
		mode = "passthrough"
	}
	backend := os.Getenv("FAILOVER_BACKEND")
	if backend == "" {
		backend = "http://127.0.0.1:20128"
	}
	return config{
		Port:           envInt("FAILOVER_PORT", 20126),
		Mode:           mode,
		Backend:        backend,
		DBPath:         dbPath,
		ConnTimeout:    envDurMS("FAILOVER_TIMEOUT", 15000),
		RaceTimeout:    envDurMS("FAILOVER_RACE_TIMEOUT", 30000),
		DisableCooldown: envDurMS("FAILOVER_COOLDOWN", 60000),
		MaxRace:        envInt("FAILOVER_MAX_RACE", 4),
	}
}

type tracker struct {
	Status        string
	Failures      int
	DisabledUntil time.Time
	LastStatus    int
}

type connection struct {
	ID       string
	Provider string
	Name     string
	Priority int
	IsActive int
	Data     string
	BaseURL  string
	APIKey   string
}

type server struct {
	cfg     config
	db      *sql.DB
	proxy   *httputil.ReverseProxy
	client  *http.Client
	mu      sync.Mutex
	track   map[string]*tracker
	started time.Time
}

func openDB(path string) (*sql.DB, error) {
	dsn := "file:" + path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetConnMaxLifetime(0)
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

func newServer(cfg config) (*server, error) {
	db, err := openDB(cfg.DBPath)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	backendURL, err := url.Parse(cfg.Backend)
	if err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("backend url: %w", err)
	}
	proxy := httputil.NewSingleHostReverseProxy(backendURL)
	origDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		origDirector(req)
		req.Host = backendURL.Host
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		http.Error(w, `{"error":"Backend unavailable","message":`+strconv.Quote(err.Error())+`}`, http.StatusBadGateway)
	}
	return &server{
		cfg: cfg,
		db:  db,
		proxy: proxy,
		client: &http.Client{
			Timeout: cfg.ConnTimeout,
			Transport: &http.Transport{
				Proxy: http.ProxyFromEnvironment,
				DialContext: (&net.Dialer{
					Timeout:   5 * time.Second,
					KeepAlive: 30 * time.Second,
				}).DialContext,
				ForceAttemptHTTP2:     true,
				MaxIdleConns:          100,
				IdleConnTimeout:       90 * time.Second,
				TLSHandshakeTimeout:   5 * time.Second,
				ExpectContinueTimeout: 1 * time.Second,
			},
		},
		track:   map[string]*tracker{},
		started: time.Now(),
	}, nil
}

func (s *server) close() {
	_ = s.db.Close()
}

func (s *server) getTracker(id string) *tracker {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.track[id]
	if !ok {
		t = &tracker{Status: "active"}
		s.track[id] = t
	}
	return t
}

func (s *server) markFailed(id string, status int, retryAfter int) {
	t := s.getTracker(id)
	s.mu.Lock()
	defer s.mu.Unlock()
	t.Failures++
	t.LastStatus = status
	now := time.Now()
	switch {
	case status == 429:
		d := s.cfg.DisableCooldown
		if retryAfter > 0 {
			d = time.Duration(retryAfter) * time.Second
		}
		t.DisabledUntil = now.Add(d)
		t.Status = "rate_limited"
		log.Printf("[Failover] %s 429 → cooldown %s", id, d)
	case status == 401 || status == 403:
		t.DisabledUntil = now.Add(24 * time.Hour)
		t.Status = "auth_error"
		log.Printf("[Failover] %s %d → disabled 24h", id, status)
	case status >= 500 || status == 408:
		t.DisabledUntil = now.Add(5 * time.Second)
		t.Status = "server_error"
		log.Printf("[Failover] %s %d → cooldown 5s", id, status)
	}
}

func (s *server) markHealthy(id string) {
	t := s.getTracker(id)
	s.mu.Lock()
	defer s.mu.Unlock()
	t.Failures = 0
	t.Status = "active"
	t.DisabledUntil = time.Time{}
}

func (s *server) isDisabled(id string) bool {
	t := s.getTracker(id)
	s.mu.Lock()
	defer s.mu.Unlock()
	if t.DisabledUntil.IsZero() {
		return false
	}
	if time.Now().After(t.DisabledUntil) {
		t.DisabledUntil = time.Time{}
		t.Status = "active"
		return false
	}
	return true
}

func parseConnData(raw string) map[string]any {
	out := map[string]any{}
	if strings.TrimSpace(raw) == "" {
		return out
	}
	_ = json.Unmarshal([]byte(raw), &out)
	return out
}

func strField(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			switch t := v.(type) {
			case string:
				if strings.TrimSpace(t) != "" {
					return t
				}
			}
		}
	}
	return ""
}

func (s *server) activeConnections(provider string) ([]connection, error) {
	rows, err := s.db.Query(`
		SELECT id, provider, COALESCE(name,''), COALESCE(priority,999), isActive, COALESCE(data,'{}'),
		       COALESCE(base_url,''), COALESCE(api_key,'')
		FROM providerConnections
		WHERE provider = ? AND isActive = 1
		ORDER BY priority ASC
	`, provider)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []connection
	for rows.Next() {
		var c connection
		if err := rows.Scan(&c.ID, &c.Provider, &c.Name, &c.Priority, &c.IsActive, &c.Data, &c.BaseURL, &c.APIKey); err != nil {
			return nil, err
		}
		if s.isDisabled(c.ID) {
			continue
		}
		data := parseConnData(c.Data)
		if c.BaseURL == "" {
			c.BaseURL = strField(data, "baseUrl", "base_url", "endpoint")
		}
		if c.APIKey == "" {
			c.APIKey = strField(data, "apiKey", "api_key", "accessToken", "token")
		}
		out = append(out, c)
		if len(out) >= s.cfg.MaxRace {
			break
		}
	}
	return out, rows.Err()
}

func detectProvider(model string) string {
	m := strings.ToLower(strings.TrimSpace(model))
	if m == "" {
		return ""
	}
	if i := strings.IndexByte(m, '/'); i > 0 {
		return m[:i]
	}
	switch {
	case strings.HasPrefix(m, "claude"):
		return "anthropic"
	case strings.HasPrefix(m, "gpt"), strings.HasPrefix(m, "o1"), strings.HasPrefix(m, "o3"), strings.HasPrefix(m, "o4"):
		return "openai"
	case strings.HasPrefix(m, "gemini"):
		return "google"
	case strings.HasPrefix(m, "deepseek"):
		return "deepseek"
	case strings.HasPrefix(m, "qwen"), strings.HasPrefix(m, "qwq"):
		return "qwen"
	case strings.HasPrefix(m, "mistral"):
		return "mistral"
	case strings.HasPrefix(m, "grok"):
		return "xai"
	case strings.HasPrefix(m, "kimi"):
		return "moonshot"
	case strings.HasPrefix(m, "glm"):
		return "zhipu"
	default:
		return ""
	}
}

func chatCompletionsURL(base string) (string, error) {
	u, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	path := strings.TrimRight(u.Path, "/")
	if !strings.HasSuffix(path, "/v1/chat/completions") {
		path += "/v1/chat/completions"
	}
	u.Path = path
	return u.String(), nil
}

type raceResult struct {
	connID     string
	status     int
	header     http.Header
	body       io.ReadCloser
	isStream   bool
	err        error
	statusCode int
	retryAfter int
}

func (s *server) attempt(ctx context.Context, c connection, body []byte, ua string) raceResult {
	if c.BaseURL == "" {
		return raceResult{connID: c.ID, err: errors.New("missing baseUrl"), statusCode: 503}
	}
	if c.APIKey == "" {
		return raceResult{connID: c.ID, err: errors.New("missing apiKey"), statusCode: 401}
	}
	endpoint, err := chatCompletionsURL(c.BaseURL)
	if err != nil {
		return raceResult{connID: c.ID, err: err, statusCode: 400}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return raceResult{connID: c.ID, err: err, statusCode: 500}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	req.Header.Set("Accept", "application/json, text/event-stream")
	if ua == "" {
		ua = "fudrouter-failover-go/1.0"
	}
	req.Header.Set("User-Agent", ua)

	resp, err := s.client.Do(req)
	if err != nil {
		code := 503
		if errors.Is(err, context.DeadlineExceeded) {
			code = 408
		}
		return raceResult{connID: c.ID, err: err, statusCode: code}
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		ct := resp.Header.Get("Content-Type")
		return raceResult{
			connID:   c.ID,
			status:   resp.StatusCode,
			header:   resp.Header.Clone(),
			body:     resp.Body,
			isStream: strings.Contains(ct, "text/event-stream"),
		}
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	_ = resp.Body.Close()
	ra := 0
	if v := resp.Header.Get("Retry-After"); v != "" {
		ra, _ = strconv.Atoi(v)
	}
	return raceResult{
		connID:     c.ID,
		err:        fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(b)),
		statusCode: resp.StatusCode,
		retryAfter: ra,
	}
}

func (s *server) race(ctx context.Context, conns []connection, body []byte, ua string) (raceResult, error) {
	if len(conns) == 0 {
		return raceResult{}, errors.New("no active connections available")
	}
	ctx, cancel := context.WithTimeout(ctx, s.cfg.RaceTimeout)
	defer cancel()

	ch := make(chan raceResult, len(conns))
	var wg sync.WaitGroup
	for _, c := range conns {
		wg.Add(1)
		go func(c connection) {
			defer wg.Done()
			ch <- s.attempt(ctx, c, body, ua)
		}(c)
	}
	go func() {
		wg.Wait()
		close(ch)
	}()

	var lastErr error
	pending := len(conns)
	for r := range ch {
		pending--
		if r.err == nil && r.body != nil {
			s.markHealthy(r.connID)
			// cancel losers by cancelling ctx; drain remaining failures async
			go func() {
				for rest := range ch {
					if rest.body != nil {
						_ = rest.body.Close()
					}
				}
			}()
			cancel()
			return r, nil
		}
		if r.err != nil {
			lastErr = r.err
			s.markFailed(r.connID, r.statusCode, r.retryAfter)
		}
		if pending == 0 {
			break
		}
	}
	if lastErr == nil {
		lastErr = errors.New("all connections failed")
	}
	return raceResult{}, lastErr
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, 200, map[string]any{
		"status":    "ok",
		"mode":      s.cfg.Mode,
		"backend":   s.cfg.Backend,
		"uptime":    time.Since(s.started).Seconds(),
		"timestamp": time.Now().UnixMilli(),
		"runtime":   "go",
	})
}

func (s *server) handleStatus(w http.ResponseWriter, _ *http.Request) {
	rows, err := s.db.Query(`
		SELECT id, provider, COALESCE(name,''), COALESCE(priority,999), isActive, COALESCE(base_url,'')
		FROM providerConnections
		ORDER BY provider, priority
	`)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	defer rows.Close()

	type rowOut struct {
		ID             string `json:"id"`
		Provider       string `json:"provider"`
		Name           string `json:"name"`
		Priority       int    `json:"priority"`
		IsActive       int    `json:"isActive"`
		BaseURL        string `json:"base_url"`
		FailoverStatus string `json:"failoverStatus"`
		Failures       int    `json:"failures"`
		DisabledMs     int64  `json:"disabledMs"`
	}
	var list []rowOut
	now := time.Now()
	for rows.Next() {
		var r rowOut
		if err := rows.Scan(&r.ID, &r.Provider, &r.Name, &r.Priority, &r.IsActive, &r.BaseURL); err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		t := s.getTracker(r.ID)
		s.mu.Lock()
		r.FailoverStatus = t.Status
		r.Failures = t.Failures
		if !t.DisabledUntil.IsZero() && t.DisabledUntil.After(now) {
			r.DisabledMs = t.DisabledUntil.Sub(now).Milliseconds()
		}
		s.mu.Unlock()
		list = append(list, r)
	}
	writeJSON(w, 200, map[string]any{
		"mode":        s.cfg.Mode,
		"backend":     s.cfg.Backend,
		"runtime":     "go",
		"connections": list,
	})
}

func (s *server) handleRaceChat(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	body, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "read body failed"})
		return
	}
	var payload map[string]any
	_ = json.Unmarshal(body, &payload)
	provider := r.Header.Get("X-Nprouter-Provider")
	if provider == "" {
		if p, ok := payload["provider"].(string); ok {
			provider = p
		}
	}
	if provider == "" {
		if m, ok := payload["model"].(string); ok {
			provider = detectProvider(m)
		}
	}
	if provider == "" {
		writeJSON(w, 400, map[string]any{"error": "Cannot determine provider from request"})
		return
	}

	conns, err := s.activeConnections(provider)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	if len(conns) == 0 {
		log.Printf("[Failover] No race pool for %s → passthrough %s", provider, s.cfg.Backend)
		// rebuild request to backend
		backendURL, _ := url.Parse(s.cfg.Backend)
		req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, backendURL.String()+"/v1/chat/completions", bytes.NewReader(body))
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		req.Header.Set("Content-Type", "application/json")
		if auth := r.Header.Get("Authorization"); auth != "" {
			req.Header.Set("Authorization", auth)
		}
		req.Header.Set("User-Agent", r.Header.Get("User-Agent"))
		resp, err := s.client.Do(req)
		if err != nil {
			writeJSON(w, 502, map[string]any{"error": err.Error()})
			return
		}
		defer resp.Body.Close()
		for k, vv := range resp.Header {
			for _, v := range vv {
				w.Header().Add(k, v)
			}
		}
		w.Header().Set("X-Failover-Mode", "passthrough-fallback")
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
		return
	}

	log.Printf("[Failover] Racing %d connections for %s", len(conns), provider)
	res, err := s.race(r.Context(), conns, body, r.Header.Get("User-Agent"))
	if err != nil {
		log.Printf("[Failover] Failed (%s): %v", time.Since(start), err)
		writeJSON(w, 502, map[string]any{
			"error":             "All connections failed",
			"message":           err.Error(),
			"fudrouter_failover": true,
		})
		return
	}
	defer res.body.Close()
	elapsed := time.Since(start)
	log.Printf("[Failover] Won: %s (%s%s)", res.connID, elapsed, map[bool]string{true: " SSE", false: ""}[res.isStream])

	for k, vv := range res.header {
		// hop-by-hop headers skip
		lk := strings.ToLower(k)
		if lk == "connection" || lk == "transfer-encoding" || lk == "keep-alive" {
			continue
		}
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}
	w.Header().Set("X-Failover-Connection", res.connID)
	w.Header().Set("X-Failover-Time", elapsed.String())
	w.Header().Set("X-Failover-Raced", strconv.Itoa(len(conns)))
	w.Header().Set("X-Failover-Mode", "race")
	w.Header().Set("X-Failover-Runtime", "go")
	w.WriteHeader(res.status)
	_, _ = io.Copy(w, res.body)
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/_failover_health", s.handleHealth)
	mux.HandleFunc("/_failover_status", s.handleStatus)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if s.cfg.Mode == "race" && r.URL.Path == "/v1/chat/completions" && r.Method == http.MethodPost {
			s.handleRaceChat(w, r)
			return
		}
		s.proxy.ServeHTTP(w, r)
	})
	return mux
}

func main() {
	cfg := loadConfig()
	srv, err := newServer(cfg)
	if err != nil {
		log.Fatalf("[Failover] init failed: %v", err)
	}
	defer srv.close()

	httpServer := &http.Server{
		Addr:              fmt.Sprintf("127.0.0.1:%d", cfg.Port),
		Handler:           srv.routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			now := time.Now()
			srv.mu.Lock()
			for id, t := range srv.track {
				if !t.DisabledUntil.IsZero() && !t.DisabledUntil.After(now) {
					t.DisabledUntil = time.Time{}
					t.Status = "active"
					log.Printf("[Failover] %s re-enabled", id)
				}
			}
			srv.mu.Unlock()
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Printf("[Failover] listening :%d mode=%s backend=%s db=%s runtime=go", cfg.Port, cfg.Mode, cfg.Backend, cfg.DBPath)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("[Failover] serve: %v", err)
		}
	}()

	<-ctx.Done()
	log.Printf("[Failover] shutting down...")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdownCtx)
}
