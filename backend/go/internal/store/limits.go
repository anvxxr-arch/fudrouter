package store

import (
	"context"
	"encoding/json"
	"time"
)

// Limits is the effective per-request limit set (spec §7).
//
// Effective limit = MINIMUM across platform hard limit → account → api_key:
// a specific level may tighten, never exceed the platform hard limit kept in
// `system_setting['platform_hard_limits']`. A nil pointer means "no limit at
// this level" and does not constrain the min.
type Limits struct {
	RPM               *int64
	TPM               *int64
	RPD               *int64
	TPD               *int64
	Concurrency       *int64
	DailySpendMicro   *int64
	MonthlySpendMicro *int64

	// UserRPM / UserConcurrency are the ACCOUNT-level values: the free-tier
	// default and any `rate_limit` scope='account' row, already clamped by the
	// platform ceiling. They are enforced on USER-scoped counters so the free
	// budget is per account, not per key — a user with four keys gets 75 rpm
	// TOTAL, not four times.
	UserRPM         *int64
	UserConcurrency *int64

	// KeyRPM / KeyConcurrency are the key's OWN policy values (api_key.policy):
	// the only limits that are supposed to be counted per key.
	KeyRPM         *int64
	KeyConcurrency *int64
}

// The free-tier admission bounds. There is no payment gateway yet, so every
// active account may spend (balance thresholds do not gate; see proxy/budget.go)
// under these two caps, enforced at user scope. They are FALLBACKS: a
// `rate_limit` scope='account' row replaces them, and an api_key policy may
// tighten below them. When billing goes live these stay — they are the floor a
// paid tier outgrows by getting its own account row.
const (
	FreeTierRPMPerAccount         = int64(75)
	FreeTierConcurrencyPerAccount = int64(3)
)

// FreeAccessNoPaymentGateway: the balance gate (admission + low-balance
// alerts) is disabled until a payment gateway exists. Balance keeps moving in
// the ledger exactly as before, so the reconciliation and revenue numbers a
// paid tier will invoice against are real; only the ENFORCEMENT rests. Flip it
// to false and every gate comes back without further changes — see
// proxy/budget.go (admission) and proxy/lifecycle.go (alerts).
//
// A var, not a const, because the spec §10 tests pin the gated behaviour: they
// set it false for the gate's duration and restore the ship default deferred
// (budget_gate_test.go, admission_cache_test.go). Production always boots with
// the value below; the payment-gateway cutover is editing this line.
var FreeAccessNoPaymentGateway = true

// minInto folds a level's value into the running minimum.
func minInto(dst **int64, v *int64) {
	if v == nil {
		return
	}
	if *dst == nil || *v < **dst {
		*dst = v
	}
}

// EffectiveLimits resolves the chain for one key in ONE round trip of the
// `rate_limit` table plus the platform setting.
func (s *Store) EffectiveLimits(ctx context.Context, k *APIKeyRow) (*Limits, error) {
	lim := &Limits{}

	// Platform hard limits: system_setting['platform_hard_limits'] =
	// {"rpm":…,"tpm":…,"concurrency":…} (0007 seed). Every level below is
	// clamped by these. Cached in-process with a 60s TTL — the row changes
	// only via operator edit, so the skew is bounded by the TTL and no
	// invalidation channel is needed.
	//
	// The ceiling is also returned raw (hardRPM/hardConc): the user-scoped
	// free-tier counter is clamped by it too, and folding it only into the
	// effective min would lose that (the account/default value that the user
	// counter needs is often ABOVE the ceiling's job — the ceiling exists to
	// cap the account value, not to be the account value).
	s.hardLimitsMu.RLock()
	cached, exp := s.hardLimits, s.hardLimitsExp
	s.hardLimitsMu.RUnlock()
	var hardRPM, hardConc *int64
	if time.Now().Before(exp) {
		minInto(&lim.RPM, cached.RPM)
		minInto(&lim.TPM, cached.TPM)
		minInto(&lim.Concurrency, cached.Concurrency)
		hardRPM, hardConc = cached.RPM, cached.Concurrency
	} else {
		var raw []byte
		err := s.pool.QueryRow(ctx,
			`select value from system_setting where key = 'platform_hard_limits'`).Scan(&raw)
		if err == nil {
			var hard struct {
				RPM         *int64 `json:"rpm"`
				TPM         *int64 `json:"tpm"`
				Concurrency *int64 `json:"concurrency"`
			}
			if json.Unmarshal(raw, &hard) == nil {
				s.hardLimitsMu.Lock()
				s.hardLimits = hardLimitCache{RPM: hard.RPM, TPM: hard.TPM, Concurrency: hard.Concurrency}
				s.hardLimitsExp = time.Now().Add(60 * time.Second)
				s.hardLimitsMu.Unlock()
				minInto(&lim.RPM, hard.RPM)
				minInto(&lim.TPM, hard.TPM)
				minInto(&lim.Concurrency, hard.Concurrency)
				hardRPM, hardConc = hard.RPM, hard.Concurrency
			}
		}
	}

	// Scope rows, ordered from least to most specific so the running minimum
	// can be folded in one pass. The account scope replaced the three hierarchy
	// scopes in migration 0019; `account` rows are keyed by user id.
	//
	// The account values are also kept SEPARATELY (acctRPM/acctConc): they are
	// what the user-scoped counters enforce, because an `account` scope speaks
	// for the user across every key they own.
	var acctRPM, acctConc *int64
	rows, err := s.pool.Query(ctx, `
		select scope, rpm, tpm, rpd, tpd, concurrency, daily_spend_micro, monthly_spend_micro
		from rate_limit
		where (scope = 'account' and scope_id = $1)
		   or (scope = 'api_key' and scope_id = $2)`,
		k.UserID, k.ID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var scope string
		var rpm, rpd, concurrency *int64
		var tpm, tpd, daily, monthly *int64
		if err := rows.Scan(&scope, &rpm, &tpm, &rpd, &tpd, &concurrency, &daily, &monthly); err != nil {
			rows.Close()
			return nil, err
		}
		if scope == "account" {
			acctRPM = minPtr(acctRPM, rpm)
			acctConc = minPtr(acctConc, concurrency)
		}
		minInto(&lim.RPM, rpm)
		minInto(&lim.TPM, tpm)
		minInto(&lim.RPD, rpd)
		minInto(&lim.TPD, tpd)
		minInto(&lim.Concurrency, concurrency)
		minInto(&lim.DailySpendMicro, daily)
		minInto(&lim.MonthlySpendMicro, monthly)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	// The key policy is the most specific level (spec §3): it may only tighten.
	// Its own values are also carried raw (KeyRPM/KeyConcurrency): they are the
	// only limits counted PER KEY, everything account-level counts per user.
	lim.KeyRPM = int64Ptr(k.Policy.RPM)
	lim.KeyConcurrency = int64Ptr(k.Policy.Concurrency)
	minInto(&lim.RPM, lim.KeyRPM)
	minInto(&lim.TPM, k.Policy.TPM)
	minInto(&lim.Concurrency, lim.KeyConcurrency)
	minInto(&lim.DailySpendMicro, k.Policy.DailySpendMicro)
	minInto(&lim.MonthlySpendMicro, k.Policy.MonthlySpendMicro)

	// User-scoped rpm/concurrency = account row, else the free-tier default,
	// clamped by the platform ceiling (the ceiling is global, so it binds the
	// user counter too). If the key's policy is TIGHTER than the account value,
	// the per-key counter and this one both run: the user total still respects
	// the account bound while each key stays under its own.
	if acctRPM == nil {
		acctRPM = ptr64(FreeTierRPMPerAccount)
	}
	if acctConc == nil {
		acctConc = ptr64(FreeTierConcurrencyPerAccount)
	}
	lim.UserRPM = minPtr(acctRPM, hardRPM)
	lim.UserConcurrency = minPtr(acctConc, hardConc)
	return lim, nil
}

// minPtr returns the smaller of two optional values; nils never constrain.
func minPtr(a, b *int64) *int64 {
	switch {
	case a == nil:
		return b
	case b == nil:
		return a
	case *a < *b:
		return a
	default:
		return b
	}
}

func ptr64(v int64) *int64 { return &v }

func int64Ptr(v *int) *int64 {
	if v == nil {
		return nil
	}
	n := int64(*v)
	return &n
}

// Budget is a scoped spend budget with its threshold actions (spec §7).
type Budget struct {
	ID                string
	Scope             string // account|api_key
	ScopeID           string
	Period            string // daily|weekly|monthly
	AmountMicro       int64
	WarnPercent       int
	CriticalPercent   int
	ActionAt100       string // notify|restrict|block
}

// PeriodStart converts a budget period into the timestamp its spend is counted
// from (UTC buckets, matching request_log's month/day truncation).
func (b *Budget) PeriodStart(now time.Time) time.Time {
	now = now.UTC()
	switch b.Period {
	case "daily":
		return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	case "weekly":
		weekday := (int(now.Weekday()) + 6) % 7 // Monday = 0
		return time.Date(now.Year(), now.Month(), now.Day()-weekday, 0, 0, 0, 0, time.UTC)
	default: // monthly
		return time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	}
}

// BudgetsFor returns the account budget and the key's own budget, most specific
// last. Both apply (spec §7: the chain is conjunctive — the tightest wins).
func (s *Store) BudgetsFor(ctx context.Context, k *APIKeyRow) ([]Budget, error) {
	rows, err := s.pool.Query(ctx, `
		select id, scope, scope_id, period, amount_micro,
		       warn_percent, critical_percent, action_at_100
		from budget
		where (scope = 'account' and scope_id = $1)
		   or (scope = 'api_key' and scope_id = $2)
		order by scope, period`, k.UserID, k.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Budget
	for rows.Next() {
		var b Budget
		if err := rows.Scan(&b.ID, &b.Scope, &b.ScopeID, &b.Period, &b.AmountMicro,
			&b.WarnPercent, &b.CriticalPercent, &b.ActionAt100); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// The environment's flat monthly budget column had no reader left once
// migration 0019 dropped `environment`: BudgetGateState used to carry it inside
// the account query, and this function was already noted as dead. It went with
// the table rather than living on as a query against a dropped table.

