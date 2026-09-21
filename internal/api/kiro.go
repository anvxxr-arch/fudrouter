package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudrouter/internal/db"
	"github.com/anvxxr-arch/fudrouter/internal/oauth"
)

func (s *Server) registerKiroRoutes() {
	s.mux.HandleFunc("POST /api/oauth/kiro/social-authorize", s.kiroSocialAuthorize)
	s.mux.HandleFunc("GET /api/oauth/kiro/social-authorize", s.kiroSocialAuthorize)
	s.mux.HandleFunc("POST /api/oauth/kiro/social-exchange", s.kiroSocialExchange)
	s.mux.HandleFunc("POST /api/oauth/kiro/import", s.kiroImport)
	s.mux.HandleFunc("POST /api/oauth/kiro/import-cli-proxy", s.kiroImportCLIProxy)
	s.mux.HandleFunc("POST /api/oauth/kiro/api-key", s.kiroAPIKey)
	s.mux.HandleFunc("POST /api/oauth/kiro/device-code", s.kiroDeviceStart)
	s.mux.HandleFunc("POST /api/oauth/kiro/device-poll", s.kiroDevicePoll)
	s.mux.HandleFunc("GET /api/oauth/kiro/device-poll", s.kiroDevicePoll)
	s.mux.HandleFunc("POST /api/oauth/kiro/auto-import", s.kiroAutoImport)
}

func (s *Server) kiroSocialAuthorize(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body)
	idp, _ := body["idp"].(string)
	if idp == "" {
		idp = r.URL.Query().Get("idp")
	}
	if idp == "" {
		idp = "google"
	}
	p, err := oauth.StartKiroSocial(s.OAuth, idp)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{
		"ok": true, "sessionId": p.ID, "authUrl": p.AuthURL, "provider": "kiro", "idp": idp, "runtime": "go",
	})
}

func (s *Server) kiroSocialExchange(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body)
	sessionID, _ := body["sessionId"].(string)
	code, _ := body["code"].(string)
	if code == "" {
		code, _ = body["callbackUrl"].(string)
	}
	// allow code-only: create temp session if missing
	if sessionID == "" {
		p, err := oauth.StartKiroSocial(s.OAuth, "google")
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		sessionID = p.ID
		// without verifier exchange may fail — require session from authorize
		writeJSON(w, 400, map[string]any{
			"error": "sessionId required — call social-authorize first, then exchange with same sessionId",
			"hintSessionId": sessionID,
		})
		return
	}
	p, err := oauth.ExchangeKiroSocial(r.Context(), s.OAuth, sessionID, code)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	c, err := s.saveOAuthResult(p)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error(), "result": redactOAuthResult(p.Result)})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "connection": c, "runtime": "go"})
}

func (s *Server) kiroImport(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body)
	refresh, _ := body["refreshToken"].(string)
	if refresh == "" {
		refresh, _ = body["refresh_token"].(string)
	}
	clientID, _ := body["clientId"].(string)
	clientSecret, _ := body["clientSecret"].(string)
	region, _ := body["region"].(string)
	authMethod, _ := body["authMethod"].(string)
	name, _ := body["name"].(string)
	res, err := oauth.ImportKiroRefresh(r.Context(), refresh, clientID, clientSecret, region, authMethod)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	if name != "" {
		res["name"] = name
	}
	c, err := s.upsertFromOAuthMap(res)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "connection": c, "runtime": "go"})
}

func (s *Server) kiroImportCLIProxy(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	_ = json.NewDecoder(io.LimitReader(r.Body, 2<<20)).Decode(&body)
	// accept { json: "..." } or raw external_idp object
	if raw, ok := body["json"].(string); ok && raw != "" {
		var m map[string]any
		if json.Unmarshal([]byte(raw), &m) == nil {
			body = m
		}
	}
	authMethod, _ := body["auth_method"].(string)
	if authMethod == "" {
		authMethod, _ = body["authMethod"].(string)
	}
	access := firstStr(body, "access_token", "accessToken")
	refresh := firstStr(body, "refresh_token", "refreshToken")
	clientID := firstStr(body, "client_id", "clientId")
	clientSecret := firstStr(body, "client_secret", "clientSecret")
	region := firstStr(body, "region")
	tokenURL := firstStr(body, "token_endpoint", "tokenEndpoint", "tokenUrl")
	if refresh == "" && access == "" {
		writeJSON(w, 400, map[string]any{"error": "need access_token or refresh_token"})
		return
	}
	res := map[string]any{
		"accessToken":  access,
		"refreshToken": refresh,
		"provider":     "kiro",
		"authType":     "oauth",
		"authMethod":   pickStr(authMethod, "external_idp"),
		"clientId":     clientID,
		"clientSecret": clientSecret,
		"region":       pickStr(region, "us-east-1"),
		"tokenEndpoint": tokenURL,
		"email":        oauth.DecodeIDTokenEmail(access),
	}
	if refresh != "" && access == "" {
		imported, _ := oauth.ImportKiroRefresh(r.Context(), refresh, clientID, clientSecret, region, authMethod)
		for k, v := range imported {
			if res[k] == nil || res[k] == "" {
				res[k] = v
			}
		}
	}
	c, err := s.upsertFromOAuthMap(res)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "connection": c, "runtime": "go"})
}

func (s *Server) kiroAPIKey(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body)
	key := firstStr(body, "apiKey", "api_key", "accessToken", "token")
	if key == "" {
		writeJSON(w, 400, map[string]any{"error": "apiKey required"})
		return
	}
	name := firstStr(body, "name")
	if name == "" {
		name = "kiro-apikey"
	}
	res := map[string]any{
		"accessToken": key,
		"provider":    "kiro",
		"authType":    "apikey",
		"authMethod":  "api-key",
		"name":        name,
		"email":       oauth.DecodeIDTokenEmail(key),
	}
	c, err := s.upsertFromOAuthMap(res)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "connection": c, "runtime": "go"})
}

func (s *Server) kiroDeviceStart(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body)
	startURL := firstStr(body, "startUrl", "start_url")
	region := firstStr(body, "region")
	p, err := oauth.StartKiroDevice(r.Context(), s.OAuth, startURL, region)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{
		"ok": true, "sessionId": p.ID, "authUrl": p.AuthURL,
		"userCode": p.Result["userCode"], "device": p.Result, "runtime": "go",
		"_clientId": p.MachineID, "_clientSecret": p.Nonce, "_region": region, "_authMethod": "builder-id",
	})
}

func (s *Server) kiroDevicePoll(w http.ResponseWriter, r *http.Request) {
	sessionID := r.URL.Query().Get("sessionId")
	if sessionID == "" {
		var body map[string]any
		_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body)
		sessionID, _ = body["sessionId"].(string)
	}
	p, err := oauth.PollKiroDevice(r.Context(), s.OAuth, sessionID)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	out := map[string]any{"ok": true, "sessionId": p.ID, "status": p.Status, "runtime": "go"}
	if p.Status == "done" {
		c, err := s.saveOAuthResult(p)
		if err == nil {
			out["connection"] = c
		}
		out["result"] = redactOAuthResult(p.Result)
	}
	writeJSON(w, 200, out)
}

func (s *Server) kiroAutoImport(w http.ResponseWriter, r *http.Request) {
	// best-effort: look for common kiro credential paths — not available on Linux server usually
	writeJSON(w, 200, map[string]any{
		"ok": false, "found": false,
		"message": "auto-import from Kiro IDE not available on this host — use import/refreshToken or social flow",
		"runtime": "go",
	})
}

func (s *Server) upsertFromOAuthMap(res map[string]any) (db.Connection, error) {
	provider := firstStr(res, "provider")
	if provider == "" {
		provider = "kiro"
	}
	access := firstStr(res, "accessToken", "sk")
	refresh := firstStr(res, "refreshToken")
	email := firstStr(res, "email")
	name := firstStr(res, "name")
	if name == "" {
		name = email
	}
	if name == "" {
		name = provider + "-oauth"
	}
	baseURL := firstStr(res, "baseUrl", "apiBaseUrl")
	authType := firstStr(res, "authType")
	if authType == "" {
		authType = "oauth"
	}
	data := map[string]any{}
	for k, v := range res {
		data[k] = v
	}
	c := db.Connection{
		Provider: provider,
		AuthType: authType,
		Name:     name,
		Email:    email,
		Priority: 10,
		IsActive: 1,
		Data:     data,
		BaseURL:  baseURL,
		APIKey:   access,
	}
	if access == "" && refresh != "" {
		c.APIKey = refresh
	}
	return s.DB.UpsertConnection(c)
}

func firstStr(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k].(string); ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func pickStr(v, def string) string {
	if strings.TrimSpace(v) == "" {
		return def
	}
	return v
}

// silence unused if any
var _ = context.Background
var _ = time.Now
