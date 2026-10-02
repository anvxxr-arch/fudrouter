package db

import (
	"fmt"
	"time"
)

// Migration represents a database migration.
type Migration struct {
	ID      int
	Name    string
	SQL     string
	Applied bool
}

// migrations is the list of all migrations in order.
var migrations = []Migration{
	{
		ID:   1,
		Name: "initial_schema",
		SQL: `
			CREATE TABLE IF NOT EXISTS settings (
				id INTEGER PRIMARY KEY,
				data TEXT NOT NULL DEFAULT '{}'
			);
			CREATE TABLE IF NOT EXISTS providerConnections (
				id TEXT PRIMARY KEY,
				provider TEXT NOT NULL,
				authType TEXT NOT NULL DEFAULT 'apikey',
				name TEXT NOT NULL DEFAULT '',
				email TEXT NOT NULL DEFAULT '',
				priority INTEGER NOT NULL DEFAULT 999,
				isActive INTEGER NOT NULL DEFAULT 1,
				data TEXT NOT NULL DEFAULT '{}',
				base_url TEXT NOT NULL DEFAULT '',
				api_key TEXT NOT NULL DEFAULT '',
				createdAt TEXT NOT NULL DEFAULT '',
				updatedAt TEXT NOT NULL DEFAULT ''
			);
			CREATE TABLE IF NOT EXISTS apiKeys (
				id TEXT PRIMARY KEY,
				key TEXT NOT NULL,
				name TEXT NOT NULL DEFAULT '',
				machineId TEXT NOT NULL DEFAULT '',
				isActive INTEGER NOT NULL DEFAULT 1,
				createdAt TEXT NOT NULL DEFAULT ''
			);
			CREATE TABLE IF NOT EXISTS usageHistory (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				timestamp TEXT NOT NULL DEFAULT '',
				provider TEXT NOT NULL DEFAULT '',
				model TEXT NOT NULL DEFAULT '',
				connectionId TEXT NOT NULL DEFAULT '',
				promptTokens INTEGER NOT NULL DEFAULT 0,
				completionTokens INTEGER NOT NULL DEFAULT 0,
				cost REAL NOT NULL DEFAULT 0,
				status TEXT NOT NULL DEFAULT ''
			);
			CREATE INDEX IF NOT EXISTS idx_usage_provider ON usageHistory(provider);
			CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usageHistory(timestamp);
			CREATE INDEX IF NOT EXISTS idx_connections_provider ON providerConnections(provider);
		`,
	},
	{
		ID:   2,
		Name: "add_provider_metadata",
		SQL: `
			CREATE TABLE IF NOT EXISTS providerMetadata (
				providerId TEXT PRIMARY KEY,
				name TEXT NOT NULL DEFAULT '',
				description TEXT NOT NULL DEFAULT '',
				authTypes TEXT NOT NULL DEFAULT '[]',
				models TEXT NOT NULL DEFAULT '[]',
				supportsStreaming INTEGER NOT NULL DEFAULT 1,
				supportsTools INTEGER NOT NULL DEFAULT 1,
				supportsVision INTEGER NOT NULL DEFAULT 0,
				updatedAt TEXT NOT NULL DEFAULT ''
			);
		`,
	},
	{
		ID:   3,
		Name: "add_connection_health",
		SQL: `
			ALTER TABLE providerConnections ADD COLUMN healthStatus TEXT NOT NULL DEFAULT 'unknown';
			ALTER TABLE providerConnections ADD COLUMN lastHealthCheck TEXT NOT NULL DEFAULT '';
			ALTER TABLE providerConnections ADD COLUMN healthLatencyMs INTEGER NOT NULL DEFAULT 0;
		`,
	},
}

// Migrate runs all pending migrations (acquires the DB lock).
func (d *DB) Migrate() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.migrateLocked()
}

// migrateLocked runs all pending migrations. The caller MUST already hold d.mu.
func (d *DB) migrateLocked() error {
	// Create migrations table if not exists
	_, err := d.sql.Exec(`
		CREATE TABLE IF NOT EXISTS migrations (
			id INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			appliedAt TEXT NOT NULL DEFAULT ''
		)
	`)
	if err != nil {
		return fmt.Errorf("create migrations table: %w", err)
	}

	for _, m := range migrations {
		// Check if already applied
		var count int
		err := d.sql.QueryRow(`SELECT COUNT(*) FROM migrations WHERE id = ?`, m.ID).Scan(&count)
		if err != nil {
			return fmt.Errorf("check migration %d: %w", m.ID, err)
		}
		if count > 0 {
			continue
		}

		// Apply migration
		if _, err := d.sql.Exec(m.SQL); err != nil {
			return fmt.Errorf("apply migration %d (%s): %w", m.ID, m.Name, err)
		}

		// Record migration
		_, err = d.sql.Exec(
			`INSERT INTO migrations(id, name, appliedAt) VALUES(?, ?, ?)`,
			m.ID, m.Name, time.Now().UTC().Format(time.RFC3339),
		)
		if err != nil {
			return fmt.Errorf("record migration %d: %w", m.ID, err)
		}
	}

	return nil
}

// MigrationStatus returns the status of all migrations.
func (d *DB) MigrationStatus() ([]Migration, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	rows, err := d.sql.Query(`SELECT id, name, appliedAt FROM migrations ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	applied := map[int]bool{}
	appliedAt := map[int]string{}
	for rows.Next() {
		var id int
		var name, at string
		if err := rows.Scan(&id, &name, &at); err != nil {
			return nil, err
		}
		applied[id] = true
		appliedAt[id] = at
	}

	out := make([]Migration, 0, len(migrations))
	for _, m := range migrations {
		m.Applied = applied[m.ID]
		out = append(out, m)
	}
	return out, nil
}

