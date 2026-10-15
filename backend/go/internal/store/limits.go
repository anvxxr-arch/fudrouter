package store

import (
	"context"
	"encoding/json"
	"time"
)

// Limits is the effective per-request limit set (spec §7).
//
// Effective limit = MINIMUM across the chain platform hard limit → workspace →
// project → environment → api_key: a specific level may tighten, never exceed
// the platform hard limit kept in `system_setting['platform_hard_limits']`.
// A nil pointer means "no limit at this level" and does not constrain the min.
type Limits struct {
	RPM               *int64
	TPM               *int64
	RPD               *int64
	TPD               *int64
	Concurrency       *int64
	DailySpendMicro   *int64
	MonthlySpendMicro *int64
}

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
	s.hardLimitsMu.RLock()
	cached, exp := s.hardLimits, s.hardLimitsExp
	s.hardLimitsMu.RUnlock()
	if time.Now().Before(exp) {
		minInto(&lim.RPM, cached.RPM)
		minInto(&lim.TPM, cached.TPM)
		minInto(&lim.Concurrency, cached.Concurrency)
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
			}
		}
	}

	// Scope rows, ordered from least to most specific so the running minimum
	// can be folded in one pass.
	rows, err := s.pool.Query(ctx, `
		select scope, rpm, tpm, rpd, tpd, concurrency, daily_spend_micro, monthly_spend_micro
		from rate_limit
		where (scope = 'workspace'   and scope_id = $1)
		   or (scope = 'project'     and scope_id = $2)
		   or (scope = 'environment' and scope_id = $3)
		   or (scope = 'api_key'     and scope_id = $4)`,
		k.WorkspaceID, k.ProjectID, k.EnvironmentID, k.ID)
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
	minInto(&lim.RPM, int64Ptr(k.Policy.RPM))
	minInto(&lim.TPM, k.Policy.TPM)
	minInto(&lim.Concurrency, int64Ptr(k.Policy.Concurrency))
	minInto(&lim.DailySpendMicro, k.Policy.DailySpendMicro)
	minInto(&lim.MonthlySpendMicro, k.Policy.MonthlySpendMicro)
	return lim, nil
}

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
	Scope             string // workspace|project|environment
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

// BudgetsFor returns every budget in the key's ownership chain, most specific
// last. All of them apply (spec §7: the chain is conjunctive — the tightest
// budget wins).
func (s *Store) BudgetsFor(ctx context.Context, k *APIKeyRow) ([]Budget, error) {
	rows, err := s.pool.Query(ctx, `
		select id, scope, scope_id, period, amount_micro,
		       warn_percent, critical_percent, action_at_100
		from budget
		where (scope = 'workspace'   and scope_id = $1)
		   or (scope = 'project'     and scope_id = $2)
		   or (scope = 'environment' and scope_id = $3)
		order by scope, period`, k.WorkspaceID, k.ProjectID, k.EnvironmentID)
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

// EnvironmentMonthlyBudgetMicro is the environment's flat monthly budget column
// (spec §2 `environment.monthly_budget_micro`), which predates the `budget`
// table and is honoured as a monthly budget with default thresholds.
//
// NO LONGER CALLED by the budget gate: BudgetGateState carries this value in
// the same query as the billing account it already had to read, which removed a
// round trip from every request's admission path (BENCH: 2699 → 2416 ns/op
// mean, one fewer query). Kept because it is the only reader of the column
// outside the control plane and the admin surfaces still expect it to exist;
// delete it with the next caller audit, not silently.
func (s *Store) EnvironmentMonthlyBudgetMicro(ctx context.Context, environmentID string) (int64, bool, error) {
	if environmentID == "" {
		return 0, false, nil
	}
	var amount *int64
	err := s.pool.QueryRow(ctx,
		`select monthly_budget_micro from environment where id = $1`, environmentID,
	).Scan(&amount)
	if err != nil || amount == nil {
		return 0, false, err
	}
	return *amount, true, nil
}
