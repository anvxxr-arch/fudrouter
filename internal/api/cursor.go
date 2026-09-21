package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/anvxxr-arch/fudrouter/internal/oauth"
)

func (s *Server) registerCursorRoutes() {
	s.mux.HandleFunc("POST /api/oauth/cursor/import", s.cursorImport)
	s.mux.HandleFunc("GET /api/oauth/cursor/auto-import", s.cursorAutoImport)
	s.mux.HandleFunc("POST /api/oauth/cursor/auto-import", s.cursorAutoImport)
	s.mux.HandleFunc("POST /api/oauth/cursor/save", s.cursorImport)
}

func (s *Server) cursorImport(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(io.LimitReader(r.Body, 2<<20))
	var body map[string]any
	_ = json.Unmarshal(raw, &body)

	access := firstStr(body, "accessToken", "access_token", "token")
	machine := firstStr(body, "machineId", "machine_id", "serviceMachineId")
	if access == "" || machine == "" {
		// try nested / full dump
		a2, m2, err := oauth.ParseCursorAuthJSON(raw)
		if err == nil {
			if access == "" {
				access = a2
			}
			if machine == "" {
				machine = m2
			}
		}
	}
	name := firstStr(body, "name")
	res, err := oauth.ImportCursorToken(access, machine)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	if name != "" {
		res["name"] = name
	} else if email, _ := res["email"].(string); email != "" {
		res["name"] = email
	} else {
		res["name"] = "cursor-imported"
	}
	c, err := s.upsertFromOAuthMap(res)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "connection": c, "runtime": "go"})
}

func (s *Server) cursorAutoImport(w http.ResponseWriter, r *http.Request) {
	res, found, msg := oauth.AutoImportCursor()
	if !found {
		writeJSON(w, 200, map[string]any{
			"ok": false, "found": false, "message": msg, "detail": res, "runtime": "go",
		})
		return
	}
	c, err := s.upsertFromOAuthMap(res)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error(), "found": true})
		return
	}
	writeJSON(w, 200, map[string]any{
		"ok": true, "found": true, "connection": c,
		"accessToken": maskTok(firstStr(res, "accessToken")),
		"machineId":   firstStr(res, "machineId"),
		"runtime":     "go",
	})
}

func maskTok(s string) string {
	s = strings.TrimSpace(s)
	if len(s) < 12 {
		return "[redacted]"
	}
	return s[:6] + "…" + s[len(s)-4:]
}
