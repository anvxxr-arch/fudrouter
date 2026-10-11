package proxy

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
)

// Budget enforcement (spec §7, §10; PRD §40, §129).
//
// Three layers, one direction of failure:
//
//   - the Valkey spend counter is the fast path (spend:{scope}:{id}:day|month);
//   - the DB sum is authoritative when the counter is missing (spec §7: counter
//     loss must never make spending unbounded);
//   - the workspace billing account's hard stop (spec §10) rejects with
//     402 INSUFFICIENT_CREDITS at admission.
//
// Threshold crossings raise alert_event + system_event (70% / 90% / 100%); only
// `action_at_100 = 'block'` refuses the request. `notify` and `restrict` let it
// through and let the alert tell the story.

// checkBudgets gates admission on every budget in the key's chain plus the
// workspace billing account's hard stop.
func (h *Handler) checkBudgets(ctx context.Context, lc *lifecycle) error {
	// The billing hard stop (spec §10): at/under hard_stop_threshold_micro the
	// router rejects with normalized INSUFFICIENT_CREDITS (HTTP 402).
	if err := h.store.CheckSpendable(ctx, lc.key.WorkspaceID); err != nil {
		return err
	}

	budgets, err := h.store.BudgetsFor(ctx, lc.key)
	if err != nil {
		log.Printf("[proxy] budget lookup failed for key %s: %v", lc.key.ID, err)
		return nil // fail open: a budget read error is not a billing error
	}
	for i := range budgets {
		b := budgets[i]
		used, err := h.budgetSpent(ctx, lc, &b)
		if err != nil {
			log.Printf("[proxy] budget sum failed for %s/%s: %v", b.Scope, b.ScopeID, err)
			continue
		}
		h.budgetEvaluate(ctx, lc, &b, used)
		if used >= b.AmountMicro && b.ActionAt100 == "block" {
			return errBudgetBlocked
		}
	}

	// The environment's flat monthly_budget_micro column (spec §2) is honoured
	// as a monthly budget with default thresholds.
	if amount, ok, err := h.store.EnvironmentMonthlyBudgetMicro(ctx, lc.key.EnvironmentID); err == nil && ok {
		used, err := h.sinceMicro(ctx, lc, "environment", lc.key.EnvironmentID, monthStart())
		if err == nil {
			b := &store.Budget{Scope: "environment", ScopeID: lc.key.EnvironmentID,
				Period: "monthly", AmountMicro: amount, WarnPercent: 70, CriticalPercent: 90,
				ActionAt100: "block"}
			h.budgetEvaluate(ctx, lc, b, used)
			if used >= amount {
				return errBudgetBlocked
			}
		}
	}
	return nil
}

var errBudgetBlocked = errors.New("budget exhausted for this scope")

// budgetSpent returns the spend against one budget for its period, preferring
// the Valkey counter and falling back to the durable sum.
func (h *Handler) budgetSpent(ctx context.Context, lc *lifecycle, b *store.Budget) (int64, error) {
	period := "day"
	if b.Period != "daily" {
		period = "month"
	}
	var cached int64
	key := "spend:" + b.Scope + ":" + b.ScopeID + ":" + period
	if err := h.vk.GetJSON(ctx, key, &cached, 2*time.Second); err == nil {
		return cached, nil
	}
	return h.sinceMicro(ctx, lc, b.Scope, b.ScopeID, b.PeriodStart(time.Now()))
}

// sinceMicro is the durable aggregate (store.SpendMicro): the authoritative
// number a missing counter falls back to.
func (h *Handler) sinceMicro(ctx context.Context, lc *lifecycle, scope, scopeID string, since time.Time) (int64, error) {
	return lc.h.store.SpendMicro(ctx, scope, scopeID, since)
}

// budgetSpendAdd mirrors completed spend into the counters for the scopes a
// request belongs to (workspace, project, environment).
func (h *Handler) budgetSpendAdd(ctx context.Context, lc *lifecycle, micro int64) {
	if micro == 0 || lc.key == nil {
		return
	}
	for _, pair := range [][2]string{
		{"workspace", lc.key.WorkspaceID},
		{"project", lc.key.ProjectID},
		{"environment", lc.key.EnvironmentID},
	} {
		if pair[1] == "" {
			continue
		}
		for _, period := range []string{"day", "month"} {
			key := "spend:" + pair[0] + ":" + pair[1] + ":" + period
			_, err := h.vk.Lua(ctx, `
				local v = redis.call('INCRBY', KEYS[1], ARGV[1])
				if v == ARGV[1] then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
				return v`, key, micro, ttlMs(period))
			if err != nil {
				return // degrade: the DB sum stays authoritative
			}
		}
	}
}

func ttlMs(period string) int64 {
	if period == "day" {
		return int64((25 * time.Hour).Milliseconds())
	}
	return int64((32 * 24 * time.Hour).Milliseconds())
}

func monthStart() time.Time {
	now := time.Now().UTC()
	return time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
}

// budgetEvaluate raises the threshold alerts (spec §7: 70%/90% → alert_event +
// system_event; 100% is the caller's rejection decision).
func (h *Handler) budgetEvaluate(ctx context.Context, lc *lifecycle, b *store.Budget, used int64) {
	if b.AmountMicro <= 0 {
		return
	}
	percent := int64(100)
	if b.AmountMicro > 0 {
		percent = used * 100 / b.AmountMicro
	}
	warnAt := int64(b.WarnPercent)
	if warnAt <= 0 {
		warnAt = 70
	}
	critAt := int64(b.CriticalPercent)
	if critAt <= 0 {
		critAt = 90
	}

	var fire int64 // 0 = none, 70 = warn, 90 = critical
	switch {
	case percent >= critAt:
		fire = critAt
	case percent >= warnAt:
		fire = warnAt
	default:
		return
	}

	alertID, err := h.store.FindOrCreateAlert(ctx, lc.key.WorkspaceID,
		"Budget "+b.Period+" threshold", "budget",
		map[string]any{
			"type":           "budget",
			"threshold":      fire,
			"window_seconds": 0,
			"scope":          b.Scope,
			"scope_id":       b.ScopeID,
			"period":         b.Period,
		})
	if err != nil {
		log.Printf("[proxy] budget alert lookup failed: %v", err)
		return
	}
	// One alert_event per threshold crossing per period, not per request.
	if recent, err := h.store.RecentAlertFiring(ctx, alertID, alertRepeatWindow(fire)); err == nil && recent {
		return
	}
	kind := "budget.warning"
	if fire >= critAt {
		kind = "budget.critical"
	}
	if err := h.store.InsertAlertEvent(ctx, alertID,
		"budget "+b.Period+" for "+b.Scope+" is at "+itoaPct(percent)+"% ("+itoaInt(used)+"/"+itoaInt(b.AmountMicro)+" micro)",
		"firing", float64(used)); err != nil {
		log.Printf("[proxy] alert_event insert failed: %v", err)
	}
	if err := h.store.InsertSystemEvent(ctx, kind, b.Scope, b.ScopeID, lc.key.WorkspaceID, map[string]any{
		"percent": percent, "used_micro": used, "amount_micro": b.AmountMicro,
		"budget_id": b.ID, "period": b.Period,
	}); err != nil {
		log.Printf("[proxy] system_event insert failed: %v", err)
	}
}

// raiseLowBalance fires the workspace's low-balance alert (spec §10, PRD §129)
// when a charge crosses the warning or hard-stop threshold. The alert row shape
// is agreed with the billing control plane: {"type":"low_balance",
// "threshold_micro":…, "hard_stop_threshold_micro":…}.
func (h *Handler) raiseLowBalance(ctx context.Context, res *store.ChargeResult, workspaceID string) {
	if workspaceID == "" || (!res.Warning && !res.HardStop) {
		return
	}
	b, err := h.store.BillingAccountByWorkspace(ctx, workspaceID)
	if err != nil {
		return
	}
	alertID, err := h.store.FindOrCreateAlert(ctx, workspaceID, "Low balance", "low_balance",
		map[string]any{
			"type":                         "low_balance",
			"threshold_micro":              b.WarningThresholdMicro,
			"hard_stop_threshold_micro":    b.HardStopThresholdMicro,
		})
	if err != nil {
		log.Printf("[proxy] low-balance alert lookup failed: %v", err)
		return
	}
	// One alert per crossing: the warning repeats once per hour at most, the
	// hard stop per 6 hours, so a flood of requests cannot flood the inbox.
	window := time.Hour
	if res.HardStop {
		window = 6 * time.Hour
	}
	if recent, err := h.store.RecentAlertFiring(ctx, alertID, window); err == nil && recent {
		return
	}
	state := "firing"
	msg := "balance " + itoaInt(res.BalanceMicro) + " micro is below the warning threshold " +
		itoaInt(b.WarningThresholdMicro) + " micro"
	if res.HardStop {
		msg = "balance " + itoaInt(res.BalanceMicro) + " micro is at or below the hard stop " +
			itoaInt(b.HardStopThresholdMicro) + " micro — requests are being rejected"
	}
	if err := h.store.InsertAlertEvent(ctx, alertID, msg, state, float64(res.BalanceMicro)); err != nil {
		log.Printf("[proxy] low-balance alert_event insert failed: %v", err)
	}
	kind := "budget.low_balance"
	if res.HardStop {
		kind = "budget.hard_stop"
	}
	_ = h.store.InsertSystemEvent(ctx, kind, "workspace", workspaceID, workspaceID, map[string]any{
		"balance_micro": res.BalanceMicro,
		"warning_threshold_micro": b.WarningThresholdMicro,
		"hard_stop_threshold_micro": b.HardStopThresholdMicro,
	})
}

// alertRepeatWindow is the quiet period between repeated budget alerts at a
// threshold: a crossing is an event, not a per-request log.
func alertRepeatWindow(threshold int64) time.Duration {
	if threshold >= 90 {
		return 30 * time.Minute
	}
	return time.Hour
}

func itoaInt(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func itoaPct(n int64) string { return itoaInt(n) }
