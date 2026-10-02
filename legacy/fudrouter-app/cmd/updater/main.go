// Detached updater: builds latest binary from source, replaces running binary, restarts via PM2.
// Usage: go run cmd/updater/main.go
// Spawned detached from parent. Survives parent exit.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	updaterPort    = 20129
	appPort        = 8011
	maxRetries     = 3
	retryDelay     = 5 * time.Second
	waitMin        = 3 * time.Second
	waitMax        = 15 * time.Second
	appWaitTimeout = 30 * time.Second
)

type Status struct {
	Phase      string   `json:"phase"`
	Attempt    int      `json:"attempt"`
	MaxRetries int      `json:"maxRetries"`
	Log        []string `json:"log"`
	Done       bool     `json:"done"`
	Success    bool     `json:"success"`
	Error      string   `json:"error,omitempty"`
}

var (
	status   Status
	logLines []string
	mu       sync.Mutex
)

func pushLog(s string) {
	mu.Lock()
	defer mu.Unlock()
	t := time.Now().UTC().Format("15:04:05")
	logLines = append(logLines, fmt.Sprintf("[%s] %s", t, s))
	if len(logLines) > 30 {
		logLines = logLines[len(logLines)-30:]
	}
	status.Log = append([]string{}, logLines...)
	log.Print(s)
}

func saveStatus(dataDir string) {
	dir := filepath.Join(dataDir, "update")
	_ = os.MkdirAll(dir, 0o700)
	b, _ := json.Marshal(status)
	_ = os.WriteFile(filepath.Join(dir, "status.json"), b, 0o600)
	_ = os.WriteFile(filepath.Join(dir, "install.log"), []byte(strings.Join(logLines, "\n")), 0o600)
}

func portFree(port int) bool {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return false
	}
	_ = ln.Close()
	return true
}

func waitAppDown(ctx context.Context, port int) {
	deadline := time.Now().Add(waitMax)
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if portFree(port) {
				return
			}
			if time.Now().After(deadline) {
				pushLog("timeout waiting for app port, proceeding")
				return
			}
		}
	}
}

func runBuild(ctx context.Context, appDir string) (string, error) {
	pushLog("building latest binary from source...")
	cmd := exec.CommandContext(ctx, "go", "build", "-trimpath", "-ldflags", "-s -w", "-o", "bin/fudrouter", "./cmd/fudrouter")
	cmd.Dir = appDir
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("build failed: %w", err)
	}
	return string(out), nil
}

func replaceBinary(appDir, dataDir string) error {
	old := filepath.Join(appDir, "bin", "fudrouter")
	newBin := filepath.Join(appDir, "bin", "fudrouter.new")
	if _, err := os.Stat(newBin); err != nil {
		return fmt.Errorf("new binary missing: %s", newBin)
	}
	// backup old
	backup := filepath.Join(dataDir, "update", "fudrouter.prev")
	_ = os.Remove(backup)
	_ = os.Rename(old, backup)
	// move new into place
	if err := os.Rename(newBin, old); err != nil {
		// restore backup
		_ = os.Rename(backup, old)
		return fmt.Errorf("replace binary failed: %w", err)
	}
	_ = os.Chmod(old, 0o755)
	return nil
}

func restartApp() error {
	pushLog("restarting via PM2...")
	cmd := exec.Command("pm2", "restart", "fudrouter")
	out, err := cmd.CombinedOutput()
	pushLog(strings.TrimSpace(string(out)))
	return err
}

func startStatusServer(dataDir string) *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		b, _ := json.Marshal(status)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(b)
	})
	mux.HandleFunc("/update/status", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		b, _ := json.Marshal(status)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(b)
	})
	srv := &http.Server{Addr: fmt.Sprintf(":%d", updaterPort), Handler: mux}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("status server: %v", err)
		}
	}()
	return srv
}

func main() {
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		home, _ := os.UserHomeDir()
		dataDir = filepath.Join(home, ".fudrouter")
	}
	appDir := os.Getenv("APP_DIR")
	if appDir == "" {
		appDir = "/home/dwizzy/fudrouter-app"
	}

	log.SetFlags(log.LstdFlags | log.Lshortfile)
	status = Status{Phase: "starting", MaxRetries: maxRetries}
	saveStatus(dataDir)

	srv := startStatusServer(dataDir)
	pushLog(fmt.Sprintf("updater status on :%d", updaterPort))

	// minimum wait before acting (let parent exit cleanly)
	time.Sleep(waitMin)

	ctx := context.Background()

	// wait for app to come down
	status.Phase = "waiting"
	saveStatus(dataDir)
	waitAppDown(ctx, appPort)

	// retry loop
	for attempt := 1; attempt <= maxRetries; attempt++ {
		status.Attempt = attempt
		status.Phase = "installing"
		saveStatus(dataDir)
		pushLog(fmt.Sprintf("attempt %d/%d — building binary", attempt, maxRetries))

		out, err := runBuild(ctx, appDir)
		if err != nil {
			pushLog("build error: " + err.Error())
			pushLog("output: " + out)
			if attempt < maxRetries {
				pushLog(fmt.Sprintf("retrying in %v...", retryDelay))
				time.Sleep(retryDelay)
				continue
			}
			status.Phase = "done"
			status.Done = true
			status.Success = false
			status.Error = err.Error()
			saveStatus(dataDir)
			_ = srv.Shutdown(ctx)
			os.Exit(1)
		}

		// replace binary
		if err := replaceBinary(appDir, dataDir); err != nil {
			pushLog("replace error: " + err.Error())
			if attempt < maxRetries {
				time.Sleep(retryDelay)
				continue
			}
			status.Phase = "done"
			status.Done = true
			status.Success = false
			status.Error = err.Error()
			saveStatus(dataDir)
			_ = srv.Shutdown(ctx)
			os.Exit(1)
		}

		break
	}

	// restart
	if err := restartApp(); err != nil {
		pushLog("restart error: " + err.Error())
		status.Error = err.Error()
	}

	// verify app comes back
	deadline := time.Now().Add(appWaitTimeout)
	verified := false
	for time.Now().Before(deadline) {
		if !portFree(appPort) {
			verified = true
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if !verified {
		pushLog("app did not come back within timeout")
	}

	status.Phase = "done"
	status.Done = true
	status.Success = verified
	if verified {
		pushLog("update complete — app restarted")
	} else {
		pushLog("update done but app restart unverified")
	}
	saveStatus(dataDir)

	_ = srv.Shutdown(ctx)
}
