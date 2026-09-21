package db

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"

	"github.com/google/uuid"
)

func nowISO() string { return time.Now().UTC().Format(time.RFC3339) }

func (d *DB) ensureExtraSchema() error {
	// caller may or may not hold lock — use separate unlocked helper
	return d.ensureExtraSchemaUnlocked()
}

func (d *DB) ensureExtraSchemaUnlocked() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY, data TEXT NOT NULL, expiresAt TEXT NOT NULL, createdAt TEXT NOT NULL)`,
	}
	for _, s := range stmts {
		if _, err := d.sql.Exec(s); err != nil {
			return err
		}
	}
	return nil
}

func (d *DB) EnsureReady() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.Migrate(); err != nil {
		return err
	}
	return d.ensureExtraSchemaUnlocked()
}

func (d *DB) GetConnection(id string) (Connection, bool, error) {
	list, err := d.ListConnections()
	if err != nil {
		return Connection{}, false, err
	}
	for _, c := range list {
		if c.ID == id {
			return c, true, nil
		}
	}
	return Connection{}, false, nil
}

func (d *DB) UpsertConnection(c Connection) (Connection, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if c.ID == "" {
		c.ID = uuid.NewString()
	}
	if c.AuthType == "" {
		c.AuthType = "apikey"
	}
	if c.CreatedAt == "" {
		c.CreatedAt = nowISO()
	}
	c.UpdatedAt = nowISO()
	if c.Data == nil {
		c.Data = map[string]any{}
	}
	raw, _ := json.Marshal(c.Data)
	_, err := d.sql.Exec(`
		INSERT INTO providerConnections(id,provider,authType,name,email,priority,isActive,data,createdAt,updatedAt,base_url,api_key)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET
		  provider=excluded.provider, authType=excluded.authType, name=excluded.name, email=excluded.email,
		  priority=excluded.priority, isActive=excluded.isActive, data=excluded.data, updatedAt=excluded.updatedAt,
		  base_url=excluded.base_url, api_key=excluded.api_key`,
		c.ID, c.Provider, c.AuthType, c.Name, c.Email, c.Priority, c.IsActive, string(raw), c.CreatedAt, c.UpdatedAt, c.BaseURL, c.APIKey)
	return c, err
}

func (d *DB) DeleteConnection(id string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	_, err := d.sql.Exec(`DELETE FROM providerConnections WHERE id=?`, id)
	return err
}

func (d *DB) FindAPIKey(raw string) (APIKey, bool, error) {
	keys, err := d.ListAPIKeys()
	if err != nil {
		return APIKey{}, false, err
	}
	raw = strings.TrimSpace(strings.TrimPrefix(raw, "Bearer "))
	// Hash the incoming key for comparison
	hash := sha256.Sum256([]byte(raw))
	hashed := hex.EncodeToString(hash[:])
	for _, k := range keys {
		if k.IsActive == 1 && k.Key == hashed {
			return k, true, nil
		}
	}
	return APIKey{}, false, nil
}

func (d *DB) InsertAPIKey(k APIKey) (APIKey, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if k.ID == "" {
		k.ID = uuid.NewString()
	}
	if k.CreatedAt == "" {
		k.CreatedAt = nowISO()
	}
	if k.IsActive == 0 {
		k.IsActive = 1
	}
	// Store SHA-256 hash of the key, not the plaintext
	hash := sha256.Sum256([]byte(k.Key))
	k.Key = hex.EncodeToString(hash[:])
	_, err := d.sql.Exec(`INSERT INTO apiKeys(id,key,name,machineId,isActive,createdAt) VALUES(?,?,?,?,?,?)`,
		k.ID, k.Key, k.Name, k.MachineID, k.IsActive, k.CreatedAt)
	return k, err
}

func (d *DB) DeleteAPIKey(id string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	_, err := d.sql.Exec(`DELETE FROM apiKeys WHERE id=?`, id)
	return err
}

type Combo struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Kind      string `json:"kind,omitempty"`
	Models    any    `json:"models"`
	CreatedAt string `json:"createdAt,omitempty"`
	UpdatedAt string `json:"updatedAt,omitempty"`
}

func (d *DB) ListCombos() ([]Combo, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	rows, err := d.sql.Query(`SELECT id, name, COALESCE(kind,''), COALESCE(models,'[]'), COALESCE(createdAt,''), COALESCE(updatedAt,'') FROM combos ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Combo
	for rows.Next() {
		var c Combo
		var modelsRaw string
		if err := rows.Scan(&c.ID, &c.Name, &c.Kind, &modelsRaw, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(modelsRaw), &c.Models)
		out = append(out, c)
	}
	return out, rows.Err()
}

func (d *DB) UpsertCombo(c Combo) (Combo, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if c.ID == "" {
		c.ID = uuid.NewString()
	}
	if c.CreatedAt == "" {
		c.CreatedAt = nowISO()
	}
	c.UpdatedAt = nowISO()
	raw, _ := json.Marshal(c.Models)
	_, err := d.sql.Exec(`INSERT INTO combos(id,name,kind,models,createdAt,updatedAt) VALUES(?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, models=excluded.models, updatedAt=excluded.updatedAt`,
		c.ID, c.Name, c.Kind, string(raw), c.CreatedAt, c.UpdatedAt)
	return c, err
}

func (d *DB) DeleteCombo(id string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	_, err := d.sql.Exec(`DELETE FROM combos WHERE id=?`, id)
	return err
}

type Node struct {
	ID        string         `json:"id"`
	Type      string         `json:"type"`
	Name      string         `json:"name"`
	Data      map[string]any `json:"data"`
	CreatedAt string         `json:"createdAt,omitempty"`
	UpdatedAt string         `json:"updatedAt,omitempty"`
}

func (d *DB) ListNodes() ([]Node, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	rows, err := d.sql.Query(`SELECT id, COALESCE(type,''), COALESCE(name,''), COALESCE(data,'{}'), COALESCE(createdAt,''), COALESCE(updatedAt,'') FROM providerNodes ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Node
	for rows.Next() {
		var n Node
		var raw string
		if err := rows.Scan(&n.ID, &n.Type, &n.Name, &raw, &n.CreatedAt, &n.UpdatedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(raw), &n.Data)
		if n.Data == nil {
			n.Data = map[string]any{}
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

func (d *DB) UpsertNode(n Node) (Node, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if n.ID == "" {
		n.ID = uuid.NewString()
	}
	if n.CreatedAt == "" {
		n.CreatedAt = nowISO()
	}
	n.UpdatedAt = nowISO()
	if n.Data == nil {
		n.Data = map[string]any{}
	}
	raw, _ := json.Marshal(n.Data)
	_, err := d.sql.Exec(`INSERT INTO providerNodes(id,type,name,data,createdAt,updatedAt) VALUES(?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET type=excluded.type, name=excluded.name, data=excluded.data, updatedAt=excluded.updatedAt`,
		n.ID, n.Type, n.Name, string(raw), n.CreatedAt, n.UpdatedAt)
	return n, err
}

func (d *DB) DeleteNode(id string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	_, err := d.sql.Exec(`DELETE FROM providerNodes WHERE id=?`, id)
	return err
}

type ProxyPool struct {
	ID         string         `json:"id"`
	IsActive   int            `json:"isActive"`
	TestStatus string         `json:"testStatus"`
	Data       map[string]any `json:"data"`
	CreatedAt  string         `json:"createdAt,omitempty"`
	UpdatedAt  string         `json:"updatedAt,omitempty"`
}

func (d *DB) ListProxyPools() ([]ProxyPool, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	rows, err := d.sql.Query(`SELECT id, isActive, COALESCE(testStatus,''), COALESCE(data,'{}'), COALESCE(createdAt,''), COALESCE(updatedAt,'') FROM proxyPools`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ProxyPool
	for rows.Next() {
		var p ProxyPool
		var raw string
		if err := rows.Scan(&p.ID, &p.IsActive, &p.TestStatus, &raw, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(raw), &p.Data)
		if p.Data == nil {
			p.Data = map[string]any{}
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (d *DB) UpsertProxyPool(p ProxyPool) (ProxyPool, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if p.ID == "" {
		p.ID = uuid.NewString()
	}
	if p.CreatedAt == "" {
		p.CreatedAt = nowISO()
	}
	p.UpdatedAt = nowISO()
	if p.Data == nil {
		p.Data = map[string]any{}
	}
	raw, _ := json.Marshal(p.Data)
	_, err := d.sql.Exec(`INSERT INTO proxyPools(id,isActive,testStatus,data,createdAt,updatedAt) VALUES(?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET isActive=excluded.isActive, testStatus=excluded.testStatus, data=excluded.data, updatedAt=excluded.updatedAt`,
		p.ID, p.IsActive, p.TestStatus, string(raw), p.CreatedAt, p.UpdatedAt)
	return p, err
}

func (d *DB) DeleteProxyPool(id string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	_, err := d.sql.Exec(`DELETE FROM proxyPools WHERE id=?`, id)
	return err
}

func (d *DB) KVGet(scope, key string) (string, bool, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	var v string
	err := d.sql.QueryRow(`SELECT value FROM kv WHERE scope=? AND key=?`, scope, key).Scan(&v)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	return v, err == nil, err
}

func (d *DB) KVSet(scope, key, value string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	_, err := d.sql.Exec(`INSERT INTO kv(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value`, scope, key, value)
	return err
}

func (d *DB) KVList(scope string) (map[string]string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	rows, err := d.sql.Query(`SELECT key, value FROM kv WHERE scope=?`, scope)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

func (d *DB) KVDelete(scope, key string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	_, err := d.sql.Exec(`DELETE FROM kv WHERE scope=? AND key=?`, scope, key)
	return err
}

func (d *DB) RecordUsage(u UsageRow) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if u.Timestamp == "" {
		u.Timestamp = nowISO()
	}
	_, err := d.sql.Exec(`INSERT INTO usageHistory(timestamp,provider,model,connectionId,promptTokens,completionTokens,cost,status)
		VALUES(?,?,?,?,?,?,?,?)`, u.Timestamp, u.Provider, u.Model, u.ConnectionID, u.PromptTokens, u.CompletionTokens, u.Cost, u.Status)
	return err
}

func (d *DB) CreateSession(id string, data map[string]any, ttl time.Duration) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	_ = d.ensureExtraSchemaUnlocked()
	raw, _ := json.Marshal(data)
	exp := time.Now().UTC().Add(ttl).Format(time.RFC3339)
	_, err := d.sql.Exec(`INSERT INTO sessions(id,data,expiresAt,createdAt) VALUES(?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET data=excluded.data, expiresAt=excluded.expiresAt`, id, string(raw), exp, nowISO())
	return err
}

func (d *DB) GetSession(id string) (map[string]any, bool, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	_ = d.ensureExtraSchemaUnlocked()
	var raw, exp string
	err := d.sql.QueryRow(`SELECT data, expiresAt FROM sessions WHERE id=?`, id).Scan(&raw, &exp)
	if err == sql.ErrNoRows {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	t, _ := time.Parse(time.RFC3339, exp)
	if time.Now().UTC().After(t) {
		_, _ = d.sql.Exec(`DELETE FROM sessions WHERE id=?`, id)
		return nil, false, nil
	}
	out := map[string]any{}
	_ = json.Unmarshal([]byte(raw), &out)
	return out, true, nil
}

func (d *DB) DeleteSession(id string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	_ = d.ensureExtraSchemaUnlocked()
	_, err := d.sql.Exec(`DELETE FROM sessions WHERE id=?`, id)
	return err
}
