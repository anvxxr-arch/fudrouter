package oauth

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const CursorAPIBase = "https://api2.cursor.sh"

// ImportCursorToken validates and normalizes a Cursor access token + machine id pair.
func ImportCursorToken(accessToken, machineID string) (map[string]any, error) {
	accessToken = strings.TrimSpace(accessToken)
	machineID = strings.TrimSpace(machineID)
	if accessToken == "" {
		return nil, fmt.Errorf("accessToken required")
	}
	if len(accessToken) < 50 {
		return nil, fmt.Errorf("accessToken looks too short")
	}
	if machineID == "" {
		return nil, fmt.Errorf("machineId required (from storage.serviceMachineId)")
	}
	email := DecodeIDTokenEmail(accessToken)
	return map[string]any{
		"accessToken":   accessToken,
		"machineId":     machineID,
		"provider":      "cursor",
		"authType":      "oauth",
		"authMethod":    "imported",
		"email":         email,
		"expiresIn":     86400,
		"expiresAt":     time.Now().Add(24 * time.Hour).UTC().Format(time.RFC3339),
		"apiBaseUrl":    CursorAPIBase,
		"clientVersion": "3.12.17",
		"clientType":    "ide",
	}, nil
}

// AutoImportCursor tries to read Cursor IDE state.vscdb on this machine.
func AutoImportCursor() (map[string]any, bool, string) {
	home, _ := os.UserHomeDir()
	candidates := []string{
		filepath.Join(home, ".config/Cursor/User/globalStorage/state.vscdb"),
		filepath.Join(home, ".config/cursor/User/globalStorage/state.vscdb"),
		filepath.Join(home, ".config/Cursor - Insiders/User/globalStorage/state.vscdb"),
	}
	var foundDB string
	for _, p := range candidates {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			foundDB = p
			break
		}
	}
	if foundDB == "" {
		return nil, false, "Cursor config not found on this host (expected ~/.config/Cursor/.../state.vscdb)"
	}
	db, err := sql.Open("sqlite", foundDB)
	if err != nil {
		return nil, false, "open state.vscdb: " + err.Error()
	}
	defer db.Close()

	get := func(keys ...string) string {
		for _, k := range keys {
			var v string
			err := db.QueryRow(`SELECT value FROM ItemTable WHERE key = ?`, k).Scan(&v)
			if err == nil && strings.TrimSpace(v) != "" {
				return strings.TrimSpace(v)
			}
		}
		return ""
	}
	access := get("cursorAuth/accessToken", "cursorAuth/token")
	machine := get("storage.serviceMachineId", "storage.machineId", "telemetry.machineId")
	if access == "" || machine == "" {
		return map[string]any{"dbPath": foundDB, "hasToken": access != "", "hasMachineId": machine != ""}, false,
			"Cursor config found but accessToken/machineId missing — is Cursor logged in?"
	}
	res, err := ImportCursorToken(access, machine)
	if err != nil {
		return nil, false, err.Error()
	}
	res["dbPath"] = foundDB
	res["autoImported"] = true
	return res, true, ""
}

// CursorChecksum builds a best-effort opaque checksum marker.
func CursorChecksum(machineID, token string) string {
	sum := sha256.Sum256([]byte(machineID + "|" + token))
	return hex.EncodeToString(sum[:])
}

// ParseCursorAuthJSON accepts flexible import payloads.
func ParseCursorAuthJSON(raw []byte) (access, machine string, err error) {
	var m map[string]any
	if err = json.Unmarshal(raw, &m); err != nil {
		return "", "", err
	}
	access = firstString(m, "accessToken", "access_token", "token")
	machine = firstString(m, "machineId", "machine_id", "serviceMachineId")
	if access == "" {
		if nested, ok := m["cursorAuth"].(map[string]any); ok {
			access = firstString(nested, "accessToken", "token")
		}
	}
	return access, machine, nil
}
