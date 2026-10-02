package api

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// cliToolSpec describes a supported CLI coding agent and where it keeps config.
// Ported from the retired Next.js route `app/api/cli-tools/all-statuses`.
type cliToolSpec struct {
	ID      string // tool id (response key)
	Bin     string // executable probed on $PATH
	Config  string // config path relative to $HOME
	Kind    string // "json" | "raw"
	PathKey string // legacy response key for the config path
}

var cliToolSpecs = []cliToolSpec{
	{"claude", "claude", ".claude/settings.json", "json", "settingsPath"},
	{"codex", "codex", ".codex/config.toml", "raw", "configPath"},
	{"opencode", "opencode", ".config/opencode/opencode.json", "json", "configPath"},
	{"droid", "droid", ".factory/settings.json", "json", "settingsPath"},
	{"openclaw", "openclaw", ".openclaw/openclaw.json", "json", "settingsPath"},
	{"hermes", "hermes", ".hermes/config.yaml", "raw", "configPath"},
	{"cowork", "cowork", ".cowork/config.json", "json", "configPath"},
	{"cline", "cline", ".cline/data/globalState.json", "json", "globalStatePath"},
	{"kilo", "kilo", ".local/share/kilo/auth.json", "json", "authPath"},
	{"deepseek-tui", "deepseek", ".deepseek/config.toml", "raw", "configPath"},
	{"jcode", "jcode", ".jcode/config.toml", "raw", "configPath"},
	{"grok-build", "grok", ".grok/config.toml", "raw", "configPath"},
	{"devin", "devin", ".devin/config.json", "json", "configPath"},
}

var (
	localEndpointRe = regexp.MustCompile(`(?i)(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?`)
	trailingCommaRe = regexp.MustCompile(`,\s*([}\]])`)

	// Secret redaction — this endpoint is unauthenticated and tunnel-exposed,
	// so raw config contents must never leave the process with live credentials.
	secretKeyRe = regexp.MustCompile(`(?i)^(api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|token|secret|password|client[_-]?secret|api[_-]?secret|bearer)$`)
	tokenValRe  = regexp.MustCompile(`\b(sk-[A-Za-z0-9._-]{6,}|AIza[A-Za-z0-9._-]{10,}|ghp_[A-Za-z0-9]{10,}|xox[baprs]-[A-Za-z0-9-]{6,}|eyJ[A-Za-z0-9._-]{20,})`)
	kvLineRe    = regexp.MustCompile(`(?i)((?:api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|token|secret|password|client[_-]?secret)\s*[:=]\s*["']?)([^"'\s,\n{}]+)`)
)

// maskValue keeps a short prefix for identification and masks the rest.
// Env-var references (${VAR}) are not secrets and pass through untouched.
func maskValue(s string) string {
	if s == "" || strings.HasPrefix(s, "$") {
		return s
	}
	if len(s) <= 4 {
		return "***"
	}
	return s[:3] + "***"
}

// redactText masks secret-looking tokens and key/value pairs inside a raw blob.
func redactText(s string) string {
	s = tokenValRe.ReplaceAllStringFunc(s, maskValue)
	s = kvLineRe.ReplaceAllStringFunc(s, func(m string) string {
		loc := kvLineRe.FindStringSubmatchIndex(m)
		if loc[4] < 0 {
			return m
		}
		prefix, val := m[loc[2]:loc[3]], m[loc[4]:loc[5]]
		if strings.HasPrefix(val, "$") {
			return m
		}
		return prefix + maskValue(val)
	})
	return s
}

// redactAny walks parsed JSON and masks values under secret-looking keys.
func redactAny(v any) any {
	switch t := v.(type) {
	case string:
		return redactText(t)
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			if secretKeyRe.MatchString(k) {
				if s, ok := val.(string); ok && s != "" && !strings.HasPrefix(s, "$") {
					out[k] = maskValue(s)
					continue
				}
			}
			out[k] = redactAny(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = redactAny(val)
		}
		return out
	default:
		return v
	}
}

// registerCLIToolRoutes wires the CLI-tools surface.
func (s *Server) registerCLIToolRoutes() {
	s.mux.HandleFunc("GET /api/cli-tools/all-statuses", s.cliStatuses)
	s.mux.HandleFunc("POST /api/cli-tools/{id}/test", s.cliToolTest)
}

// cliStatuses returns a per-tool status map. Legacy contract is a FLAT object
// keyed by tool id; we additionally mirror it under "tools" for the current
// dashboard shape so both consumers keep working.
func (s *Server) cliStatuses(w http.ResponseWriter, r *http.Request) {
	home, err := os.UserHomeDir()
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": "cannot resolve home dir"})
		return
	}
	out := make(map[string]any, len(cliToolSpecs))
	for _, spec := range cliToolSpecs {
		out[spec.ID] = detectCLITool(home, spec)
	}
	resp := map[string]any{"runtime": "go", "tools": out}
	for k, v := range out {
		resp[k] = v
	}
	writeJSON(w, 200, resp)
}

// detectCLITool probes a single tool: PATH lookup + config file inspection.
func detectCLITool(home string, spec cliToolSpec) map[string]any {
	res := map[string]any{
		"id":           spec.ID,
		"installed":    false,
		"hasFudrouter": false,
		"hasNProuter":  false, // legacy alias
	}

	if binPath, err := exec.LookPath(spec.Bin); err == nil && binPath != "" {
		res["installed"] = true
		res["binPath"] = binPath
	}

	cfgPath := filepath.Join(home, spec.Config)
	res[spec.PathKey] = cfgPath
	res["configPath"] = cfgPath

	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		if !res["installed"].(bool) {
			res["message"] = spec.ID + " CLI is not installed"
		}
		return res
	}
	res["installed"] = true

	text := string(raw)
	lower := strings.ToLower(text)
	hasFud := localEndpointRe.MatchString(text) ||
		strings.Contains(lower, "fudrouter") ||
		strings.Contains(lower, "nprouter")
	res["hasFudrouter"] = hasFud
	res["hasNProuter"] = hasFud

	if spec.Kind == "json" {
		clean := trailingCommaRe.ReplaceAllString(text, "$1")
		var obj any
		if json.Unmarshal([]byte(clean), &obj) == nil {
			red := redactAny(obj)
			res["settings"] = red
			res["config"] = red
			return res
		}
	}
	res["config"] = redactText(text)
	return res
}

// cliToolTest probes the local gateway a CLI tool would route through.
func (s *Server) cliToolTest(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	known := false
	for _, spec := range cliToolSpecs {
		if spec.ID == id {
			known = true
			break
		}
	}
	if !known {
		writeJSON(w, 404, map[string]any{"error": "unknown cli tool: " + id})
		return
	}
	base := "http://127.0.0.1:8011"
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(base + "/api/health")
	if err != nil {
		writeJSON(w, 200, map[string]any{"tool": id, "gateway": base, "status": "error", "message": err.Error()})
		return
	}
	defer resp.Body.Close()
	writeJSON(w, 200, map[string]any{"tool": id, "gateway": base, "status": "ok", "http": resp.StatusCode})
}
