package store

import (
	"testing"
	"time"
)

// poolConfig must apply the project defaults only for pool_* keys the URL
// does not carry: pgxpool.ParseConfig fills nonzero pgx defaults on its own
// (MaxConns=max(4,NumCPU), lifetime 1h, idle 30m), so a naive `== 0` check
// could never distinguish "absent" from "pgx default".
func TestPoolConfigDefaults(t *testing.T) {
	cfg, err := poolConfig("postgres://u:p@127.0.0.1:5432/db")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MaxConns != 20 {
		t.Errorf("MaxConns = %d, want 20", cfg.MaxConns)
	}
	if cfg.MinConns != 2 {
		t.Errorf("MinConns = %d, want 2", cfg.MinConns)
	}
	if cfg.MaxConnLifetime != 30*time.Minute {
		t.Errorf("MaxConnLifetime = %v, want 30m", cfg.MaxConnLifetime)
	}
	if cfg.MaxConnIdleTime != 5*time.Minute {
		t.Errorf("MaxConnIdleTime = %v, want 5m", cfg.MaxConnIdleTime)
	}
	if cfg.HealthCheckPeriod != time.Minute {
		t.Errorf("HealthCheckPeriod = %v, want 1m", cfg.HealthCheckPeriod)
	}
}

// An explicit pool_max_conns in the URL wins verbatim; the other absent keys
// still get the project defaults.
func TestPoolConfigRespectsURL(t *testing.T) {
	cfg, err := poolConfig("postgres://u:p@127.0.0.1:5432/db?pool_max_conns=7")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MaxConns != 7 {
		t.Errorf("MaxConns = %d, want 7 (URL value must win)", cfg.MaxConns)
	}
	if cfg.MinConns != 2 {
		t.Errorf("MinConns = %d, want 2", cfg.MinConns)
	}
}

// A malformed DSN must surface the parse error, not a pool with defaults.
func TestPoolConfigBadDSN(t *testing.T) {
	if _, err := poolConfig("postgres://u:p@127.0.0.1:5432/db?pool_max_conns=bogus"); err == nil {
		t.Error("expected error for unparseable pool_max_conns, got nil")
	}
}

// A DSN with an explicit small pool_max_conns and no min must not get the
// default MinConns=2: pgx rejects min > max, so the default floor clamps to
// the explicit ceiling.
func TestPoolConfigClampsMinToSmallMax(t *testing.T) {
	cfg, err := poolConfig("postgres://u:p@127.0.0.1:5432/db?pool_max_conns=1")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MaxConns != 1 {
		t.Errorf("MaxConns = %d, want 1 (URL value must win)", cfg.MaxConns)
	}
	if cfg.MinConns != 1 {
		t.Errorf("MinConns = %d, want 1 (clamped to MaxConns)", cfg.MinConns)
	}
}
