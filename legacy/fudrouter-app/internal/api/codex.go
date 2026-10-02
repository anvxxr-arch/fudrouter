package api

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/anvxxr-arch/fudrouter/internal/oauth"
)

func (s *Server) registerCodexRoutes() {
	s.mux.HandleFunc("POST /api/oauth/codex/start", s.codexStart)
	s.mux.HandleFunc("GET /api/oauth/codex/start", s.codexStart)
	s.mux.HandleFunc("GET /api/oauth/codex/callback", s.codexCallback)
	s.mux.HandleFunc("POST /api/oauth/codex/callback", s.codexCallback)
	s.mux.HandleFunc("POST /api/oauth/codex/import-token", s.codexImport)
	s.mux.HandleFunc("POST /api/oauth/codex/bulk-import", s.codexBulkImport)
	s.mux.HandleFunc("POST /api/oauth/codex/refresh", s.codexRefresh)
	s.mux.HandleFunc("GET /api/oauth/codex/usage", s.codexUsage)
	s.mux.HandleFunc("POST /api/oauth/codex/reset-credits", s.codexReset)
}

func (s *Server) codexStart(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body)
	redirectURI, _ := body["redirectUri"].(string)
	p, err := oauth.StartCodexPKCE(r.Context(), s.OAuth, redirectURI)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{
		"ok": true, "sessionId": p.ID, "authUrl": p.AuthURL, "provider": "codex", "runtime": "go",
	})
}

func (s *Server) codexCallback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	sessionID := q.Get("sessionId")
	if sessionID == "" {
		sessionID = q.Get("state")
	}
	code := q.Get("code")
	if r.Method == http.MethodPost {
		_ = r.ParseForm()
		if code == "" {
			code = r.Form.Get("code")
		}
		if sessionID == "" {
			sessionID = r.Form.Get("sessionId")
		}
	}
	p, err := oauth.ExchangeCodexCode(r.Context(), s.OAuth, sessionID, code)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err != nil {
		w.WriteHeader(400)
		_, _ = w.Write([]byte("<!doctype html><html><body><h3>Codex OAuth failed</h3><p>" + htmlEscape(err.Error()) + "</p></body></html>"))
		return
	}
	if p != nil && p.Status == "done" && p.Result != nil {
		_, _ = s.saveOAuthResult(p)
	}
	_, _ = w.Write([]byte("<!doctype html><html><body><h3>Codex account linked</h3><script>setTimeout(()=>window.close(),800)</script></body></html>"))
}

func (s *Server) codexImport(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	_ = json.NewDecoder(io.LimitReader(r.Body, 2<<20)).Decode(&body)
	token := firstStr(body, "accessToken", "access_token", "token")
	name := firstStr(body, "name")
	res, err := oauth.ImportCodexToken(token, name)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	c, err := s.upsertFromOAuthMap(res)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "connection": c, "runtime": "go"})
}

func (s *Server) codexBulkImport(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Items []map[string]any `json:"items"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&body)
	out := []map[string]any{}
	imported := 0
	for i, item := range body.Items {
		token := firstStr(item, "accessToken", "access_token", "token")
		name := firstStr(item, "name")
		res, err := oauth.ImportCodexToken(token, name)
		if err != nil {
			out = append(out, map[string]any{"index": i, "ok": false, "error": err.Error()})
			continue
		}
		c, err := s.upsertFromOAuthMap(res)
		if err != nil {
			out = append(out, map[string]any{"index": i, "ok": false, "error": err.Error()})
			continue
		}
		out = append(out, map[string]any{"index": i, "ok": true, "id": c.ID})
		imported++
	}
	writeJSON(w, 200, map[string]any{"ok": true, "imported": imported, "total": len(body.Items), "results": out})
}

func (s *Server) codexRefresh(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body)
	refresh := firstStr(body, "refreshToken", "refresh_token")
	tok, err := oauth.RefreshCodex(r.Context(), refresh)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "tokens": tok, "runtime": "go"})
}

func (s *Server) codexUsage(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" {
		token = r.Header.Get("Authorization")
	}
	usage, err := oauth.CodexUsage(r.Context(), trimBearer(token))
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "usage": usage, "runtime": "go"})
}

func (s *Server) codexReset(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body)
	token := firstStr(body, "token", "accessToken")
	if token == "" {
		token = trimBearer(r.Header.Get("Authorization"))
	}
	res, err := oauth.CodexResetCredits(r.Context(), token)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "reset": res, "runtime": "go"})
}

func trimBearer(s string) string {
	return trimPrefix(trimPrefix(s, "Bearer "), "bearer ")
}

func trimPrefix(s, p string) string {
	if len(s) > len(p) && s[:len(p)] == p {
		return s[len(p):]
	}
	return s
}
