package db

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

// Backup creates a compressed backup of the database.
func (d *DB) Backup(backupPath string) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	// Ensure the database is in a consistent state
	if _, err := d.sql.Exec("PRAGMA wal_checkpoint(TRUNCATE);"); err != nil {
		return fmt.Errorf("checkpoint failed: %w", err)
	}

	// Open the database file
	dbPath := d.Path()
	if dbPath == "" {
		return fmt.Errorf("database path is empty")
	}

	src, err := os.Open(dbPath)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer src.Close()

	// Create backup file
	dst, err := os.Create(backupPath)
	if err != nil {
		return fmt.Errorf("create backup file: %w", err)
	}
	defer dst.Close()

	// Create gzip writer
	gz := gzip.NewWriter(dst)
	defer gz.Close()

	// Create tar writer
	tw := tar.NewWriter(gz)
	defer tw.Close()

	// Get file info
	info, err := src.Stat()
	if err != nil {
		return fmt.Errorf("stat database: %w", err)
	}

	// Write tar header
	header := &tar.Header{
		Name:    filepath.Base(dbPath),
		Size:    info.Size(),
		Mode:    int64(info.Mode()),
		ModTime: info.ModTime(),
	}
	if err := tw.WriteHeader(header); err != nil {
		return fmt.Errorf("write tar header: %w", err)
	}

	// Write file content
	if _, err := io.Copy(tw, src); err != nil {
		return fmt.Errorf("write database to backup: %w", err)
	}

	return nil
}

// Restore restores a database from a backup.
func (d *DB) Restore(backupPath string) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	// Open backup file
	src, err := os.Open(backupPath)
	if err != nil {
		return fmt.Errorf("open backup file: %w", err)
	}
	defer src.Close()

	// Create gzip reader
	gz, err := gzip.NewReader(src)
	if err != nil {
		return fmt.Errorf("create gzip reader: %w", err)
	}
	defer gz.Close()

	// Create tar reader
	tr := tar.NewReader(gz)

	// Read tar entries
	for {
		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("read tar entry: %w", err)
		}

		// Only restore the database file
		if header.Typeflag != tar.TypeReg {
			continue
		}

		dbPath := d.Path()
		if dbPath == "" {
			return fmt.Errorf("database path is empty")
		}

		// Create temporary file
		tmpPath := dbPath + ".restore.tmp"
		dst, err := os.Create(tmpPath)
		if err != nil {
			return fmt.Errorf("create temp file: %w", err)
		}

		// Copy content
		if _, err := io.Copy(dst, tr); err != nil {
			dst.Close()
			os.Remove(tmpPath)
			return fmt.Errorf("write restored database: %w", err)
		}
		dst.Close()

		// Replace original database
		if err := os.Rename(tmpPath, dbPath); err != nil {
			os.Remove(tmpPath)
			return fmt.Errorf("replace database: %w", err)
		}

		break
	}

	return nil
}

// BackupWithTimestamp creates a backup with a timestamp in the filename.
func (d *DB) BackupWithTimestamp(backupDir string) (string, error) {
	timestamp := time.Now().UTC().Format("20060102_150405")
	filename := fmt.Sprintf("fudrouter_backup_%s.tar.gz", timestamp)
	path := filepath.Join(backupDir, filename)

	if err := d.Backup(path); err != nil {
		return "", err
	}
	return path, nil
}

// ListBackups lists all backup files in a directory.
func ListBackups(backupDir string) ([]string, error) {
	entries, err := os.ReadDir(backupDir)
	if err != nil {
		return nil, err
	}

	var backups []string
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if len(name) > 4 && name[len(name)-4:] == ".tar.gz" {
			backups = append(backups, filepath.Join(backupDir, name))
		}
	}
	return backups, nil
}
