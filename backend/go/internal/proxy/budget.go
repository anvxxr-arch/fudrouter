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

// checkBudgets gates admission on every budget in the account's chain plus the
// account billing hard stop.
//
// The free-access flip lives in store (FreeAccessNoPaymentGateway): there is no
// payment gateway yet, so the balance check below would refuse every account
// the moment its (never-top-up-able) balance hit the hard stop. While it holds,
// the BALANCE check is skipped and every active account spends freely under its
// rate limits — usage is still metered and charged to the ledger, so the
// numbers a paid tier will invoice against already exist. The STATUS check
// stays: suspend still cuts a user off.
//
// Since B0 the balance gate is subscription-aware (inv#2 / S2), and only once
// the payment-gateway flip turns the balance gate on. The entitlement gate runs
// FIRST and classifies the account's subscription:
//
//	live   → skip the hard stop (a time-window the member already paid for)
//	expired → refuse with the "expired" rule, distinct from a hard stop
//	never  → fall through to `balance > hard_stop_threshold` (inv#2's "OR")
//
// While the flip is OFF (the ship default) the entitlement gate is skipped
// entirely, so an frpayg/frcheap account — subscribed or not — behaves exactly
// as it did before B0: metered, never refused on balance.
func (h *Handler) checkBudgets(ctx context.Context, lc *lifecycle) error {
	// B0 (inv#2 / S2): resolve the subscription BEFORE the balance gate. This
	// runs only while the balance gate is live (FreeAccessNoPaymentGateway =
	// false) — before the flip it would be dead work, and refusing an expired
	// window before the flip would ADD a refusal the dormant-balance frpayg
	// path does not have. A LIVE subscription (the "live OR balance >
	// threshold" first arm) is what the B4 flip must not self-lockout; a
	// lapsed window refuses with the rule-12 "expired" rule.
	live := false
	if !store.FreeAccessNoPaymentGateway {
		var err error
		live, err = h.checkSubscription(ctx, lc)
		if err != nil {
			return err
		}
	}

	// The billing hard stop (spec §10), read through the in-process cache: it
	// was 525µs of the hot path — Postgres round-trip latency, paid per request
	// — against single-digit microseconds for everything around it. The account
	// carries the balance, so its entry is short-lived and the charge path drops
	// it the moment the hard stop is crossed; see store/admission.go.
	//
	// The account read keeps its fail-CLOSED behaviour: an error here refuses
	// the request rather than admitting unbounded spend (spec §10). That was
	// already true when it was the first statement of this function, and the
	// cache never stores an error.
	//
	// The environment's flat monthly budget column used to ride this read; it
	// went with the `environment` table in migration 0019.
	acct, err := h.store.AdmissionGateState(ctx, lc.key.UserID)
	if err != nil {
		return err
	}
	if acct != nil {
		if acct.Status != "active" {
			return store.ErrInsufficientCredits
		}
		// Free access: no payment gateway, so a balance is a meter, not a
		// wallet — nothing tops it up, and the hardcoded hard stop would block
		// every user the instant it was crossed. Metering continues below.
		//
		// `!live` is the B0 term: a live subscription skips the hard stop even
		// at zero balance (inv#2), while every non-live account gates on it
		// exactly as before.
		if !live && !store.FreeAccessNoPaymentGateway && acct.BalanceMicro <= acct.HardStopThresholdMicro {
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

	// frsubs rolling quota (economic layer F5): the fair-use stop-loss on the
	// flat-fee subscription bucket. It runs AFTER the account status/balance and
	// the workspace budgets, so a suspension or a hard stop still wins, and it
	// is checked BEFORE the request is admitted. Only a frsubs key pays any of
	// this; every other bucket returns at the top of checkFrsubsQuota.
	if err := h.checkFrsubsQuota(ctx, lc); err != nil {
		return err
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
	ttls := make([]time.Duration, 0, 4)
	// One TTL per key: the day buckets age out in 25h, the month buckets in 32d.
	// A shared TTL would either expire today's counter early or keep a day bucket
	// alive for a month, and the day/month pair is read separately.
	//
	// The three hierarchy scopes collapsed into `account` in migration 0019, so
	// this writes two counters per period instead of six.
	for _, pair := range [][2]string{
		{"account", lc.key.UserID},
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

	alertID, err := h.store.FindOrCreateAlert(ctx, lc.key.UserID,
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
	if err := h.store.InsertSystemEvent(ctx, kind, b.Scope, b.ScopeID, map[string]any{
		"percent": percent, "used_micro": used, "amount_micro": b.AmountMicro,
		"budget_id": b.ID, "period": b.Period,
	}); err != nil {
		log.Printf("[proxy] system_event insert failed: %v", err)
	}
}

// raiseLowBalance fires the account's low-balance alert (spec §10, PRD §129)
// when a charge crosses the warning or hard-stop threshold. The alert row shape
// is agreed with the billing control plane: {"type":"low_balance",
// "threshold_micro":…, "hard_stop_threshold_micro":…}.
func (h *Handler) raiseLowBalance(ctx context.Context, res *store.ChargeResult, accountID string) {
	if accountID == "" || (!res.Warning && !res.HardStop) {
		return
	}
	b, err := h.store.BillingAccountByUser(ctx, accountID)
	if err != nil {
		return
	}
	alertID, err := h.store.FindOrCreateAlert(ctx, accountID, "Low balance", "low_balance",
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
	_ = h.store.InsertSystemEvent(ctx, kind, "account", accountID, map[string]any{
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

// errQuotaExceeded is the frsubs fair-use rejection (402). It is a distinct
// sentinel from errBudgetBlocked so the two stop-losses stay observable apart,
// even though both surface as INSUFFICIENT_CREDITS to the client (begin maps
// any checkBudgets error to 402).
var errQuotaExceeded = errors.New("quota exceeded for this bucket")

// checkFrsubsQuota gates admission on the frsubs rolling quota windows (5h and
// 7d). It resolves the effective bucket once, and only a frsubs key pays any of
// this — every other bucket returns nil immediately, so the PAYG/cheap hot path
// is untouched.
//
// The counter is Valkey period-keyed, in micro-USD: the adder (finish, via
// quotaSpendAdd) and this reader spell the SAME key
// `quota:frsubs:{userID}:{window}:{periodKey}` or every write silently misses
// every read and the durable sum pays a Postgres round trip per request (the H4
// lesson from budgetSpent/budgetSpendAdd, restated for the quota counters).
//
// Fail mode is CLOSED, deliberately unlike limits.allowTokens (which degrades
// to in-process on a Valkey outage): a counter miss falls back to the durable
// SpendQuotaMicro sum, and a DB error refuses the request. This gate bounds
// SPEND, not rate — opening it on an error would let a DB outage turn a
// flat-fee frsubs key into an unboundedly-billed meter, which is the arbitrage
// the quota exists to stop.
func (h *Handler) checkFrsubsQuota(ctx context.Context, lc *lifecycle) error {
	bucket := lc.resolveBucket()
	if bucket != store.BucketSubs {
		return nil
	}
	if lc.key == nil {
		return nil
	}
	limits, err := h.store.QuotaLimits(ctx, bucket)
	if err != nil {
		log.Printf("[proxy] quota limits lookup failed for %s: %v", lc.key.UserID, err)
		return err
	}
	if len(limits) == 0 {
		return nil // no configured window = no gate
	}
	for window, limit := range limits {
		if limit <= 0 {
			continue
		}
		used, err := h.quotaSpent(ctx, lc.key.UserID, window)
		if err != nil {
			log.Printf("[proxy] quota sum failed for %s/%s: %v", lc.key.UserID, window, err)
			return err
		}
		incoming := lc.quotaIncomingMicro
		if used+incoming > limit {
			log.Printf("[proxy] frsubs quota %s blocked for %s: %d+%d > %d",
				window, lc.key.UserID, used, incoming, limit)
			return errQuotaExceeded
		}
	}
	return nil
}

// quotaSpent returns the micro-USD already used in one frsubs quota window,
// preferring the Valkey counter and falling back to the durable sum. `window` is
// "5h" or "7d" (the schema CHECK vocabulary).
func (h *Handler) quotaSpent(ctx context.Context, userID, window string) (int64, error) {
	periodKey := quotaPeriod(window, time.Now())
	key := "quota:frsubs:" + userID + ":" + window + ":" + periodKey
	var cached int64
	if err := h.vk.GetJSON(ctx, key, &cached, 2*time.Second); err == nil {
		return cached, nil
	}
	// Counter miss (Valkey down, evicted, or the window rolled over): the
	// durable aggregate is authoritative. A DB error propagates so checkFrsubsQuota
	// fails closed.
	return h.store.SpendQuotaMicro(ctx, userID, quotaWindowStart(window, time.Now()))
}

// quotaSpendAdd mirrors this request's frsubs meter into the 5h and 7d counters
// AFTER the charge is durable (see finish). The suite of a 5h window must also
// be counted in the 7d window: 5h holds a subset of any 7d period, so both
// counters move together with the one measured value. It is best-effort around
// the durable sum — a counter miss degrades to SpendQuotaMicro on the next gate,
// never to unbounded spend.
func (h *Handler) quotaSpendAdd(ctx context.Context, lc *lifecycle, micro int64) {
	if micro <= 0 || lc.key == nil || lc.bucket != store.BucketSubs {
		return
	}
	now := time.Now()
	windows := []string{"5h", "7d"}
	keys := make([]string, 0, len(windows))
	ttls := make([]time.Duration, 0, len(windows))
	for _, w := range windows {
		periodKey, ttl := quotaPeriodTTL(w, now)
		keys = append(keys, "quota:frsubs:"+lc.key.UserID+":"+w+":"+periodKey)
		ttls = append(ttls, ttl)
	}
	h.quotaIncr(ctx, keys, ttls, micro)
}

// quotaIncr groups the quota counters by TTL and writes each group in one round
// trip — the same shape as spendIncr for the budget counters.
func (h *Handler) quotaIncr(ctx context.Context, keys []string, ttls []time.Duration, micro int64) {
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
			return // degrade: the durable sum stays authoritative
		}
	}
}

// quotaPeriod returns the period-named KEY for one quota window at `now`. The
// period start is floored per window (5h blocks at 00:00, 05:00, ... UTC; 7d at
// the Monday-aligned boundary), matching quotaWindowStart so the durable sum
// counts the same period the counter would. A stale key from a previous period
// simply MISSES the next period instead of reading old spend as current — the
// same rule budget.go's day/month keys follow.
func quotaPeriod(window string, now time.Time) string {
	key, _ := quotaPeriodTTL(window, now)
	return key
}

// quota5hStart returns the start of the current 5h quota block, anchored to UTC
// midnight (00:00, 05:00, 10:00, 15:00, 20:00 UTC).
//
// The one-liner it replaces — now.Truncate(5 * time.Hour) — was WRONG for this
// contract. time.Time.Truncate floors against the zero time (0001-01-01
// 00:00:00 UTC), not against the calendar day, and a day is 24h = 4*5h + 4h, so
// "5h blocks floored since zero time" DRIFT against wall-clock midnight by 4h
// per day. Measured across 2026-11-09..13 the block starts were
// 22:00/03:00/08:00/13:00/18:00, then 23:00/04:00/09:00/14:00/19:00, and so on
// — never the documented 00:00/05:00. A quota whose "5h" window silently resets
// at a different wall clock each day both breaks the documented fair-use window
// and, because the key is the period start, changes what spend a given block
// counts once the boundary crosses the operators' own 00:00/05:00 mental model.
//
// Anchoring to UTC midnight keeps every block at a fixed wall clock, so
// "5h from 00:00" means the same thing every day. The last block (20:00) runs
// 20:00–01:00(+1d) to cover a full day, but its key is 20:00's timestamp and
// the next day restarts at 00:00 — the same boundary the counter TTL (6h)
// outlives so a finished block's key expires after its named period.
func quota5hStart(now time.Time) time.Time {
	now = now.UTC()
	day := now.Truncate(24 * time.Hour) // UTC midnight
	block := now.Hour() / 5             // 0..4 → 00,05,10,15,20
	return day.Add(time.Duration(block) * 5 * time.Hour)
}

// quotaPeriodTTL returns the period-named key AND its TTL for one quota window.
// The TTL outlives the named period with headroom (Δ): 5h+1h, 7d+1d.
func quotaPeriodTTL(window string, now time.Time) (periodKey string, ttl time.Duration) {
	now = now.UTC()
	switch window {
	case "5h":
		return quota5hStart(now).Format("200601021504"), 6 * time.Hour
	default: // "7d"
		day := now.Truncate(24 * time.Hour)
		// Align to Monday (Go's Weekday: Sunday=0..Saturday=6; Monday=1).
		offset := (int(day.Weekday()) + 6) % 7
		weekStart := day.AddDate(0, 0, -offset)
		return weekStart.Format("20060102"), 8 * 24 * time.Hour
	}
}

// quotaWindowStart returns the start of the current period for one quota window,
// matching the flooring in quotaPeriodTTL so the durable sum over [start, now]
// counts the same period the counter would.
func quotaWindowStart(window string, now time.Time) time.Time {
	now = now.UTC()
	switch window {
	case "5h":
		return quota5hStart(now)
	default: // "7d"
		day := now.Truncate(24 * time.Hour)
		offset := (int(day.Weekday()) + 6) % 7
		return day.AddDate(0, 0, -offset)
	}
}
