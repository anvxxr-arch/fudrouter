package store

import (
	"context"
	"errors"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/ids"
	"github.com/jackc/pgx/v5"
)

// BillingAccount is the workspace's prepaid credit account (spec §10).
type BillingAccount struct {
	ID                      string
	WorkspaceID             string
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

// BillingAccountByWorkspace loads the account for a workspace. A workspace with
// no billing account (created outside the control plane's backfill) has no
// credit line: ErrNotFound tells the caller to treat spending as unlimited or
// to refuse, depending on its gate. The data plane treats "no account" as "no
// hard stop" — an account-less workspace is an S0-style tenant, and the S0
// promise is that those keep working (spec §14).
func (s *Store) BillingAccountByWorkspace(ctx context.Context, workspaceID string) (*BillingAccount, error) {
	if workspaceID == "" {
		return nil, ErrNotFound
	}
	b := &BillingAccount{}
	err := s.pool.QueryRow(ctx, `
		select id, workspace_id, currency, status,
		       warning_threshold_micro, hard_stop_threshold_micro, balance_micro
		from billing_account where workspace_id = $1`, workspaceID,
	).Scan(&b.ID, &b.WorkspaceID, &b.Currency, &b.Status,
		&b.WarningThresholdMicro, &b.HardStopThresholdMicro, &b.BalanceMicro)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return b, err
}

// CheckSpendable is the admission gate (spec §10): an account at or under its
// hard stop must be rejected with INSUFFICIENT_CREDITS (HTTP 402) BEFORE an
// upstream call is made. ErrNotFound (no account) is not an error here — see
// BillingAccountByWorkspace.
func (s *Store) CheckSpendable(ctx context.Context, workspaceID string) error {
	b, err := s.BillingAccountByWorkspace(ctx, workspaceID)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if b.Status != "active" {
		return ErrInsufficientCredits
	}
	if b.BalanceMicro <= b.HardStopThresholdMicro {
		return ErrInsufficientCredits
	}
	return nil
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
// Usage is charged whenever a workspace has a billing account: tokens that were
// consumed are owed whether or not the account is at its hard stop. The hard
// stop gates ADMISSION (CheckSpendable), not payment, and ChargeResult.HardStop
// tells the caller to stop admitting further requests for this workspace.
func (s *Store) ChargeRequest(ctx context.Context, r *RequestLog) (*ChargeResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // rollback after Commit is a no-op

	// Mirror the charge on the ledger row BEFORE the insert so request_log is
	// self-describing (spec §8: credit_charged_micro) without joining.
	if r.CreditChargedMicro == 0 && r.Cost != 0 {
		r.CreditChargedMicro = r.Cost
	}
	if _, err := tx.Exec(ctx, `
		insert into request_log (`+requestLogColumns+`)
		values (`+placeholders(43)+`)
		on conflict (id) do nothing`, r.args()...); err != nil {
		return nil, err
	}

	res := &ChargeResult{Charged: true}
	if r.WorkspaceID == "" {
		// Account-less tenant (S0): there is no billing_account row to lock, so
		// the `for update` select would only take a lock path that serialises
		// the common case against itself for nothing. Skip straight to the
		// no-account commit — identical outcome, no row lock.
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return res, nil
	}
	var accountID *string
	var warningThreshold, hardStop, balance *int64
	err = tx.QueryRow(ctx, `
		select id, warning_threshold_micro, hard_stop_threshold_micro, balance_micro
		from billing_account where workspace_id = $1
		for update`, nullStr(r.WorkspaceID),
	).Scan(&accountID, &warningThreshold, &hardStop, &balance)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		// No account: record the usage and stop. There is nothing to charge,
		// which is the S0 behaviour for a tenant that predates billing.
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return res, nil
	case err != nil:
		return nil, err
	}

	res.BillingAccountID = *accountID
	amount := -r.Cost // a usage_charge debits the balance
	var charged bool
	err = tx.QueryRow(ctx, `
		insert into credit_ledger
		  (id, billing_account_id, type, amount_micro, currency, request_id,
		   idempotency_key, description, metadata)
		values ($1,$2,'usage_charge',$3,$4,$5,$6,$7,$8)
		on conflict (idempotency_key) do nothing
		returning true`,
		ids.New("txn"), *accountID, amount, r.Currency, nullStr(r.ID),
		"usage:"+r.ID, "usage charge for "+r.ID, "{}",
	).Scan(&charged)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		res.Charged = false // already charged: idempotent replay
	case err != nil:
		return nil, err
	}

	if res.Charged {
		if _, err := tx.Exec(ctx, `
			update billing_account
			set balance_micro = balance_micro + $2, updated_at = now()
			where id = $1`, *accountID, amount); err != nil {
			return nil, err
		}
		if balance != nil && warningThreshold != nil {
			newBalance := *balance + amount
			res.BalanceMicro = newBalance
			res.Warning = newBalance < *warningThreshold
			res.HardStop = hardStop != nil && newBalance <= *hardStop
		}
	} else if balance != nil {
		res.BalanceMicro = *balance
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
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
// scope is workspace|project|environment|api_key (the rate_limit/budget scope
// vocabulary, spec §7).
func (s *Store) SpendMicro(ctx context.Context, scope, scopeID string, since time.Time) (int64, error) {
	var where string
	switch scope {
	case "workspace":
		where = `workspace_id = $1`
	case "project":
		where = `project_id = $1`
	case "environment":
		where = `environment_id = $1`
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
