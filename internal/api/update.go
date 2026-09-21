package api

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

func (s *Server) registerUpdateRoutes() {
	s.mux.HandleFunc("GET /api/version/update", s.updateStatus)
	s.mux.HandleFunc("POST /api/version/update", s.updateStart)
	s.mux.HandleFunc("GET /api/version/update/status", s.updateStatus)
}

func (s *Server) updateStatus(w http.ResponseWriter, r *http.Request) {
	dataDir := s.DataDir
	updateDir := filepath.Join(dataDir, "update")
	statusFile := filepath.Join(updateDir, "status.json")

	b, err := os.ReadFile(statusFile)
	if err != nil {
		writeJSON(w, 200, map[string]any{
			"ok":        true,
			"available": true,
			"status":    nil,
			"message":   "no previous update run",
		})
		return
	}

	var status map[string]any
	_ = json.Unmarshal(b, &status)

	writeJSON(w, 200, map[string]any{
		"ok":        true,
		"available": true,
		"status":    status,
	})
}

func (s *Server) updateStart(w http.ResponseWriter, r *http.Request) {
	dataDir := s.DataDir
	appDir := os.Getenv("APP_DIR")
	if appDir == "" {
		appDir = "/home/dwizzy/fudrouter-app"
	}

	// Spawn detached updater process
	updaterBin := filepath.Join(appDir, "cmd", "updater", "main.go")
	cmd := exec.Command("go", "run", updaterBin)
	cmd.Dir = appDir
	cmd.Env = append(os.Environ(),
		"DATA_DIR="+dataDir,
		"APP_DIR="+appDir,
	)
	// Detach
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		writeJSON(w, 500, map[string]any{"error": "failed to spawn updater: " + err.Error()})
		return
	}
	// unref — let it survive parent
	_ = cmd.Process.Release()

	writeJSON(w, 200, map[string]any{
		"ok":      true,
		"message": "updater spawned — monitor at /api/version/update/status",
		"pid":     cmd.Process.Pid,
	})
}
