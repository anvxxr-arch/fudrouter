// Package store is the data plane's only database access.
//
// The schema is `infra/migrations/0006_platform_schema.sql` +
// `0007_platform_backfill.sql` (literal source of truth:
// docs/specs/2026-09-30-platform-schema.md §3–§10). Legacy S0 columns
// (`provider.base_url`, `provider.credentials_enc`, `api_key.limits`,
// `request_log.tokens_in/tokens_out/cost`) still exist and are still written and
// read here until migration 0009 drops them — the compatibility promises in
// spec §14 depend on it.
package store

import (
	"context"
	"errors"
	"os"
	"strings"
	"time"

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
}

func New(ctx context.Context, dsn string) (*Store, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	return &Store{pool: pool, allowDevProviders: envBool("ROUTER_ALLOW_DEV_PROVIDERS")}, nil
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
