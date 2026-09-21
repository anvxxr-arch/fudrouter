package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudrouter/internal/db"
	"github.com/anvxxr-arch/fudrouter/internal/oauth"
)

func (s *Server) registerOAuthRoutes() {
	if s.OAuth == nil {
		s.OAuth = oauth.NewStore()
	}
	s.mux.HandleFunc("GET /api/oauth/providers", s.oauthProviders)
	s.mux.HandleFunc("POST /api/oauth/{provider}/start", s.oauthStart)
	s.mux.HandleFunc("GET /api/oauth/{provider}/start", s.oauthStart)
	s.mux.HandleFunc("GET /api/oauth/{provider}/status", s.oauthStatus)
	s.mux.HandleFunc("POST /api/oauth/{provider}/poll", s.oauthPoll)
	s.mux.HandleFunc("GET /api/oauth/{provider}/poll", s.oauthPoll)
	s.mux.HandleFunc("POST /api/oauth/{provider}/complete", s.oauthComplete)
	s.mux.HandleFunc("GET /api/oauth/{provider}/callback", s.oauthCallback)
	s.mux.HandleFunc("POST /api/oauth/{provider}/callback", s.oauthCallback)
	s.mux.HandleFunc("POST /api/oauth/{provider}/save", s.oauthSave)
	s.mux.HandleFunc("POST /api/oauth/refresh", s.oauthRefreshAll)
	s.mux.HandleFunc("POST /api/oauth/{provider}/refresh", s.oauthRefreshOne)
	// generic dynamic route used by Next UI
	s.mux.HandleFunc("POST /api/oauth/{provider}/{action}", s.oauthAction)
	s.mux.HandleFunc("GET /api/oauth/{provider}/{action}", s.oauthAction)
}

func (s *Server) oauthProviders(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{
		"runtime": "go",
		"providers": []map[string]any{
			{"id": "xai", "name": "xAI / Grok", "flow": "pkce", "refreshable": true},
			{"id": "qoder", "name": "Qoder", "flow": "device", "refreshable": false},
			{"id": "xiaomi-mimo", "name": "Xiaomi MiMo", "flow": "ecdh", "refreshable": false},
			{"id": "kiro", "name": "AWS Kiro", "flow": "social+device+import", "refreshable": true},
			{"id": "cursor", "name": "Cursor IDE", "flow": "import+auto-import", "refreshable": false},
			{"id": "codex", "name": "OpenAI Codex", "flow": "pkce+import", "refreshable": true},
		},
	})
}

func (s *Server) oauthAction(w http.ResponseWriter, r *http.Request) {
	action := r.PathValue("action")
	switch action {
	case "start":
		s.oauthStart(w, r)
	case "poll":
		s.oauthPoll(w, r)
	case "complete", "exchange":
		s.oauthComplete(w, r)
	case "callback":
		s.oauthCallback(w, r)
	case "save", "import":
		s.oauthSave(w, r)
	case "status":
		s.oauthStatus(w, r)
	case "refresh":
		s.oauthRefreshOne(w, r)
	default:
		writeJSON(w, 404, map[string]any{"error": "unknown oauth action", "action": action, "runtime": "go"})
	}
}

func (s *Server) oauthStart(w http.ResponseWriter, r *http.Request) {
	provider := strings.ToLower(r.PathValue("provider"))
	var body map[string]any
	_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body)
	redirectURI, _ := body["redirectUri"].(string)
	if redirectURI == "" {
		redirectURI = r.URL.Query().Get("redirect_uri")
	}

	ctx := r.Context()
	var p *oauth.Pending
	var err error
	switch provider {
	case "xai", "grok", "grok-cli":
		if redirectURI == "" {
			// Prefer dashboard-mediated callback on API edge
			redirectURI = fmt.Sprintf("http://127.0.0.1:8011/api/oauth/xai/callback")
		}
		p, err = oauth.StartXAI(ctx, s.OAuth, redirectURI)
	case "qoder":
		p, err = oauth.StartQoder(s.OAuth)
	case "xiaomi-mimo", "xiaomi", "mimo":
		if redirectURI == "" {
			redirectURI = "http://127.0.0.1:8011/api/oauth/xiaomi-mimo/callback"
		}
		p, err = oauth.StartXiaomi(s.OAuth, redirectURI)
	default:
		writeJSON(w, 400, map[string]any{"error": "unsupported provider", "provider": provider})
		return
	}
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{
		"ok":          true,
		"sessionId":   p.ID,
		"provider":    p.Provider,
		"authUrl":     p.AuthURL,
		"redirectUri": p.RedirectURI,
		"status":      p.Status,
		"runtime":     "go",
	})
}

func (s *Server) oauthStatus(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("sessionId")
	if id == "" {
		id = r.URL.Query().Get("id")
	}
	p, ok := s.OAuth.Get(id)
	if !ok {
		writeJSON(w, 404, map[string]any{"error": "session not found"})
		return
	}
	writeJSON(w, 200, map[string]any{
		"ok":        true,
		"sessionId": p.ID,
		"provider":  p.Provider,
		"status":    p.Status,
		"error":     p.Error,
		"result":    redactOAuthResult(p.Result),
		"runtime":   "go",
	})
}

func (s *Server) oauthPoll(w http.ResponseWriter, r *http.Request) {
	provider := strings.ToLower(r.PathValue("provider"))
	id := r.URL.Query().Get("sessionId")
	if id == "" {
		var body map[string]any
		_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body)
		id, _ = body["sessionId"].(string)
	}
	if provider != "qoder" {
		// status check for non-device flows
		s.oauthStatus(w, r)
		return
	}
	p, err := oauth.PollQoder(r.Context(), s.OAuth, id)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error(), "status": "error"})
		return
	}
	writeJSON(w, 200, map[string]any{
		"ok":        true,
		"sessionId": p.ID,
		"status":    p.Status,
		"result":    redactOAuthResult(p.Result),
		"runtime":   "go",
	})
}

func (s *Server) oauthComplete(w http.ResponseWriter, r *http.Request) {
	provider := strings.ToLower(r.PathValue("provider"))
	var body map[string]any
	_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body)
	sessionID, _ := body["sessionId"].(string)
	if sessionID == "" {
		sessionID, _ = body["id"].(string)
	}
	code, _ := body["code"].(string)
	state, _ := body["state"].(string)
	uParam, _ := body["u"].(string)

	var p *oauth.Pending
	var err error
	switch provider {
	case "xai", "grok", "grok-cli":
		p, err = oauth.CompleteXAI(r.Context(), s.OAuth, sessionID, code, state)
	case "xiaomi-mimo", "xiaomi", "mimo":
		p, err = oauth.CompleteXiaomi(s.OAuth, sessionID, uParam)
	case "qoder":
		p, err = oauth.PollQoder(r.Context(), s.OAuth, sessionID)
	default:
		writeJSON(w, 400, map[string]any{"error": "unsupported provider"})
		return
	}
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{
		"ok":        true,
		"sessionId": p.ID,
		"status":    p.Status,
		"result":    redactOAuthResult(p.Result),
		"runtime":   "go",
	})
}

func (s *Server) oauthCallback(w http.ResponseWriter, r *http.Request) {
	provider := strings.ToLower(r.PathValue("provider"))
	q := r.URL.Query()
	sessionID := q.Get("sessionId")
	if sessionID == "" {
		sessionID = q.Get("state") // may match pending state for xai if we used state as id — not always
	}
	// Prefer explicit session via cookie-less query; else match by state for xai
	if sessionID == "" || (provider == "xai" && q.Get("code") != "") {
		// find by state
		state := q.Get("state")
		if state != "" {
			// linear scan via complete with state-only not supported; store doesn't index by state
			// Accept sessionId required for xai dashboard flow. If only state, try body.
		}
	}

	code := q.Get("code")
	state := q.Get("state")
	uParam := q.Get("u")

	// For xai: if sessionId missing, try state as session lookup is not by state —
	// UI should pass sessionId. Also support POST form.
	if r.Method == http.MethodPost {
		_ = r.ParseForm()
		if code == "" {
			code = r.Form.Get("code")
		}
		if state == "" {
			state = r.Form.Get("state")
		}
		if uParam == "" {
			uParam = r.Form.Get("u")
		}
		if sessionID == "" {
			sessionID = r.Form.Get("sessionId")
		}
	}

	var p *oauth.Pending
	var err error
	switch {
	case provider == "xai" || provider == "grok":
		if sessionID == "" {
			sessionID = state // StartXAI sets state = session id
		}
		if sessionID == "" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`<!doctype html><html><body><h3>xAI OAuth</h3><p>Missing sessionId/state. Start from dashboard.</p></body></html>`))
			return
		}
		p, err = oauth.CompleteXAI(r.Context(), s.OAuth, sessionID, code, state)
	case provider == "xiaomi-mimo" || provider == "xiaomi":
		if sessionID == "" {
			sessionID = q.Get("sid")
		}
		if sessionID == "" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`<!doctype html><html><body><h3>Xiaomi OAuth</h3><p>Missing sessionId.</p></body></html>`))
			return
		}
		p, err = oauth.CompleteXiaomi(s.OAuth, sessionID, uParam)
	default:
		writeJSON(w, 400, map[string]any{"error": "callback not supported for provider"})
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err != nil {
		w.WriteHeader(400)
		_, _ = fmt.Fprintf(w, `<!doctype html><html><body><h3>OAuth failed</h3><pre>%s</pre></body></html>`, htmlEscape(err.Error()))
		return
	}
	// auto-save connection
	if p != nil && p.Status == "done" && p.Result != nil {
		_, _ = s.saveOAuthResult(p)
	}
	_, _ = w.Write([]byte(`<!doctype html><html><body><h3>Account linked</h3><p>You can close this tab.</p><script>setTimeout(()=>window.close(),800)</script></body></html>`))
}

func (s *Server) oauthSave(w http.ResponseWriter, r *http.Request) {
	provider := strings.ToLower(r.PathValue("provider"))
	var body map[string]any
	_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body)
	sessionID, _ := body["sessionId"].(string)
	p, ok := s.OAuth.Get(sessionID)
	if !ok || p.Status != "done" {
		writeJSON(w, 400, map[string]any{"error": "session not ready"})
		return
	}
	if provider != "" && p.Provider != provider && provider != "xai" {
		// allow alias
	}
	c, err := s.saveOAuthResult(p)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "connection": c, "runtime": "go"})
}

func (s *Server) saveOAuthResult(p *oauth.Pending) (db.Connection, error) {
	res := p.Result
	if res == nil {
		return db.Connection{}, fmt.Errorf("no result")
	}
	provider := p.Provider
	if v, ok := res["provider"].(string); ok && v != "" {
		provider = v
	}
	access, _ := res["accessToken"].(string)
	if access == "" {
		access, _ = res["sk"].(string)
	}
	refresh, _ := res["refreshToken"].(string)
	email, _ := res["email"].(string)
	name, _ := res["name"].(string)
	if name == "" {
		name = email
	}
	if name == "" {
		name = provider + "-oauth"
	}
	baseURL, _ := res["baseUrl"].(string)
	if baseURL == "" {
		baseURL, _ = res["apiBaseUrl"].(string)
	}
	data := map[string]any{}
	for k, v := range res {
		data[k] = v
	}
	data["accessToken"] = access
	if refresh != "" {
		data["refreshToken"] = refresh
	}
	c := db.Connection{
		Provider: provider,
		AuthType: "oauth",
		Name:     name,
		Email:    email,
		Priority: 10,
		IsActive: 1,
		Data:     data,
		BaseURL:  baseURL,
		APIKey:   access,
	}
	return s.DB.UpsertConnection(c)
}

func (s *Server) oauthRefreshAll(w http.ResponseWriter, r *http.Request) {
	// kick one tick synchronously for due tokens
	conns, _ := s.DB.ListConnections()
	n := 0
	for _, c := range conns {
		if c.IsActive != 1 || !strings.EqualFold(c.AuthType, "oauth") {
			continue
		}
		rt := ""
		if c.Data != nil {
			rt, _ = c.Data["refreshToken"].(string)
		}
		if rt == "" {
			continue
		}
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		var err error
		switch strings.ToLower(c.Provider) {
		case "xai", "grok", "grok-cli":
			tok, e := oauth.RefreshXAI(ctx, rt)
			if e == nil {
				if at, ok := tok["access_token"].(string); ok {
					c.APIKey = at
					c.Data["accessToken"] = at
				}
				if nrt, ok := tok["refresh_token"].(string); ok && nrt != "" {
					c.Data["refreshToken"] = nrt
				}
				if exp, ok := tok["expires_in"].(float64); ok {
					c.Data["expiresAt"] = time.Now().Add(time.Duration(exp) * time.Second).UTC().Format(time.RFC3339)
				}
				_, err = s.DB.UpsertConnection(c)
				if err == nil {
					n++
				}
			}
		}
		cancel()
	}
	writeJSON(w, 200, map[string]any{"ok": true, "refreshed": n, "runtime": "go"})
}

func (s *Server) oauthRefreshOne(w http.ResponseWriter, r *http.Request) {
	provider := strings.ToLower(r.PathValue("provider"))
	var body map[string]any
	_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body)
	id, _ := body["id"].(string)
	conns, _ := s.DB.ListConnections()
	for _, c := range conns {
		if id != "" && c.ID != id {
			continue
		}
		if provider != "" && !strings.EqualFold(c.Provider, provider) && !(provider == "xai" && (c.Provider == "grok" || c.Provider == "grok-cli")) {
			if id == "" {
				continue
			}
		}
		rt := ""
		if c.Data != nil {
			rt, _ = c.Data["refreshToken"].(string)
		}
		if rt == "" {
			writeJSON(w, 400, map[string]any{"error": "no refresh token"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		tok, err := oauth.RefreshXAI(ctx, rt)
		if strings.EqualFold(c.Provider, "qoder") {
			tok, err = oauth.RefreshQoder(ctx, rt)
		}
		if err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		if c.Data == nil {
			c.Data = map[string]any{}
		}
		if at, ok := tok["access_token"].(string); ok {
			c.APIKey = at
			c.Data["accessToken"] = at
		}
		if nrt, ok := tok["refresh_token"].(string); ok && nrt != "" {
			c.Data["refreshToken"] = nrt
		}
		out, err := s.DB.UpsertConnection(c)
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "connection": out, "runtime": "go"})
		return
	}
	writeJSON(w, 404, map[string]any{"error": "connection not found"})
}

func redactOAuthResult(m map[string]any) map[string]any {
	if m == nil {
		return nil
	}
	out := map[string]any{}
	for k, v := range m {
		lk := strings.ToLower(k)
		if strings.Contains(lk, "token") || lk == "sk" || strings.Contains(lk, "secret") {
			if s, ok := v.(string); ok && len(s) > 8 {
				out[k] = s[:4] + "…" + s[len(s)-4:]
				continue
			}
			out[k] = "[redacted]"
			continue
		}
		out[k] = v
	}
	return out
}

func htmlEscape(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	return s
}

// Ensure unused import keep for net if needed by loopback helpers later
var _ = net.Listen
