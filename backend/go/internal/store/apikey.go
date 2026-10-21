package store

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// KeyPolicy is the per-key policy jsonb (spec §3). Every field is optional:
// a missing field means "inherit" (spec §7) and the effective limit is the
// minimum across the chain (see EffectiveLimits).
//
// The legacy `api_key.limits` jsonb ({rpm, monthly_cost_micro}) is still read
// when the policy leaves a field empty (spec §3 compatibility), because the
// admin console writes both and 0009 cannot drop the column until the last
// writer migrates.
type KeyPolicy struct {
	Endpoints         []string `json:"endpoints"`
	Models            []string `json:"models"`
	Aliases           []string `json:"aliases"`
	IPAllowlist       []string `json:"ip_allowlist"`
	RPM               *int     `json:"rpm"`
	TPM               *int64   `json:"tpm"`
	Concurrency       *int     `json:"concurrency"`
	DailySpendMicro   *int64   `json:"daily_spend_micro"`
	MonthlySpendMicro *int64   `json:"monthly_spend_micro"`
}

// legacyLimits is the S0 `api_key.limits` shape the admin console wrote:
// { rpm, monthly_cost_micro }. Values arrive as JSON strings OR numbers
// depending on which console build wrote them, so they parse leniently: a
// mistyped number must never silently drop a spend cap.
type legacyLimits struct {
	RPM             *flexibleInt   `json:"rpm"`
	MonthlyCostMicro *flexibleInt  `json:"monthly_cost_micro"`
}

// flexibleInt accepts 1, "1" or 1.0 and reports the integer value.
type flexibleInt int64

func (f *flexibleInt) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" || s == "null" {
		return nil
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return err
	}
	*f = flexibleInt(int64(v))
	return nil
}

// APIKeyRow is one authenticated key with its policy and status. The key's
// owner is the user account: the workspace → project → environment chain this
// used to resolve was removed in migration 0019, and `user_id` (NOT NULL since
// 0000) was always the real owner.
type APIKeyRow struct {
	ID      string
	UserID  string
	KeyHash string
	Status  string // active|disabled|revoked (spec §3)
	RevokedAt *time.Time
	ExpiresAt *time.Time
	Policy  KeyPolicy
}

// Auth errors. The proxy maps these to 401 responses with the OpenAI error body
// (PRD §88: AUTHENTICATION_ERROR). An unknown prefix and a wrong secret are
// deliberately the same answer (ErrNotFound) — no key oracle.
var (
	ErrKeyInactive = errors.New("api key is disabled or revoked")
	ErrKeyExpired  = errors.New("api key expired")
)

// LookupAPIKey resolves a key by its public prefix (the secret is verified by
// the caller against KeyHash, byte-compatible with the TS plane).
func (s *Store) LookupAPIKey(ctx context.Context, prefix string) (*APIKeyRow, error) {
	row := &APIKeyRow{}
	var policyJSON, limitsJSON []byte
	// user_id is nullable in S0 (seeded keys carried NULL until 0006's
	// backfill), so scan through *string: a legacy row must not kill auth.
	var userID *string
	err := s.pool.QueryRow(ctx, `
		select k.id, k.user_id, k.key_hash, k.status, k.revoked_at, k.expires_at,
		       k.policy, k.limits
		from api_key k
		where k.prefix = $1`, prefix,
	).Scan(&row.ID, &userID,
		&row.KeyHash, &row.Status, &row.RevokedAt, &row.ExpiresAt,
		&policyJSON, &limitsJSON)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if userID != nil {
		row.UserID = *userID
	}

	if len(policyJSON) > 0 {
		_ = json.Unmarshal(policyJSON, &row.Policy) // a malformed policy is not a key outage
	}
	mergeLegacyLimits(&row.Policy, limitsJSON)

	// Status gate (spec §3): the status column is authoritative once migration
	// 0008 moves the vocabulary; the legacy revoked_at column must keep working
	// for keys written before it existed.
	if row.Status == "disabled" || row.Status == "revoked" {
		return nil, ErrKeyInactive
	}
	if row.RevokedAt != nil {
		return nil, ErrKeyInactive
	}
	if row.ExpiresAt != nil && !row.ExpiresAt.After(time.Now()) {
		return nil, ErrKeyExpired
	}
	return row, nil
}

// mergeLegacyLimits fills policy fields the policy leaves unset from the S0
// `limits` jsonb (spec §3: "{rpm, monthly_cost_micro} → {rpm,
// monthly_spend_micro}"), so a key configured before 0006 keeps its caps.
func mergeLegacyLimits(p *KeyPolicy, limitsJSON []byte) {
	if len(limitsJSON) == 0 {
		return
	}
	var legacy legacyLimits
	if err := json.Unmarshal(limitsJSON, &legacy); err != nil {
		return
	}
	if p.RPM == nil && legacy.RPM != nil {
		rpm := int(*legacy.RPM)
		p.RPM = &rpm
	}
	if p.MonthlySpendMicro == nil && legacy.MonthlyCostMicro != nil {
		spend := int64(*legacy.MonthlyCostMicro)
		p.MonthlySpendMicro = &spend
	}
}
