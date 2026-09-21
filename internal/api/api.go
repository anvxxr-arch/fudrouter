package api

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/anvxxr-arch/fudrouter/internal/catalog"
	"github.com/anvxxr-arch/fudrouter/internal/chat"
	"github.com/anvxxr-arch/fudrouter/internal/db"
	"github.com/anvxxr-arch/fudrouter/internal/metrics"
	"github.com/anvxxr-arch/fudrouter/internal/oauth"
	"github.com/anvxxr-arch/fudrouter/internal/tracing"
)

type Server struct {
	DB      *db.DB
	Chat    *chat.Engine
	Cat     *catalog.Catalog
	OAuth   *oauth.Store
	Metrics *metrics.Metrics
	Tracer  *tracing.Tracer
	DataDir string
	Version string
	mux     *http.ServeMux
}

func New(database *db.DB, dataDir, _ string) *Server {
	_ = database.EnsureReady()
	s := &Server{
		DB:      database,
		Chat:    chat.New(database),
		Cat:     catalog.Open(dataDir),
		OAuth:   oauth.NewStore(),
		Metrics: metrics.New(),
		Tracer:  tracing.New(),
		DataDir: dataDir,
		Version: "1.0.0-go",
		mux:     http.NewServeMux(),
	}
	s.routes()
	s.registerCompleteRoutes()
	s.registerOAuthRoutes()
	s.registerKiroRoutes()
	s.registerCursorRoutes()
	s.registerUpdateRoutes()
	s.registerMediaProviderRoutes()
	s.registerCodexRoutes()
	oauth.StartBackgroundRefresh(database)
	return s
}

func (s *Server) Handler() http.Handler {
	return requestID(rateLimit(cors(s.mux)))
}

// requestID middleware: generate or propagate X-Request-ID header
func requestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if id == "" {
			id = randID()
		}
		w.Header().Set("X-Request-ID", id)
		next.ServeHTTP(w, r)
	})
}

// rateLimit middleware: token bucket per IP
func rateLimit(next http.Handler) http.Handler {
	type bucket struct {
		tokens float64
		last   time.Time
	}
	var mu sync.Mutex
	buckets := map[string]*bucket{}
	rate := 10.0  // tokens per second
	capacity := 50.0 // max burst
	if v := os.Getenv("RATE_LIMIT_RATE"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			rate = f
		}
	}
	if v := os.Getenv("RATE_LIMIT_CAPACITY"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			capacity = f
		}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := r.RemoteAddr
		if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
			ip = strings.Split(fwd, ",")[0]
		}
		mu.Lock()
		b, ok := buckets[ip]
		if !ok {
			b = &bucket{tokens: capacity, last: time.Now()}
			buckets[ip] = b
		}
		now := time.Now()
		elapsed := now.Sub(b.last).Seconds()
		b.tokens += elapsed * rate
		if b.tokens > capacity {
			b.tokens = capacity
		}
		b.last = now
		if b.tokens < 1 {
			mu.Unlock()
			writeJSON(w, 429, map[string]any{"error": "rate limit exceeded", "retry_after": time.Second / time.Duration(rate)})
			return
		}
		b.tokens--
		mu.Unlock()
		next.ServeHTTP(w, r)
	})
}

func (s *Server) routes() {
	s.mux.HandleFunc("GET /api/health", s.health)
	s.mux.HandleFunc("GET /api/version", s.version)
	s.mux.HandleFunc("GET /api/auth/status", s.authStatus)
	s.mux.HandleFunc("GET /api/settings", s.getSettings)
	s.mux.HandleFunc("POST /api/settings", s.postSettings)
	s.mux.HandleFunc("PATCH /api/settings", s.postSettings)
	s.mux.HandleFunc("GET /api/keys", s.listKeys)
	s.mux.HandleFunc("GET /api/connections", s.listConnections)
	s.mux.HandleFunc("GET /api/provider-connections", s.listConnections)
	s.mux.HandleFunc("GET /api/usage/stats", s.usageStats)
	s.mux.HandleFunc("GET /api/usage/history", s.usageHistory)
	s.mux.HandleFunc("GET /api/usage", s.usageStats)
	s.mux.HandleFunc("POST /v1/chat/completions", s.chatCompletions)
	s.mux.HandleFunc("POST /api/v1/chat/completions", s.chatCompletions)
	s.mux.HandleFunc("GET /api/logs/stream", s.logsStream)
	s.mux.HandleFunc("GET /metrics", s.metricsHandler)
	s.mux.HandleFunc("GET /api/metrics", s.metricsHandler)
	s.mux.HandleFunc("GET /api/providers/health", s.providersHealth)
	s.mux.HandleFunc("GET /api/traces", s.tracesHandler)
	s.mux.HandleFunc("/api/", s.notFound)
	s.mux.HandleFunc("/api", s.notFound)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Nprouter-Runtime", "go")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{
		"ok":        true,
		"status":    "ok",
		"runtime":   "go",
		"version":   s.Version,
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	})
}

func (s *Server) version(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{
		"currentVersion": s.Version,
		"runtime":        "go",
		"mode":           "production",
		"latestVersion":  nil,
		"hasUpdate":      false,
	})
}

func (s *Server) authStatus(w http.ResponseWriter, r *http.Request) {
	st, _ := s.DB.Settings()
	require := false
	if v, ok := st["requireLogin"].(bool); ok {
		require = v
	}
	_, hasPass := st["password"]
	authenticated := !require
	display := "Go admin"
	if sid := s.sessionID(r); sid != "" {
		if sess, ok, _ := s.DB.GetSession(sid); ok {
			authenticated = true
			if u, ok := sess["user"].(string); ok {
				display = u
			}
		}
	}
	// API key bearer also counts
	if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
		if _, ok, _ := s.DB.FindAPIKey(auth); ok {
			authenticated = true
			display = "api-key"
		}
	}
	writeJSON(w, 200, map[string]any{
		"requireLogin":  require,
		"authenticated": authenticated,
		"authMode":      "password",
		"hasPassword":   hasPass,
		"runtime":       "go",
		"displayName":   display,
		"loginMethod":   "Password",
	})
}

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request) {
	st, err := s.DB.Settings()
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	// never leak password hash
	if _, ok := st["password"]; ok {
		st["password"] = "***"
		st["hasPassword"] = true
	}
	st["runtime"] = "go"
	writeJSON(w, 200, st)
}

func (s *Server) postSettings(w http.ResponseWriter, r *http.Request) {
	var patch map[string]any
	if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
		writeJSON(w, 400, map[string]any{"error": "invalid json"})
		return
	}
	// refuse overwriting password via this path for now
	delete(patch, "password")
	st, err := s.DB.PatchSettings(patch)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	if _, ok := st["password"]; ok {
		st["password"] = "***"
	}
	writeJSON(w, 200, st)
}

func (s *Server) listKeys(w http.ResponseWriter, r *http.Request) {
	keys, err := s.DB.ListAPIKeys()
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	out := make([]map[string]any, 0, len(keys))
	for _, k := range keys {
		out = append(out, map[string]any{
			"id":        k.ID,
			"name":      k.Name,
			"key":       db.MaskKey(k.Key),
			"machineId": k.MachineID,
			"isActive":  k.IsActive == 1,
			"createdAt": k.CreatedAt,
		})
	}
	writeJSON(w, 200, map[string]any{"keys": out, "runtime": "go"})
}

func (s *Server) listConnections(w http.ResponseWriter, r *http.Request) {
	list, err := s.DB.ListConnections()
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	out := make([]map[string]any, 0, len(list))
	for _, c := range list {
		out = append(out, db.ConnPublic(c))
	}
	writeJSON(w, 200, map[string]any{"connections": out, "count": len(out), "runtime": "go"})
}

func (s *Server) usageStats(w http.ResponseWriter, r *http.Request) {
	st, err := s.DB.UsageStats()
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	st["runtime"] = "go"
	writeJSON(w, 200, st)
}

func (s *Server) usageHistory(w http.ResponseWriter, r *http.Request) {
	rows, err := s.DB.RecentUsage(100)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	if rows == nil {
		rows = []db.UsageRow{}
	}
	writeJSON(w, 200, map[string]any{"history": rows, "count": len(rows), "runtime": "go"})
}

func (s *Server) chatCompletions(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "read body failed"})
		return
	}
	model, provider := chat.ParseModel(body)
	if provider == "" {
		provider = r.Header.Get("X-Nprouter-Provider")
	}
	if provider == "" {
		writeJSON(w, 400, map[string]any{"error": "cannot determine provider", "model": model})
		return
	}

	settings, _ := s.DB.Settings()
	mode := "fill-first"
	if v, ok := settings["fallbackStrategy"].(string); ok && v != "" {
		mode = v
	}
	if os.Getenv("FUDROUTER_CHAT_MODE") == "race" {
		mode = "race"
	}

	start := time.Now()
	var res chat.Result
	if mode == "race" {
		res, err = s.Chat.CompleteRace(r.Context(), provider, body)
	} else {
		res, err = s.Chat.CompleteFillFirst(r.Context(), provider, body)
	}
	if err != nil {
		_ = s.DB.RecordUsage(db.UsageRow{Provider: provider, Model: model, Status: "error", Timestamp: time.Now().UTC().Format(time.RFC3339)})
		writeJSON(w, 502, map[string]any{
			"error":    "All connections failed",
			"message":  err.Error(),
			"provider": provider,
			"runtime":  "go",
		})
		return
	}
	defer res.Body.Close()
	_ = s.DB.RecordUsage(db.UsageRow{
		Provider: provider, Model: model, ConnectionID: res.ConnID, Status: "ok",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	})
	for k, vv := range res.Header {
		lk := strings.ToLower(k)
		if lk == "connection" || lk == "transfer-encoding" || lk == "keep-alive" {
			continue
		}
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}
	w.Header().Set("X-Nprouter-Runtime", "go")
	w.Header().Set("X-Nprouter-Connection", res.ConnID)
	w.Header().Set("X-Nprouter-Mode", mode)
	w.Header().Set("X-Nprouter-Time", time.Since(start).String())
	w.WriteHeader(res.Status)
	_, _ = io.Copy(w, res.Body)
}

func (s *Server) notFound(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 404, map[string]any{"error": "not found", "path": r.URL.Path, "runtime": "go"})
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		allowed := false
		for _, o := range allowedOrigins() {
			if o == "*" || o == origin {
				allowed = true
				break
			}
		}
		if allowed {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Nprouter-Provider")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(204)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func allowedOrigins() []string {
	if v := os.Getenv("ALLOWED_ORIGINS"); v != "" {
		return strings.Split(v, ",")
	}
	return []string{"http://localhost:8012", "http://localhost:3000"}
}

func DefaultDataDir() string {
	if v := os.Getenv("DATA_DIR"); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".fudrouter")
}

type LogEntry struct {
	Timestamp string `json:"timestamp"`
	Level     string `json:"level"`
	Message   string `json:"message"`
	Source    string `json:"source"`
}

func (s *Server) logsStream(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	const maxBuf = 512 << 10
	buf := make([]byte, maxBuf)
	n, _ := io.ReadFull(r.Body, buf)
	_ = n
	flusher := w.(http.Flusher)

	home, _ := os.UserHomeDir()
	logPath := filepath.Join(home, ".fudrouter", "logs", "fudrouter.log")

	sendRecent := func() {
		rows, err := s.DB.RecentUsage(20)
		if err != nil {
			return
		}
		for _, row := range rows {
			var level = "info"
			if row.Status != "ok" {
				level = "error"
			}
			var msg = fmt.Sprintf("%s/%s: prompt=%d completion=%d cost=$%.4f", row.Provider, row.Model, row.PromptTokens, row.CompletionTokens, row.Cost)
			if row.Status != "ok" {
				msg = fmt.Sprintf("%s/%s: %s", row.Provider, row.Model, row.Status)
			}
			entry := LogEntry{
				Timestamp: row.Timestamp,
				Level:     level,
				Message:   msg,
				Source:    "usage",
			}
			data, _ := json.Marshal(entry)
			fmt.Fprintf(w, "data: %s\n\n", data)
		}
		flusher.Flush()
	}

	sendRecent()

	f, err := os.Open(logPath)
	if err != nil {
		// No file? Send updates from DB
		ticker := time.NewTicker(3 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case <-ticker.C:
				rows, err := s.DB.RecentUsage(5)
				if err != nil {
					continue
				}
				for _, row := range rows {
					entry := LogEntry{
						Timestamp: row.Timestamp,
						Level:     "info",
						Message:   fmt.Sprintf("%s/%s: %d tokens", row.Provider, row.Model, row.CompletionTokens),
						Source:    "usage",
					}
					if row.Status != "ok" {
						entry.Level = "error"
					}
					data, _ := json.Marshal(entry)
					fmt.Fprintf(w, "data: %s\n\n", data)
				}
				flusher.Flush()
			}
		}
	}
	defer f.Close()

	stat, _ := f.Stat()
	f.Seek(stat.Size(), 0)
	scanner := bufio.NewScanner(f)
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			for scanner.Scan() {
				line := scanner.Text()
				var level = "info"
				if strings.Contains(line, "error") || strings.Contains(line, "ERROR") {
					level = "error"
				} else if strings.Contains(line, "warn") || strings.Contains(line, "WARN") {
					level = "warn"
				}
				entry := LogEntry{
					Timestamp: time.Now().Format(time.RFC3339),
					Level:     level,
					Message:   line,
					Source:    "fudrouter",
				}
				data, _ := json.Marshal(entry)
				fmt.Fprintf(w, "data: %s\n\n", data)
			}
			flusher.Flush()
		}
	}
}

func (s *Server) logsHandler(w http.ResponseWriter, r *http.Request) {
	home, _ := os.UserHomeDir()
	logPath := filepath.Join(home, ".fudrouter", "logs", "fudrouter.log")
	b, err := os.ReadFile(logPath)
	if err != nil {
		writeJSON(w, 404, map[string]any{"error": "no log file found"})
		return
	}
	w.Header().Set("Content-Type", "text/plain")
	_, _ = w.Write(b)
}

func (s *Server) metricsHandler(w http.ResponseWriter, r *http.Request) {
	s.Metrics.Handler().ServeHTTP(w, r)
}

func (s *Server) tracesHandler(w http.ResponseWriter, r *http.Request) {
	s.Tracer.Handler().ServeHTTP(w, r)
}

func (s *Server) providersHealth(w http.ResponseWriter, r *http.Request) {
	connections, err := s.DB.ListConnections()
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}

	type providerHealth struct {
		ProviderID string `json:"providerId"`
		Healthy    bool   `json:"healthy"`
		Latency    int64  `json:"latencyMs"`
		Error      string `json:"error,omitempty"`
	}

	out := make([]providerHealth, 0, len(connections))
	for _, c := range connections {
		if c.IsActive != 1 {
			continue
		}
		// Simple health check: try to reach the provider's base URL
		start := time.Now()
		healthy := true
		errMsg := ""
		if c.BaseURL != "" {
			client := &http.Client{Timeout: 5 * time.Second}
			req, err := http.NewRequest(http.MethodGet, c.BaseURL+"/models", nil)
			if err == nil && c.APIKey != "" {
				req.Header.Set("Authorization", "Bearer "+c.APIKey)
			}
			if err == nil {
				resp, err := client.Do(req)
				if err != nil {
					healthy = false
					errMsg = err.Error()
				} else {
					resp.Body.Close()
					if resp.StatusCode >= 400 {
						healthy = false
						errMsg = fmt.Sprintf("HTTP %d", resp.StatusCode)
					}
				}
			}
		}
		latency := time.Since(start).Milliseconds()
		out = append(out, providerHealth{
			ProviderID: c.Provider,
			Healthy:    healthy,
			Latency:    latency,
			Error:      errMsg,
		})
	}

	writeJSON(w, 200, map[string]any{"providers": out})
}
