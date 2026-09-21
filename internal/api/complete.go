package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudrouter/internal/apikey"
	"github.com/anvxxr-arch/fudrouter/internal/catalog"
	"github.com/anvxxr-arch/fudrouter/internal/db"
	"golang.org/x/crypto/bcrypt"
)

// extended routes registered from New via registerCompleteRoutes
func (s *Server) registerCompleteRoutes() {
	if s.Cat == nil {
		s.Cat = catalog.Open(s.DataDir)
	}
	_ = s.DB.EnsureReady()

	// Auth
	s.mux.HandleFunc("POST /api/auth/login", s.login)
	s.mux.HandleFunc("POST /api/auth/logout", s.logout)
	s.mux.HandleFunc("POST /api/init", s.initSetup)

	// Keys CRUD
	s.mux.HandleFunc("POST /api/keys", s.createKey)
	s.mux.HandleFunc("DELETE /api/keys/{id}", s.deleteKey)

	// Connections CRUD
	s.mux.HandleFunc("POST /api/connections", s.createConnection)
	s.mux.HandleFunc("PUT /api/connections/{id}", s.updateConnection)
	s.mux.HandleFunc("DELETE /api/connections/{id}", s.deleteConnection)
	s.mux.HandleFunc("POST /api/connections/{id}/test", s.testConnection)

	// Providers / models from catalog
	s.mux.HandleFunc("GET /api/providers", s.providers)
	s.mux.HandleFunc("GET /api/providers/client", s.providersClient)
	s.mux.HandleFunc("GET /api/providers/{id}", s.providerByID)
	s.mux.HandleFunc("GET /api/providers/{id}/models", s.providerModels)
	s.mux.HandleFunc("POST /api/providers/{id}/test", s.providerTestStub)
	s.mux.HandleFunc("GET /api/models/availability", s.modelsAvailability)
	s.mux.HandleFunc("GET /api/models/custom", s.modelsCustomGet)
	s.mux.HandleFunc("POST /api/models/custom", s.modelsCustomPost)
	s.mux.HandleFunc("GET /api/models/disabled", s.modelsDisabledGet)
	s.mux.HandleFunc("POST /api/models/disabled", s.modelsDisabledPost)
	s.mux.HandleFunc("GET /api/models/alias", s.modelsAliasGet)
	s.mux.HandleFunc("POST /api/models/alias", s.modelsAliasPost)
	s.mux.HandleFunc("POST /api/models/catalog-sync", s.catalogSync)

	// OpenAI-compat
	s.mux.HandleFunc("GET /v1/models", s.v1Models)
	s.mux.HandleFunc("GET /api/v1/models", s.v1Models)

	// Combos / nodes / pools
	s.mux.HandleFunc("GET /api/combos", s.listCombos)
	s.mux.HandleFunc("POST /api/combos", s.createCombo)
	s.mux.HandleFunc("GET /api/combos/{id}", s.getCombo)
	s.mux.HandleFunc("PUT /api/combos/{id}", s.updateCombo)
	s.mux.HandleFunc("DELETE /api/combos/{id}", s.deleteCombo)

	s.mux.HandleFunc("GET /api/provider-nodes", s.listNodes)
	s.mux.HandleFunc("POST /api/provider-nodes", s.createNode)
	s.mux.HandleFunc("DELETE /api/provider-nodes/{id}", s.deleteNode)

	s.mux.HandleFunc("GET /api/proxy-pools", s.listPools)
	s.mux.HandleFunc("POST /api/proxy-pools", s.createPool)
	s.mux.HandleFunc("DELETE /api/proxy-pools/{id}", s.deletePool)

	// Tunnel / headroom / pxpipe stubs (ops surface)
	s.mux.HandleFunc("GET /api/tunnel/status", s.tunnelStatus)
	s.mux.HandleFunc("GET /api/mitm/status", s.mitmStatus)
	s.mux.HandleFunc("GET /api/headroom/status", s.headroomStatus)
	s.mux.HandleFunc("GET /api/pxpipe/status", s.pxpipeStatus)
	s.mux.HandleFunc("GET /api/pricing", s.pricing)
	s.mux.HandleFunc("GET /api/locale", s.localeGet)
	s.mux.HandleFunc("POST /api/locale", s.localePost)
	s.mux.HandleFunc("GET /api/tags", s.tags)
	s.mux.HandleFunc("GET /api/cli-tools/all-statuses", s.cliStatuses)
}

func randID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (s *Server) sessionID(r *http.Request) string {
	if c, err := r.Cookie("fudrouter_session"); err == nil && c.Value != "" {
		return c.Value
	}
	return ""
}

func (s *Server) setSession(w http.ResponseWriter, id string) {
	http.SetCookie(w, &http.Cookie{
		Name:     "fudrouter_session",
		Value:    id,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   86400 * 7,
	})
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
		Username string `json:"username"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	st, err := s.DB.Settings()
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	hash, _ := st["password"].(string)
	if hash == "" {
		writeJSON(w, 400, map[string]any{"error": "no password configured — call /api/init"})
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(body.Password)) != nil {
		writeJSON(w, 401, map[string]any{"error": "invalid password"})
		return
	}
	sid := randID()
	_ = s.DB.CreateSession(sid, map[string]any{"authenticated": true, "user": firstNonEmpty(body.Username, "admin")}, 7*24*time.Hour)
	s.setSession(w, sid)
	writeJSON(w, 200, map[string]any{"ok": true, "authenticated": true})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if id := s.sessionID(r); id != "" {
		_ = s.DB.DeleteSession(id)
	}
	http.SetCookie(w, &http.Cookie{Name: "fudrouter_session", Value: "", Path: "/", MaxAge: -1})
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) initSetup(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.Password == "" {
		writeJSON(w, 400, map[string]any{"error": "password required"})
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(body.Password), 10)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	_, err = s.DB.PatchSettings(map[string]any{"password": string(hash)})
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) createKey(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	mid := apikey.MachineID(s.DataDir)
	key, _ := apikey.Generate(mid)
	k, err := s.DB.InsertAPIKey(db.APIKey{Key: key, Name: firstNonEmpty(body.Name, "key"), MachineID: mid, IsActive: 1})
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"id": k.ID, "key": key, "name": k.Name})
}

func (s *Server) deleteKey(w http.ResponseWriter, r *http.Request) {
	if err := s.DB.DeleteAPIKey(r.PathValue("id")); err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) createConnection(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, 400, map[string]any{"error": "invalid json"})
		return
	}
	c := db.Connection{
		Provider: str(body["provider"]),
		AuthType: firstNonEmpty(str(body["authType"]), "apikey"),
		Name:     str(body["name"]),
		Email:    str(body["email"]),
		Priority: intNum(body["priority"], 0),
		IsActive: 1,
		BaseURL:  firstNonEmpty(str(body["base_url"]), str(body["baseUrl"])),
		APIKey:   firstNonEmpty(str(body["api_key"]), str(body["apiKey"])),
		Data:     map[string]any{},
	}
	if c.Provider == "" || c.Name == "" {
		writeJSON(w, 400, map[string]any{"error": "provider and name required"})
		return
	}
	if data, ok := body["data"].(map[string]any); ok {
		c.Data = data
	}
	// stash credentials into data too
	if c.APIKey != "" {
		c.Data["apiKey"] = c.APIKey
	}
	if c.BaseURL != "" {
		c.Data["baseUrl"] = c.BaseURL
	}
	if v, ok := body["isActive"].(bool); ok && !v {
		c.IsActive = 0
	}
	saved, err := s.DB.UpsertConnection(c)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"id": saved.ID, "connection": db.ConnPublic(saved)})
}

func (s *Server) updateConnection(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	cur, ok, err := s.DB.GetConnection(id)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	if !ok {
		writeJSON(w, 404, map[string]any{"error": "not found"})
		return
	}
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	if v := str(body["name"]); v != "" {
		cur.Name = v
	}
	if v := str(body["provider"]); v != "" {
		cur.Provider = v
	}
	if v := str(body["authType"]); v != "" {
		cur.AuthType = v
	}
	if _, ok := body["priority"]; ok {
		cur.Priority = intNum(body["priority"], cur.Priority)
	}
	if v, ok := body["isActive"].(bool); ok {
		if v {
			cur.IsActive = 1
		} else {
			cur.IsActive = 0
		}
	}
	if v := firstNonEmpty(str(body["base_url"]), str(body["baseUrl"])); v != "" {
		cur.BaseURL = v
		cur.Data["baseUrl"] = v
	}
	if v := firstNonEmpty(str(body["api_key"]), str(body["apiKey"])); v != "" && v != "***" {
		cur.APIKey = v
		cur.Data["apiKey"] = v
	}
	if data, ok := body["data"].(map[string]any); ok {
		for k, v := range data {
			cur.Data[k] = v
		}
	}
	saved, err := s.DB.UpsertConnection(cur)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"connection": db.ConnPublic(saved)})
}

func (s *Server) deleteConnection(w http.ResponseWriter, r *http.Request) {
	if err := s.DB.DeleteConnection(r.PathValue("id")); err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) testConnection(w http.ResponseWriter, r *http.Request) {
	c, ok, err := s.DB.GetConnection(r.PathValue("id"))
	if err != nil || !ok {
		writeJSON(w, 404, map[string]any{"error": "not found"})
		return
	}
	base := c.BaseURL
	if base == "" {
		if v, ok := c.Data["baseUrl"].(string); ok {
			base = v
		}
	}
	if base == "" {
		writeJSON(w, 200, map[string]any{"status": "error", "message": "missing baseUrl"})
		return
	}
	key := c.APIKey
	if key == "" {
		if v, ok := c.Data["apiKey"].(string); ok {
			key = v
		}
	}
	req, _ := http.NewRequest(http.MethodGet, strings.TrimRight(base, "/")+"/models", nil)
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		writeJSON(w, 200, map[string]any{"status": "error", "message": err.Error()})
		return
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		writeJSON(w, 200, map[string]any{"status": "connected", "message": "ok", "http": resp.StatusCode})
		return
	}
	writeJSON(w, 200, map[string]any{"status": "error", "message": string(b), "http": resp.StatusCode})
}


var providerMeta = map[string]map[string]any{
    "openai": {"name": "OpenAI", "description": "GPT-4, GPT-4o, o1, o3", "authModes": []string{"apikey"}},
    "anthropic": {"name": "Anthropic", "description": "Claude 3.5, 4, 4.5", "authModes": []string{"apikey"}},
    "gemini": {"name": "Google Gemini", "description": "Gemini 2.5, 3, Flash", "authModes": []string{"apikey"}},
    "xai": {"name": "xAI / Grok", "description": "Grok 4, 4.5", "authModes": []string{"apikey", "oauth"}},
    "codex": {"name": "OpenAI Codex", "description": "chatgpt.com/backend-api", "authModes": []string{"oauth"}},
    "cursor": {"name": "Cursor IDE", "description": "Cursor AI editor", "authModes": []string{"oauth"}},
    "github": {"name": "GitHub Copilot", "description": "Copilot in IDE", "authModes": []string{"oauth"}},
    "kiro": {"name": "AWS Kiro", "description": "Kiro IDE", "authModes": []string{"oauth"}},
    "cerebras": {"name": "Cerebras", "description": "Fast inference", "authModes": []string{"apikey"}},
    "cloudflare-ai": {"name": "Cloudflare AI", "description": "Workers AI", "authModes": []string{"apikey"}},
    "cohere": {"name": "Cohere", "description": "Command R/A", "authModes": []string{"apikey"}},
    "deepseek": {"name": "DeepSeek", "description": "V3, R1, V4", "authModes": []string{"apikey"}},
    "groq": {"name": "Groq", "description": "Fast inference", "authModes": []string{"apikey"}},
    "kimi": {"name": "Kimi (Moonshot)", "description": "K2, K3", "authModes": []string{"apikey"}},
    "mistral": {"name": "Mistral AI", "description": "Large, Small", "authModes": []string{"apikey"}},
    "perplexity": {"name": "Perplexity", "description": "Sonar Pro", "authModes": []string{"apikey"}},
    "qwen": {"name": "Qwen (Alibaba)", "description": "Qwen 3.5, 3.8", "authModes": []string{"apikey"}},
    "qoder": {"name": "Qoder", "description": "Qoder IDE", "authModes": []string{"oauth"}},
    "xiaomi-mimo": {"name": "Xiaomi MiMo", "description": "MiMo reasoning", "authModes": []string{"oauth"}},
    "glm": {"name": "GLM (Zhipu)", "description": "GLM-5", "authModes": []string{"apikey"}},
    "glm-cn": {"name": "GLM CN", "description": "GLM-5 China", "authModes": []string{"apikey"}},
    "opencode-go": {"name": "OpenCode Go", "description": "Open source coding", "authModes": []string{"apikey"}},
    "opencode-zen": {"name": "OpenCode Zen", "description": "Curated gateway: GPT 5.4/5.3/5.2/5, Claude 4.8/4.7/4.6/4.5/4.1, Gemini 3.5/3.1/3, Grok 4.6/4.5, Qwen, DeepSeek V4", "authModes": []string{"apikey"}},
    "siliconflow": {"name": "SiliconFlow", "description": "SiliconFlow API", "authModes": []string{"apikey"}},
    "venice": {"name": "Venice AI", "description": "Uncensored models", "authModes": []string{"apikey"}},
    "morph": {"name": "Morph", "description": "Fast apply", "authModes": []string{"apikey"}},
    "nvidia": {"name": "NVIDIA NIM", "description": "Inference services", "authModes": []string{"apikey"}},
    "nebius": {"name": "Nebius", "description": "AI Cloud", "authModes": []string{"apikey"}},
    "togetherai": {"name": "Together AI", "description": "Open source models", "authModes": []string{"apikey"}},
    "watsonx": {"name": "watsonx", "description": "IBM watsonx", "authModes": []string{"apikey"}},
    "digitalocean": {"name": "DigitalOcean", "description": "GenAI", "authModes": []string{"apikey"}},
    "edenai": {"name": "Eden AI", "description": "Multi-provider", "authModes": []string{"apikey"}},
    "anyapi": {"name": "AnyAPI", "description": "Proxy", "authModes": []string{"apikey"}},
    "claude": {"name": "Claude Code", "description": "CLI agent", "authModes": []string{"oauth"}},
    "cline": {"name": "Cline", "description": "Coding assistant", "authModes": []string{"oauth"}},
    "roocode": {"name": "RooCode", "description": "Multi-agent coding", "authModes": []string{"apikey", "oauth"}},
    "windsurf": {"name": "Windsurf", "description": "IDE", "authModes": []string{"oauth"}},
    "nan": {"name": "NaN", "description": "Proxy", "authModes": []string{"apikey"}},
    "custom": {"name": "Custom", "description": "OpenAI/Anthropic compat", "authModes": []string{"apikey"}},
}

func (s *Server) providers(w http.ResponseWriter, r *http.Request) {
	raw := s.Cat.ProvidersClient()
	for _, m := range raw {
		id, _ := m["id"].(string)
		if meta, ok := providerMeta[id]; ok {
			for k, v := range meta {
				m[k] = v
			}
		} else {
			m["authModes"] = []string{"apikey"}
			if _, ok := m["description"]; !ok {
				m["description"] = id
			}
		}
	}
	writeJSON(w, 200, map[string]any{"providers": raw, "runtime": "go"})
}

func (s *Server) providersClient(w http.ResponseWriter, r *http.Request) {
	s.providers(w, r)
}
func (s *Server) providerByID(w http.ResponseWriter, r *http.Request) {
	p, ok := s.Cat.Provider(r.PathValue("id"))
	if !ok {
		writeJSON(w, 404, map[string]any{"error": "not found"})
		return
	}
	writeJSON(w, 200, p)
}
func (s *Server) providerModels(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"models": s.Cat.Models(r.PathValue("id"))})
}
func (s *Server) providerTestStub(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"ok": true, "message": "use connection test endpoints"})
}

func (s *Server) modelsAvailability(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"models": s.Cat.OpenAIModels()})
}
func (s *Server) modelsCustomGet(w http.ResponseWriter, r *http.Request) {
	m, _ := s.DB.KVList("customModels")
	out := []any{}
	for _, v := range m {
		var item any
		_ = json.Unmarshal([]byte(v), &item)
		out = append(out, item)
	}
	writeJSON(w, 200, map[string]any{"customModels": out})
}
func (s *Server) modelsCustomPost(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	id := firstNonEmpty(str(body["id"]), randID())
	raw, _ := json.Marshal(body)
	_ = s.DB.KVSet("customModels", id, string(raw))
	writeJSON(w, 200, map[string]any{"ok": true, "id": id})
}
func (s *Server) modelsDisabledGet(w http.ResponseWriter, r *http.Request) {
	m, _ := s.DB.KVList("disabledModels")
	writeJSON(w, 200, map[string]any{"disabled": m})
}
func (s *Server) modelsDisabledPost(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	raw, _ := json.Marshal(body)
	_ = s.DB.KVSet("disabledModels", "all", string(raw))
	writeJSON(w, 200, map[string]any{"ok": true})
}
func (s *Server) modelsAliasGet(w http.ResponseWriter, r *http.Request) {
	m, _ := s.DB.KVList("modelAliases")
	out := map[string]any{}
	for k, v := range m {
		var item any
		_ = json.Unmarshal([]byte(v), &item)
		out[k] = item
	}
	writeJSON(w, 200, map[string]any{"aliases": out})
}
func (s *Server) modelsAliasPost(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	for k, v := range body {
		raw, _ := json.Marshal(v)
		_ = s.DB.KVSet("modelAliases", k, string(raw))
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}
func (s *Server) catalogSync(w http.ResponseWriter, r *http.Request) {
	err := s.Cat.Reload()
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "providers": len(s.Cat.ProvidersClient()), "models": len(s.Cat.OpenAIModels())})
}

func (s *Server) v1Models(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"object": "list", "data": s.Cat.OpenAIModels()})
}

func (s *Server) listCombos(w http.ResponseWriter, r *http.Request) {
	list, err := s.DB.ListCombos()
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	if list == nil {
		list = []db.Combo{}
	}
	writeJSON(w, 200, map[string]any{"combos": list})
}
func (s *Server) createCombo(w http.ResponseWriter, r *http.Request) {
	var c db.Combo
	_ = json.NewDecoder(r.Body).Decode(&c)
	saved, err := s.DB.UpsertCombo(c)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, saved)
}
func (s *Server) getCombo(w http.ResponseWriter, r *http.Request) {
	list, _ := s.DB.ListCombos()
	for _, c := range list {
		if c.ID == r.PathValue("id") {
			writeJSON(w, 200, c)
			return
		}
	}
	writeJSON(w, 404, map[string]any{"error": "not found"})
}
func (s *Server) updateCombo(w http.ResponseWriter, r *http.Request) {
	var c db.Combo
	_ = json.NewDecoder(r.Body).Decode(&c)
	c.ID = r.PathValue("id")
	saved, err := s.DB.UpsertCombo(c)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, saved)
}
func (s *Server) deleteCombo(w http.ResponseWriter, r *http.Request) {
	_ = s.DB.DeleteCombo(r.PathValue("id"))
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) listNodes(w http.ResponseWriter, r *http.Request) {
	list, err := s.DB.ListNodes()
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	if list == nil {
		list = []db.Node{}
	}
	writeJSON(w, 200, map[string]any{"nodes": list})
}
func (s *Server) createNode(w http.ResponseWriter, r *http.Request) {
	var n db.Node
	_ = json.NewDecoder(r.Body).Decode(&n)
	saved, err := s.DB.UpsertNode(n)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, saved)
}
func (s *Server) deleteNode(w http.ResponseWriter, r *http.Request) {
	_ = s.DB.DeleteNode(r.PathValue("id"))
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) listPools(w http.ResponseWriter, r *http.Request) {
	list, err := s.DB.ListProxyPools()
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	if list == nil {
		list = []db.ProxyPool{}
	}
	writeJSON(w, 200, map[string]any{"pools": list})
}
func (s *Server) createPool(w http.ResponseWriter, r *http.Request) {
	var p db.ProxyPool
	_ = json.NewDecoder(r.Body).Decode(&p)
	if p.IsActive == 0 {
		p.IsActive = 1
	}
	saved, err := s.DB.UpsertProxyPool(p)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, saved)
}
func (s *Server) deletePool(w http.ResponseWriter, r *http.Request) {
	_ = s.DB.DeleteProxyPool(r.PathValue("id"))
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) tunnelStatus(w http.ResponseWriter, r *http.Request) {
	active := false
	if out, err := exec.Command("systemctl", "is-active", "cloudflared").Output(); err == nil {
		active = strings.TrimSpace(string(out)) == "active"
	}
	writeJSON(w, 200, map[string]any{
		"enabled":  active,
		"hostname": "ai.karepmuwes.my.id",
		"target":   "http://localhost:8012",
		"runtime":  "go",
	})
}

func (s *Server) mitmStatus(w http.ResponseWriter, r *http.Request) {
	ca := filepath.Join(s.DataDir, "mitm", "rootCA.crt")
	_, caErr := os.Stat(ca)
	port443 := false
	port8443 := false
	if c, err := net.DialTimeout("tcp", "127.0.0.1:443", 300*time.Millisecond); err == nil {
		port443 = true
		_ = c.Close()
	}
	if c, err := net.DialTimeout("tcp", "127.0.0.1:8443", 300*time.Millisecond); err == nil {
		port8443 = true
		_ = c.Close()
	}
	writeJSON(w, 200, map[string]any{
		"runtime":   "go",
		"caPath":    ca,
		"caExists":  caErr == nil,
		"listening": map[string]bool{"443": port443, "8443": port8443},
		"router":    "http://127.0.0.1:8011",
		"targets": []string{
			"daily-cloudcode-pa.googleapis.com",
			"cloudcode-pa.googleapis.com",
			"api.individual.githubcopilot.com",
			"runtime.us-east-1.kiro.dev",
			"api2.cursor.sh",
		},
	})
}
func (s *Server) headroomStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"running": false, "message": "headroom not required in go gateway", "runtime": "go"})
}
func (s *Server) pxpipeStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"running": false, "message": "pxpipe retired in go production", "runtime": "go"})
}
func (s *Server) pricing(w http.ResponseWriter, r *http.Request) {
	m, _ := s.DB.KVList("pricing")
	out := map[string]any{}
	for k, v := range m {
		var item any
		_ = json.Unmarshal([]byte(v), &item)
		out[k] = item
	}
	writeJSON(w, 200, map[string]any{"pricing": out})
}
func (s *Server) localeGet(w http.ResponseWriter, r *http.Request) {
	v, _, _ := s.DB.KVGet("settings", "locale")
	if v == "" {
		v = "en"
	}
	writeJSON(w, 200, map[string]any{"locale": v})
}
func (s *Server) localePost(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	_ = s.DB.KVSet("settings", "locale", firstNonEmpty(str(body["locale"]), "en"))
	writeJSON(w, 200, map[string]any{"ok": true})
}
func (s *Server) tags(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"tags": []string{}})
}
func (s *Server) cliStatuses(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"tools": map[string]any{}, "runtime": "go"})
}

func str(v any) string {
	s, _ := v.(string)
	return s
}
func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
func intNum(v any, def int) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case int:
		return t
	case json.Number:
		i, _ := t.Int64()
		return int(i)
	default:
		return def
	}
}

// silence unused os in case
var _ = os.Getenv

func (s *Server) registerMediaProviderRoutes() {
	s.mux.HandleFunc("GET /api/media-providers/by-kind", s.mediaProvidersByKind)
}

func (s *Server) mediaProvidersByKind(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{
		"ok":     true,
		"byKind": map[string]any{},
	})
}
