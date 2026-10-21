package store

import (
	"context"
	"errors"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/ids"
	"github.com/jackc/pgx/v5"
)

// BillingAccount is the user account's prepaid credit account (spec §10).
// Keyed by user since migration 0019 removed the workspace it used to hang off.
type BillingAccount struct {
	ID                      string
	UserID                  string
	Currency                string
	Status                  string
	WarningThresholdMicro   int64
	HardStopThresholdMicro  int64
	BalanceMicro            int64 // cache of SUM(credit_ledger.amount_micro)
}

// ErrInsufficientCredits is returned when an account is at or under its hard
// stop (spec §10). The proxy maps it to HTTP 402 with the normalized
// INSUFFICIENT_CREDITS code (PRD §88).
var ErrInsufficientCredits = errors.New("insufficient credits")

// BillingAccountByUser loads the account for a user. A user with no billing
// account (created outside the control plane) has no credit line: ErrNotFound
// tells the caller to treat spending as unlimited or to refuse, depending on its
// gate. The data plane treats "no account" as "no hard stop" — an account-less
// user is an S0-style tenant, and the S0 promise is that those keep working
// (spec §14).
func (s *Store) BillingAccountByUser(ctx context.Context, userID string) (*BillingAccount, error) {
	if userID == "" {
		return nil, ErrNotFound
	}
	b := &BillingAccount{}
	err := s.pool.QueryRow(ctx, `
		select id, user_id, currency, status,
		       warning_threshold_micro, hard_stop_threshold_micro, balance_micro
		from billing_account where user_id = $1`, userID,
	).Scan(&b.ID, &b.UserID, &b.Currency, &b.Status,
		&b.WarningThresholdMicro, &b.HardStopThresholdMicro, &b.BalanceMicro)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return b, err
}

// BudgetGateState is everything the admission budget gate needs beyond the
// budget rows themselves: the user's billing account (hard stop). The
// environment's flat monthly budget column went with the `environment` table in
// migration 0019.
//
// `acct` is nil when the user has no billing account (the S0 tenant the caller
// must treat as having no hard stop).
//
// The account read keeps its fail-CLOSED behaviour: a query error is returned,
// and the caller refuses (spec §10 — a billing read that cannot be trusted must
// not admit spend).
func (s *Store) BudgetGateState(ctx context.Context, userID string) (*BillingAccount, error) {
	var (
		acct                             *BillingAccount
		id, uid, currency, status        *string
		warnThreshold, hardStop, balance *int64
	)
	err := s.pool.QueryRow(ctx, `
		select ba.id, ba.user_id, ba.currency, ba.status,
		       ba.warning_threshold_micro, ba.hard_stop_threshold_micro, ba.balance_micro
		from (select 1) anchor
		left join billing_account ba on ba.user_id = $1`, userID,
	).Scan(&id, &uid, &currency, &status, &warnThreshold, &hardStop, &balance)
	if err != nil {
		return nil, err
	}
	if id != nil {
		acct = &BillingAccount{ID: *id}
		if uid != nil {
			acct.UserID = *uid
		}
		if currency != nil {
			acct.Currency = *currency
		}
		if status != nil {
			acct.Status = *status
		}
		if warnThreshold != nil {
			acct.WarningThresholdMicro = *warnThreshold
		}
		if hardStop != nil {
			acct.HardStopThresholdMicro = *hardStop
		}
		if balance != nil {
			acct.BalanceMicro = *balance
		}
	}
	return acct, nil
}

// ChargeResult reports what the charge did to the account, so the caller can
// raise low-balance alerts (spec §10: 70%/90% → alert_event + system_event) and
// gate the NEXT request at the hard stop.
type ChargeResult struct {
	Charged          bool  // false when the idempotency key already existed
	BillingAccountID string
	BalanceMicro     int64
	Warning          bool // balance below warning_threshold_micro
	HardStop         bool // balance at/under hard_stop_threshold_micro
}

// ChargeRequest writes the request's ledger row AND its usage_charge credit
// entry AND the balance cache update in ONE transaction (spec §10, PRD §128).
//
// Idempotency is durable, not best-effort: `idempotency_key = 'usage:' ||
// request_id` with ON CONFLICT DO NOTHING means a retry of the same request can
// never double-charge (PRD §118). The ledger row is authoritative —
// `balance_micro` is a cache and is always reconcilable from
// SUM(credit_ledger.amount_micro).
//
// Usage is charged whenever a user has a billing account: tokens that were
// consumed are owed whether or not the account is at its hard stop. The hard
// stop gates ADMISSION (store.BudgetGateState, called from checkBudgets), not
// payment, and ChargeResult.HardStop tells the caller to stop admitting further
// requests for this user.
//
// MEASURED COST: ONE round trip. It was six — BEGIN, the request_log insert, a
// `for update` on billing_account, the credit_ledger insert, the balance update,
// COMMIT — and that was the single largest per-request store cost in the router.
// TestWritePathRoundTrips pins the count at 1.
//
// The round trips were not the real damage; the LOCK HOLD was. The explicit
// `for update` was held from statement 3 until statement 6, five round trips, so
// every concurrent request for the SAME account queued on it. Folding the block
// into one statement keeps the lock — the atomic `balance_micro + $45` still needs
// it — but holds it for the tail of a single statement instead of four network
// waits. The evidence is the round-trip COUNT (6 -> 1, pinned by
// TestWritePathRoundTrips) plus the lock hold itself; the wall-clock difference is
// real but this box varies by an order of magnitude run to run, so it is not the
// number to quote (see the note in internal/proxy/zz_contention_test.go).
//
// Two facts constrain any future change here, and both are tested:
//
//   - The credit_ledger insert is idempotent on `usage:<request id>`; a replay
//     must report Charged=false AND the account's CURRENT balance, because the
//     caller's low-balance check reads that number.
//   - request_attempt has an FK to request_log, so the request_log row must
//     exist before the attempts are written. That is why the insert is its own
//     CTE arm rather than being folded into the ledger insert's FROM clause.
func (s *Store) ChargeRequest(ctx context.Context, r *RequestLog) (*ChargeResult, error) {
	// Mirror the charge on the ledger row BEFORE the insert so request_log is
	// self-describing (spec §8: credit_charged_micro) without joining.
	if r.CreditChargedMicro == 0 && r.Cost != 0 {
		r.CreditChargedMicro = r.Cost
	}

	res := &ChargeResult{Charged: true}
	if r.UserID == "" {
		// Account-less tenant (S0): there is no billing_account row to lock and
		// nothing to charge, so this is one insert and nothing else.
		if _, err := s.pool.Exec(ctx, `
			insert into request_log (`+requestLogColumns+`)
			values (`+placeholders(40)+`)
			on conflict (id) do nothing`, r.args()...); err != nil {
			return nil, err
		}
		return res, nil
	}

	// ONE statement, not six round trips.
	//
	// The measured defect this replaces: the block was BEGIN, insert request_log,
	// `select ... for update` billing_account, insert credit_ledger, update
	// balance, COMMIT. The explicit row lock was held from statement 3 until
	// statement 6 — five round trips — so every concurrent request for the SAME
	// workspace queued on it. Measured at 12 workers x 10 requests: one workspace
	// 43 rps / p50 89ms / p99 2.07s, while the same load across 12 workspaces was
	// 152 rps / p50 59ms / p99 221ms (TestWritePathSerializesOneWorkspace).
	//
	// The fix is not to remove the lock but to stop holding it across round trips.
	// `insert request_log` is a separate arm because request_attempt has an FK to
	// it; the rest rides the ledger insert, and `update billing_account ... from
	// ledger` both locks the account row and takes its atomic increment. Postgres
	// re-checks the WHERE clause after acquiring a row lock, so a concurrent
	// writer cannot lose its update, and the lock is now held for the tail of one
	// statement instead of four network waits.
	//
	// A CTE cannot span two data-modifying arms that target the same row in one
	// statement, so the ledger insert and the balance update are joined by a
	// FROM-clause reference to the inserted row: `invalidated` gives the insert a
	// name its consumer can read (an unreferenced data-modifying CTE in the same
	// statement still runs exactly once — see the ledger idempotency note below).
	var (
		accountID                                           *string
		warningThreshold, hardStop, balance                 *int64
		charged                                             *bool
	)
	err := s.pool.QueryRow(ctx, `
		with rl as (
			insert into request_log (`+requestLogColumns+`)
			values (`+placeholders(40)+`)
			on conflict (id) do nothing
			returning 1
		), ledger as (
			insert into credit_ledger
			  (id, billing_account_id, type, amount_micro, currency, request_id,
			   idempotency_key, description, metadata)
			select $41, ba.id, 'usage_charge', $42, $43, $44, $45, $46, '{}'::jsonb
			from billing_account ba
			where ba.user_id = $47
			on conflict (idempotency_key) do nothing
			returning id, billing_account_id
		), bal as (
			update billing_account ba
			set balance_micro = ba.balance_micro + $42, updated_at = now()
			from ledger l
			where ba.id = l.billing_account_id
			returning ba.id, ba.warning_threshold_micro, ba.hard_stop_threshold_micro, ba.balance_micro
		)
		-- The charged case: the row the update just wrote.
		select bal.id, bal.warning_threshold_micro, bal.hard_stop_threshold_micro, bal.balance_micro, true
		from bal
		union all
		-- The replay case (ledger conflict, so no balance moved): report the
		-- account's CURRENT state, which is what the caller's low-balance check
		-- needs. Without this arm a replay answered balance 0 — measured, and it
		-- is what the first version of this statement returned.
		select ba.id, ba.warning_threshold_micro, ba.hard_stop_threshold_micro, ba.balance_micro, false
		from billing_account ba
		where ba.user_id = $47 and not exists (select 1 from bal)`,
		append(append([]any{}, r.args()...),
			ids.New("txn"), -r.Cost, r.Currency, nullStr(r.ID),
			"usage:"+r.ID, "usage charge for "+r.ID, nullStr(r.UserID))...,
	).Scan(&accountID, &warningThreshold, &hardStop, &balance, &charged)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		// No billing account for this user: the S0 tenant that predates
		// billing. `Charged` stays true — the usage was recorded and there was
		// nothing to charge, which is the semantics this returned before the
		// statements were folded together.
		return res, nil
	case err != nil:
		return nil, err
	}
	if charged != nil && !*charged {
		res.Charged = false // already charged: idempotent replay
	}
	if accountID != nil {
		res.BillingAccountID = *accountID
	}
	if balance != nil {
		res.BalanceMicro = *balance
		if res.Charged {
			res.Warning = warningThreshold != nil && *balance <= *warningThreshold
			res.HardStop = hardStop != nil && *balance <= *hardStop
			// The cached gate state is holding this account's PRE-charge
			// balance. Drop it the moment the line is crossed so the next
			// request re-reads and refuses, instead of being admitted for up to
			// gateTTL off a balance that no longer exists. Only on the crossing
			// (not every charge) — a cache miss per charge would put the round
			// trip back on the hot path this cache exists to remove.
			if res.HardStop {
				s.InvalidateAdmission(r.UserID)
			}
		}
	}
	return res, nil
}

// MonthlyCostMicro sums a key's customer charges for the current (UTC) month —
// the counter the per-key `monthly_spend_micro` cap is checked against.
//
// It sums the CHARGE columns: `credit_charged_micro` where a row has one, else
// the legacy `cost` column, so rows written before the ledger existed (or
// without an account to charge) still count towards the cap. `cost` remains
// "the customer charge" per spec §8, so the two agree for every row this
// version of the router writes.
func (s *Store) MonthlyCostMicro(ctx context.Context, apiKeyID string) (int64, error) {
	return s.spendMicro(ctx, `api_key_id = $1`, apiKeyID, dateTruncMonth)
}

// DailyCostMicro is the same sum over the current UTC day, for the per-key
// `daily_spend_micro` cap (spec §3).
func (s *Store) DailyCostMicro(ctx context.Context, apiKeyID string) (int64, error) {
	return s.spendMicro(ctx, `api_key_id = $1`, apiKeyID, dateTruncDay)
}

const dateTruncMonth = `date_trunc('month', now())`
const dateTruncDay = `date_trunc('day', now())`

func (s *Store) spendMicro(ctx context.Context, where, id, sinceExpr string) (int64, error) {
	var v int64
	err := s.pool.QueryRow(ctx, `
		select coalesce(sum(coalesce(credit_charged_micro, cost)), 0)::bigint
		from request_log
		where `+where+` and created_at >= `+sinceExpr, id,
	).Scan(&v)
	return v, err
}

// SpendMicro sums customer charges for a whole scope since `since` — the
// durable aggregate the budget checks re-verify when a Valkey counter is
// missing (spec §7: "counter loss must never make spending unbounded").
//
// scope is account|api_key (the rate_limit/budget scope vocabulary after
// migration 0019; the three hierarchy scopes are gone).
func (s *Store) SpendMicro(ctx context.Context, scope, scopeID string, since time.Time) (int64, error) {
	var where string
	switch scope {
	case "account":
		// `account` is the user: request_log.user_id is the ownership column.
		where = `user_id = $1`
	case "api_key":
		where = `api_key_id = $1`
	default:
		return 0, ErrNotFound
	}
	var v int64
	err := s.pool.QueryRow(ctx, `
		select coalesce(sum(coalesce(credit_charged_micro, cost)), 0)::bigint
		from request_log
		where `+where+` and created_at >= $2`, scopeID, since,
	).Scan(&v)
	return v, err
}
