package proxy

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/vk"
)

// Budget enforcement (spec §7, §10; PRD §40, §129).
//
// Three layers, one direction of failure:
//
//   - the Valkey spend counter is the fast path
//     (spend:{scope}:{id}:{day|month}:{period start});
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
	// ONE query for the billing hard stop (spec §10) AND the environment's flat
	// monthly budget (spec §2): two reads that used to be two round trips for
	// two rows that never interact. Both are needed on every request, so this
	// is the common-case path a workspace with no `budget` rows pays.
	//
	// The read is CACHED in-process (store.AdmissionGateState): it was 525µs of
	// the hot path — Postgres round-trip latency, paid per request — against
	// single-digit microseconds for everything around it. The account carries
	// the balance, so its entry is short-lived and the charge path drops it the
	// moment the hard stop is crossed; see store/admission.go.
	//
	// The account read keeps its fail-CLOSED behaviour: an error here refuses
	// the request rather than admitting unbounded spend (spec §10). That was
	// already true when it was the first statement of this function, and the
	// cache never stores an error.
	acct, envBudget, err := h.store.AdmissionGateState(ctx, lc.key.WorkspaceID, lc.key.EnvironmentID)
	if err != nil {
		return err
	}
	if acct != nil {
		if acct.Status != "active" {
			return store.ErrInsufficientCredits
		}
		if acct.BalanceMicro <= acct.HardStopThresholdMicro {
			return store.ErrInsufficientCredits
		}
	}

	// H7: this read fails CLOSED, like the account read above. The asymmetry
	// was the bug: spec §10 (quoted above) says an error here refuses the
	// request rather than admitting unbounded spend, and failing open on
	// exactly the rows that carry the caps would let a DB error bypass every
	// budget the gate exists to enforce.
	budgets, err := h.store.AdmissionBudgets(ctx, lc.key)
	if err != nil {
		log.Printf("[proxy] budget lookup failed for key %s: %v", lc.key.ID, err)
		return err
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
	// as a monthly budget with default thresholds. Its value rode the same
	// query as the account above.
	//
	// The spend read goes through budgetSpent, NOT sinceMicro: the column is
	// nullable and an operator sets it, so before this every request for such an
	// environment paid a Postgres SUM over request_log — the exact round trip
	// admission stopped paying elsewhere — while budgetSpendAdd already maintains
	// the period-named `spend:environment:<id>:month:<yyyymm>` key, which is the
	// key budgetSpent builds here.
	// The error path is the loop's above, not silence: a failed read is logged
	// and the request admitted (fail open, spec §12), the same as a failed
	// budget-row sum.
	if envBudget != nil && *envBudget > 0 {
		b := &store.Budget{Scope: "environment", ScopeID: lc.key.EnvironmentID,
			Period: "monthly", AmountMicro: *envBudget, WarnPercent: 70, CriticalPercent: 90,
			ActionAt100: "block"}
		used, err := h.budgetSpent(ctx, lc, b)
		if err != nil {
			log.Printf("[proxy] env budget sum failed for %s: %v", b.ScopeID, err)
		} else {
			h.budgetEvaluate(ctx, lc, b, used)
			if used >= *envBudget {
				return errBudgetBlocked
			}
		}
	}
	return nil
}

var errBudgetBlocked = errors.New("budget exhausted for this scope")

// budgetSpent returns the spend against one budget for its period, preferring
// the Valkey counter and falling back to the durable sum.
//
// A `weekly` budget goes STRAIGHT to the durable sum. `budgetSpendAdd` mirrors
// day+month counters for each scope, so there is no `week` key to read, and the
// `period` this used to compute for a non-daily budget was `month` — which for a
// weekly row answered month-to-date. The fallback below counts from
// PeriodStart's own Monday boundary, so the two halves of this function
// disagreed by up to a month, and it is the number the block decision uses.
// `weekly` is in the schema's CHECK and in Budget's documented vocabulary,
// while nothing in either plane writes such a row today: this is the one state
// where a stale literal would have been silently wrong, so it pays a Postgres sum
// per request instead of a counter read — correct at the cost of the round trip
// only for the period nothing maintains a counter for.
func (h *Handler) budgetSpent(ctx context.Context, lc *lifecycle, b *store.Budget) (int64, error) {
	period := "day"
	switch b.Period {
	case "daily":
		period = "day"
	case "weekly":
		return h.sinceMicro(ctx, lc, b.Scope, b.ScopeID, b.PeriodStart(time.Now()))
	default:
		period = "month"
	}
	var cached int64
	// H4: the key must name the PERIOD it counts. The old
	// `spend:{scope}:{id}:{day|month}` key had no period, and the day bucket's
	// 25h TTL outlives the UTC day boundary — yesterday's counter was still
	// live this morning and read as today's, producing false 402s until it
	// aged out. Embedding the period start (limits.go:319-328's rule for the
	// token windows) makes a stale key from a previous period simply MISS, so
	// budgetSpent falls back to the durable sum instead of reading it.
	// TTLs stay 25h/32d — they now only need to outlive the NAMED period.
	ps := b.PeriodStart(time.Now())
	periodKey := ps.Format("20060102") // day bucket: 20261019
	if period != "day" {
		periodKey = ps.Format("200601") // month bucket: 202610
	}
	key := "spend:" + b.Scope + ":" + b.ScopeID + ":" + period + ":" + periodKey
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
//
// ONE round trip for all six counters. The per-counter Lua call this replaced
// made every request pay 6 sequential round trips (3 scopes x day/month) after
// the client already had its answer — and it carried the same ARGV comparison bug
// the token windows had, so `if v == ARGV[1]` never armed a TTL and the counters
// could not roll over: a month-to-date total written once stayed authoritative
// forever, which made replacing dozens of rows in `request_log` — the one
// statement this whole change was meant to avoid — the only way to dent it.
func (h *Handler) budgetSpendAdd(ctx context.Context, lc *lifecycle, micro int64) {
	if micro == 0 || lc.key == nil {
		return
	}
	keys := make([]string, 0, 6)
	ttls := make([]time.Duration, 0, 6)
	// One TTL per key: the day buckets age out in 25h, the month buckets in 32d.
	// A shared TTL would either expire today's counter early or keep a day bucket
	// alive for a month, and the day/month pair is read separately.
	for _, pair := range [][2]string{
		{"workspace", lc.key.WorkspaceID},
		{"project", lc.key.ProjectID},
		{"environment", lc.key.EnvironmentID},
	} {
		if pair[1] == "" {
			continue
		}
		// H4 (write side): the same period-named key budgetSpent reads —
		// `spend:{scope}:{id}:{day|month}:{period start}`, so the day bucket
		// written today can never satisfy tomorrow's read (the unperioded key
		// plus the 25h TTL made yesterday's spend read as today's until the
		// TTL aged it out — false 402s). Read and write MUST spell it alike
		// or every write silently misses every read and the durable sum pays
		// a Postgres round trip per request instead.
		day := time.Now().UTC().Format("20060102")
		mon := time.Now().UTC().Format("200601")
		for _, w := range []struct{ suffix, periodKey string }{
			{"day", day},
			{"month", mon},
		} {
			keys = append(keys, "spend:"+pair[0]+":"+pair[1]+":"+w.suffix+":"+w.periodKey)
			ttls = append(ttls, ttlOf(w.suffix))
		}
	}
	if len(keys) == 0 {
		return
	}
	// The script takes one TTL argument, so keys sharing a TTL are written in one
	// call: at most two calls (day, month), never six.
	h.spendIncr(ctx, keys, ttls, micro)
}

// spendIncr groups keys by TTL and writes each group in one round trip.
func (h *Handler) spendIncr(ctx context.Context, keys []string, ttls []time.Duration, micro int64) {
	groups := map[time.Duration][]string{}
	order := make([]time.Duration, 0, 2)
	for i, k := range keys {
		if _, seen := groups[ttls[i]]; !seen {
			order = append(order, ttls[i])
		}
		groups[ttls[i]] = append(groups[ttls[i]], k)
	}
	for _, ttl := range order {
		if _, err := h.vk.IncrByBucket(ctx, groups[ttl], micro, ttl); err != nil &&
			!errors.Is(err, vk.ErrDisabled) {
			return // degrade: the DB sum stays authoritative
		}
	}
}

func ttlOf(period string) time.Duration {
	if period == "day" {
		return 25 * time.Hour
	}
	return 32 * 24 * time.Hour
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
			"type":                      "low_balance",
			"threshold_micro":           b.WarningThresholdMicro,
			"hard_stop_threshold_micro": b.HardStopThresholdMicro,
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
		"balance_micro":             res.BalanceMicro,
		"warning_threshold_micro":   b.WarningThresholdMicro,
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
