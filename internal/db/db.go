package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

type DB struct {
	sql *sql.DB
	mu  sync.Mutex
}

func Open(dataDir string) (*DB, error) {
	if dataDir == "" {
		home, _ := os.UserHomeDir()
		dataDir = filepath.Join(home, ".fudrouter")
	}
	path := filepath.Join(dataDir, "db", "data.sqlite")
	if _, err := os.Stat(path); err != nil {
		// also try alt path
		alt := filepath.Join(dataDir, "data", "data.sqlite")
		if _, err2 := os.Stat(alt); err2 == nil {
			path = alt
		} else {
			return nil, fmt.Errorf("sqlite not found at %s", path)
		}
	}
	dsn := "file:" + path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)"
	sqlDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	sqlDB.SetMaxOpenConns(10)
	sqlDB.SetMaxIdleConns(5)
	sqlDB.SetConnMaxLifetime(30 * time.Minute)
	if err := sqlDB.Ping(); err != nil {
		_ = sqlDB.Close()
		return nil, err
	}
	return &DB{sql: sqlDB}, nil
}

func (d *DB) Close() error { return d.sql.Close() }

func (d *DB) Path() string { return "" }

func (d *DB) Settings() (map[string]any, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	var raw string
	err := d.sql.QueryRow(`SELECT data FROM settings WHERE id=1`).Scan(&raw)
	if err == sql.ErrNoRows {
		return map[string]any{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := map[string]any{}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (d *DB) PatchSettings(patch map[string]any) (map[string]any, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	cur := map[string]any{}
	var raw string
	err := d.sql.QueryRow(`SELECT data FROM settings WHERE id=1`).Scan(&raw)
	missing := err == sql.ErrNoRows
	if err != nil && !missing {
		return nil, err
	}
	if raw != "" {
		_ = json.Unmarshal([]byte(raw), &cur)
	}
	for k, v := range patch {
		cur[k] = v
	}
	b, err := json.Marshal(cur)
	if err != nil {
		return nil, err
	}
	if missing || raw == "" {
		_, err = d.sql.Exec(`INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`, string(b))
	} else {
		_, err = d.sql.Exec(`UPDATE settings SET data=? WHERE id=1`, string(b))
	}
	return cur, err
}

type Connection struct {
	ID        string         `json:"id"`
	Provider  string         `json:"provider"`
	AuthType  string         `json:"authType"`
	Name      string         `json:"name"`
	Email     string         `json:"email,omitempty"`
	Priority  int            `json:"priority"`
	IsActive  int            `json:"isActive"`
	Data      map[string]any `json:"data,omitempty"`
	BaseURL   string         `json:"base_url,omitempty"`
	APIKey    string         `json:"api_key,omitempty"`
	CreatedAt string         `json:"createdAt,omitempty"`
	UpdatedAt string         `json:"updatedAt,omitempty"`
}

func (d *DB) ListConnections() ([]Connection, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	rows, err := d.sql.Query(`
		SELECT id, provider, authType, COALESCE(name,''), COALESCE(email,''), COALESCE(priority,999),
		       isActive, COALESCE(data,'{}'), COALESCE(createdAt,''), COALESCE(updatedAt,''),
		       COALESCE(base_url,''), COALESCE(api_key,'')
		FROM providerConnections ORDER BY provider, priority`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Connection
	for rows.Next() {
		var c Connection
		var dataRaw string
		if err := rows.Scan(&c.ID, &c.Provider, &c.AuthType, &c.Name, &c.Email, &c.Priority, &c.IsActive, &dataRaw, &c.CreatedAt, &c.UpdatedAt, &c.BaseURL, &c.APIKey); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(dataRaw), &c.Data)
		if c.Data == nil {
			c.Data = map[string]any{}
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (d *DB) ActiveConnections(provider string) ([]Connection, error) {
	all, err := d.ListConnections()
	if err != nil {
		return nil, err
	}
	var out []Connection
	for _, c := range all {
		if c.IsActive == 1 && (provider == "" || c.Provider == provider) {
			out = append(out, c)
		}
	}
	return out, nil
}

type APIKey struct {
	ID        string `json:"id"`
	Key       string `json:"key"`
	Name      string `json:"name"`
	MachineID string `json:"machineId,omitempty"`
	IsActive  int    `json:"isActive"`
	CreatedAt string `json:"createdAt,omitempty"`
}

func (d *DB) ListAPIKeys() ([]APIKey, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	rows, err := d.sql.Query(`SELECT id, key, COALESCE(name,''), COALESCE(machineId,''), isActive, COALESCE(createdAt,'') FROM apiKeys ORDER BY createdAt`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []APIKey
	for rows.Next() {
		var k APIKey
		if err := rows.Scan(&k.ID, &k.Key, &k.Name, &k.MachineID, &k.IsActive, &k.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

type UsageRow struct {
	ID               int64   `json:"id"`
	Timestamp        string  `json:"timestamp"`
	Provider         string  `json:"provider"`
	Model            string  `json:"model"`
	ConnectionID     string  `json:"connectionId"`
	PromptTokens     int     `json:"promptTokens"`
	CompletionTokens int     `json:"completionTokens"`
	Cost             float64 `json:"cost"`
	Status           string  `json:"status"`
}

func (d *DB) RecentUsage(limit int) ([]UsageRow, error) {
	if limit <= 0 {
		limit = 50
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	rows, err := d.sql.Query(`
		SELECT id, timestamp, COALESCE(provider,''), COALESCE(model,''), COALESCE(connectionId,''),
		       COALESCE(promptTokens,0), COALESCE(completionTokens,0), COALESCE(cost,0), COALESCE(status,'')
		FROM usageHistory ORDER BY id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []UsageRow
	for rows.Next() {
		var u UsageRow
		if err := rows.Scan(&u.ID, &u.Timestamp, &u.Provider, &u.Model, &u.ConnectionID, &u.PromptTokens, &u.CompletionTokens, &u.Cost, &u.Status); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func (d *DB) UsageStats() (map[string]any, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	var total, okN, errN int
	var prompt, completion int
	var cost float64
	_ = d.sql.QueryRow(`SELECT COUNT(*) FROM usageHistory`).Scan(&total)
	_ = d.sql.QueryRow(`SELECT COUNT(*) FROM usageHistory WHERE status='ok' OR status='success' OR status='200'`).Scan(&okN)
	_ = d.sql.QueryRow(`SELECT COUNT(*) FROM usageHistory WHERE status LIKE 'error%' OR status='failed' OR CAST(status AS INTEGER)>=400`).Scan(&errN)
	_ = d.sql.QueryRow(`SELECT COALESCE(SUM(promptTokens),0), COALESCE(SUM(completionTokens),0), COALESCE(SUM(cost),0) FROM usageHistory`).Scan(&prompt, &completion, &cost)
	return map[string]any{
		"totalRequests":     total,
		"ok":                okN,
		"errors":            errN,
		"promptTokens":      prompt,
		"completionTokens":  completion,
		"cost":              cost,
		"generatedAt":       time.Now().UTC().Format(time.RFC3339),
	}, nil
}

func MaskKey(k string) string {
	if len(k) <= 12 {
		return "***"
	}
	return k[:8] + "…" + k[len(k)-4:]
}

func ConnPublic(c Connection) map[string]any {
	m := map[string]any{
		"id":        c.ID,
		"provider":  c.Provider,
		"authType":  c.AuthType,
		"name":      c.Name,
		"email":     c.Email,
		"priority":  c.Priority,
		"isActive":  c.IsActive == 1,
		"createdAt": c.CreatedAt,
		"updatedAt": c.UpdatedAt,
		"base_url":  c.BaseURL,
	}
	if c.APIKey != "" {
		m["api_key"] = MaskKey(c.APIKey)
		m["hasApiKey"] = true
	}
	// strip secrets from data blob
	safeData := map[string]any{}
	for k, v := range c.Data {
		lk := k
		if lk == "apiKey" || lk == "api_key" || lk == "accessToken" || lk == "refreshToken" || lk == "token" || lk == "password" {
			if s, ok := v.(string); ok && s != "" {
				safeData[k] = "***"
			}
			continue
		}
		safeData[k] = v
	}
	m["data"] = safeData
	return m
}
