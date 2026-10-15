// Package store is the data plane's only database access.
//
// The schema is `backend/go/migrations/0006_platform_schema.sql` +
// `0007_platform_backfill.sql` (literal source of truth:
// docs/specs/2026-09-30-platform-schema.md §3–§10). Legacy S0 columns
// (`provider.base_url`, `provider.credentials_enc`, `api_key.limits`,
// `request_log.tokens_in/tokens_out/cost`) still exist and are still written and
// read here until migration 0009 drops them — the compatibility promises in
// spec §14 depend on it.
package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound is the "no such row" answer for every lookup here.
var ErrNotFound = errors.New("not found")

// Store is the data plane's only database access.
//
// allowDevProviders gates rows with `provider.tier = 'dev'` / `provider.status
// = 'dev'` (S0 vocabulary until migration 0008). The S0 spec (§1) forbids
// shipping a personal-OAuth provider layer, so a non-commercial provider is
// onboarded as `dev` and is invisible unless ROUTER_ALLOW_DEV_PROVIDERS is
// explicitly set. Enforcement lives here, in SQL, rather than in a comment
// asking a future release engineer to remember to delete a row — comments do
// not ship, predicates do. The same predicate is mirrored by the control
// plane's publish gate (apps/web `publish.ts`, endpoint-surface spec §2.1), so
// `/v1/models` and the public `/models` page cannot drift.
type Store struct {
	pool              *pgxpool.Pool
	allowDevProviders bool
	// cacheNS namespaces every Valkey entry this process writes. Two
	// deployments that share one Valkey (a drill, a staging box) but serve
	// different databases would otherwise read each other's catalogue — the
	// drill proved it: its second boot with ROUTER_ALLOW_DEV_PROVIDERS=1 read
	// the dev-hidden list the first boot had cached.
	cacheNS string
	// providerServable is the provider predicate built once from
	// allowDevProviders (see providerServableSQLFor). Every catalogue query
	// interpolates it, so rebuilding the string per call was pure waste.
	providerServable string
	// hardLimits caches `system_setting['platform_hard_limits']` in-process
	// (see hardLimitCache). Guarded by hardLimitsMu; expiry bounds the skew.
	hardLimitsMu  sync.RWMutex
	hardLimits    hardLimitCache
	hardLimitsExp time.Time
	// admission caches the two reads checkBudgets makes before every dispatch
	// (the billing account + environment budget, and the scoped budget rows).
	// It is the difference between one Postgres round trip per request and one
	// per TTL; see admission.go for the bounds and why the two TTLs differ.
	admission admissionCache
}

// hardLimitCache is one cached copy of
// `system_setting['platform_hard_limits']`. The row changes only when an
// operator edits it, so a short TTL bounds the skew without an
// invalidation channel.
type hardLimitCache struct {
	RPM         *int64
	TPM         *int64
	Concurrency *int64
}

func New(ctx context.Context, dsn string) (*Store, error) {
	cfg, err := poolConfig(dsn)
	if err != nil {
		return nil, err
	}
	// The tracer must be on the config BEFORE the pool exists: pgxpool copies
	// the config at creation and pool.Config() hands back a COPY, so setting it
	// afterwards silently does nothing (measured: 0 traced queries).
	if tracer := testQueryTracer(); tracer != nil {
		cfg.ConnConfig.Tracer = tracer
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	allowDev := envBool("ROUTER_ALLOW_DEV_PROVIDERS")
	return &Store{
		pool:              pool,
		allowDevProviders: allowDev,
		cacheNS:           cacheNamespaceFor(dsn),
		providerServable:  providerServableSQLFor(allowDev),
	}, nil
}

// testQueryTracerHook is the hook New consults to install a query tracer. It is
// nil in production (the variable is only ever set by the export_test.go
// accessor), so this costs one nil interface compare per Store construction,
// not per query.
//
// Why it exists: the admission half of the lifecycle is a SEQUENCE OF QUERIES,
// and the honest way to test that a query-count change removed a round trip is
// to count queries. Loopback timings cannot do it: Candidates measured 322µs
// (HEAD, two queries) vs 338µs (one query) — the 14µs saved is inside the
// noise band, so a timing assertion would either always pass or flap.
var testQueryTracerHook func() pgx.QueryTracer

func testQueryTracer() pgx.QueryTracer {
	if testQueryTracerHook == nil {
		return nil
	}
	return testQueryTracerHook()
}

// DevProvidersAllowed reports whether this process serves dev-tier providers.
// Callers that build a Valkey key from a catalogue query MUST fold this in:
// the catalogue SQL filters on providerServable, which is derived from
// ROUTER_ALLOW_DEV_PROVIDERS, so a shared entry between two processes with
// different settings is a wrong answer, not a stale one.
func (s *Store) DevProvidersAllowed() bool { return s.allowDevProviders }

// CacheNamespace is the per-database prefix for Valkey entries (see cacheNS).
func (s *Store) CacheNamespace() string { return s.cacheNS }

// cacheNamespaceFor derives a short cache namespace from the DSN's host, port
// and database — never the credentials, so nothing secret is ever written into
// a cache key. Two processes on the same database share entries (restart keeps
// its cache warm); two on different databases never do. An unparseable DSN
// degrades to a constant, which at worst collapses namespaces but cannot leak
// one database's rows into another's answers.
func cacheNamespaceFor(dsn string) string {
	cfg, err := pgconn.ParseConfig(dsn)
	if err != nil {
		return "unknown"
	}
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%d/%s", cfg.Host, cfg.Port, cfg.Database)))
	return hex.EncodeToString(sum[:])[:10]
}

// poolConfig parses the DSN and applies the project's pool bounds.
//
// pgxpool.ParseConfig fills nonzero pgx defaults (MaxConns=max(4,NumCPU),
// lifetime 1h, idle 30m) when the URL carries no pool_* parameter, so a
// naive `== 0` check can never tell "absent" from "pgx default". Presence
// is detected on the raw pgconn parse instead: a pool_* key in the URL wins
// verbatim (pgx validates it), and only an absent key gets the project
// default — one source of truth, no silent override either way.
func poolConfig(dsn string) (*pgxpool.Config, error) {
	raw, err := pgconn.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	_, hasMax := raw.RuntimeParams["pool_max_conns"]
	_, hasMin := raw.RuntimeParams["pool_min_conns"]
	_, hasLife := raw.RuntimeParams["pool_max_conn_lifetime"]
	_, hasIdle := raw.RuntimeParams["pool_max_conn_idle_time"]
	_, hasHealth := raw.RuntimeParams["pool_health_check_period"]
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	if !hasMax {
		cfg.MaxConns = 20
	}
	if !hasMin {
		// Clamp the default floor to an explicit small MaxConns: a DSN with
		// pool_max_conns=1 and no min would otherwise get MinConns=2, an
		// invalid pool (pgx rejects min > max). An explicit pool_min_conns
		// still wins verbatim — pgx validates that combination itself.
		cfg.MinConns = min(2, cfg.MaxConns)
	}
	if !hasLife {
		cfg.MaxConnLifetime = 30 * time.Minute
	}
	if !hasIdle {
		cfg.MaxConnIdleTime = 5 * time.Minute
	}
	if !hasHealth {
		cfg.HealthCheckPeriod = time.Minute
	}
	return cfg, nil
}

// envBool accepts only explicit truthy values, so a typo or an empty string
// fails closed (dev providers stay hidden) instead of open.
func envBool(name string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

func (s *Store) Close() { s.pool.Close() }

// Ping reports whether the database is actually reachable. The health handler
// uses it so readiness reflects the dependency the service cannot work without:
// before this, /health returned {"ok":true} while the DB was down, so an
// uptime monitor saw a router that could not serve a single request.
func (s *Store) Ping(ctx context.Context) error {
	return s.pool.Ping(ctx)
}

// TouchAPIKey records a key's last use. Best-effort telemetry: a failure here
// never fails a request.
func (s *Store) TouchAPIKey(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `update api_key set last_used_at = now() where id = $1`, id)
	return err
}

// UpdateProviderCredentials rewrites a provider's encrypted credential blob.
//
// This exists because xAI rotates the refresh_token on every exchange: if the
// rotated value is not written back, the stored one is dead the moment the
// access token expires (which it did — three accounts were lost this way before
// the refresh path persisted anything).
//
// It writes the LEGACY column (spec §4 keeps `provider.credentials_enc` until
// 0009). Credential ROWS are the new home for secrets; the blob survives for
// providers whose accounts have not been split yet, and both are read — see
// LookupAPIKey/Candidates and CredentialSecrets.
func (s *Store) UpdateProviderCredentials(ctx context.Context, providerID, enc string) error {
	// NOTE: `provider` has no updated_at column — do not add one here without a
	// migration, or every refresh silently fails to persist.
	_, err := s.pool.Exec(ctx,
		`update provider set credentials_enc = $1 where id = $2`, enc, providerID)
	return err
}

// ProviderCredentials returns a provider's encrypted credential blob, so a
// writer can merge into the CURRENT state instead of overwriting it with a
// snapshot it built earlier. Two writers persist this column: the router's
// on-demand refresh and the pool maintenance rotation.
func (s *Store) ProviderCredentials(ctx context.Context, providerID string) (string, error) {
	var enc string
	err := s.pool.QueryRow(ctx,
		`select credentials_enc from provider where id = $1`, providerID).Scan(&enc)
	return enc, err
}

// UpdateCredentialSecret rewrites one credential row's secret envelope.
//
// The OAuth refresher rotates refresh tokens on every exchange; the rotated
// value MUST reach durable storage or the credential is dead at its next
// expiry. This is the row-scoped equivalent of UpdateProviderCredentials.
func (s *Store) UpdateCredentialSecret(ctx context.Context, credentialID, secretEnc string) error {
	_, err := s.pool.Exec(ctx,
		`update credential set secret_enc = $1, updated_at = now() where id = $2`,
		secretEnc, credentialID)
	return err
}

// CredentialSecret returns one credential row's secret envelope, so a writer
// can merge into the CURRENT state instead of overwriting a stale snapshot
// (the same rule UpdateProviderCredentials documents for the legacy blob).
func (s *Store) CredentialSecret(ctx context.Context, credentialID string) (string, error) {
	var enc string
	err := s.pool.QueryRow(ctx,
		`select secret_enc from credential where id = $1`, credentialID).Scan(&enc)
	return enc, err
}

// UpdateCredentialState records the outcome a credential just produced, so the
// candidate query can skip a credential that is cooling down or dead
// (spec §4 status vocabulary).
func (s *Store) UpdateCredentialState(ctx context.Context, credentialID, status string, cooldownUntil *time.Time) error {
	_, err := s.pool.Exec(ctx, `
		update credential
		set status = $2,
		    cooldown_until = $3,
		    last_error_at = case when $2 in ('auth_failed','invalid','rate_limited','cooldown')
		                         then now() else last_error_at end,
		    updated_at = now()
		where id = $1`, credentialID, status, cooldownUntil)
	return err
}
