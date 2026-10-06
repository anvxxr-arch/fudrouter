package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/anvxxr-arch/fudrouter/services/router/internal/ids"
	"github.com/jackc/pgx/v5"
)

// RequestLog is one row of the append-only request ledger (spec §8).
//
// `TokensIn`/`TokensOut`/`Cost` keep their S0 names (spec §8: "Existing S0
// column names stand"); `Cost` is the CUSTOMER CHARGE. New columns use full
// names. `TotalTokens` is *int64 because NULL and 0 differ (PRD §122): NULL =
// the provider did not report usage, 0 = it reported zero.
type RequestLog struct {
	ID              string
	UserID          string
	APIKeyID        string
	WorkspaceID     string
	ProjectID       string
	EnvironmentID   string
	Endpoint        string
	RequestedModel  string
	ModelID         string
	ProviderModelID string // provider_model entity id (pmdl_…) — spec §8
	ProviderID      string
	ConnectionID    string
	CredentialID    string
	RoutingPolicyID string
	Strategy        string

	Status     string // success|client_error|provider_error|timeout|rate_limited|cancelled|internal_error
	ErrorCode  string // PRD §88 taxonomy code, or "" for success
	Error      string
	HTTPStatus *int

	TokensIn          int64
	CachedInputTokens int64
	TokensOut         int64
	ReasoningTokens   int64
	TotalTokens       *int64

	InputPriceMicro        *string // numeric(18,6) as stored
	CachedInputPriceMicro  *string
	OutputPriceMicro       *string
	ReasoningPriceMicro    *string
	PricingRuleID          string
	ProviderCostMicro      int64
	Cost                   int64 // customer charge (micro-units)
	CreditChargedMicro     int64
	Currency               string

	TTFTMs             *int
	LatencyMs          int64
	Timing             map[string]int64 // spec §8: auth, rate_limit, routing, queue, connection, generation
	Attempts           int
	FallbackUsed       bool
	Stream             bool
	ClientDisconnected bool
	ClientIP           string // inet; "" → NULL (0008)
	RequestBody        string
	ResponseBody       string
}

const requestLogColumns = `
	id, user_id, api_key_id, workspace_id, project_id, environment_id,
	endpoint, requested_model, model_id, provider_model_id, provider_id,
	connection_id, credential_id, routing_policy_id, strategy,
	status, error_code, error, http_status,
	tokens_in, cached_input_tokens, tokens_out, reasoning_tokens, total_tokens,
	input_price_micro, cached_input_price_micro, output_price_micro, reasoning_price_micro,
	pricing_rule_id, provider_cost_micro, cost, credit_charged_micro, currency,
	ttft_ms, latency_ms, timing, attempts, fallback_used, stream, client_disconnected,
	client_ip, request_body, response_body`

func (r *RequestLog) args() []any {
	timingJSON := []byte("{}")
	if len(r.Timing) > 0 {
		if b, err := json.Marshal(r.Timing); err == nil {
			timingJSON = b
		}
	}
	ttft := any(nil)
	if r.TTFTMs != nil {
		ttft = *r.TTFTMs
	}
	total := any(nil)
	if r.TotalTokens != nil {
		total = *r.TotalTokens
	}
	pricingRuleID := any(nil)
	if r.PricingRuleID != "" {
		pricingRuleID = r.PricingRuleID
	}
	var clientIP any
	if r.ClientIP != "" {
		clientIP = r.ClientIP
	}
	return []any{
		r.ID, nullStr(r.UserID), nullStr(r.APIKeyID), nullStr(r.WorkspaceID),
		nullStr(r.ProjectID), nullStr(r.EnvironmentID),
		nullStr(r.Endpoint), nullStr(r.RequestedModel), nullStr(r.ModelID),
		nullStr(r.ProviderModelID), nullStr(r.ProviderID), nullStr(r.ConnectionID),
		nullStr(r.CredentialID), nullStr(r.RoutingPolicyID), nullStr(r.Strategy),
		r.Status, nullStr(r.ErrorCode), nullStr(r.Error), r.HTTPStatus,
		r.TokensIn, r.CachedInputTokens, r.TokensOut, r.ReasoningTokens, total,
		r.InputPriceMicro, r.CachedInputPriceMicro, r.OutputPriceMicro, r.ReasoningPriceMicro,
		pricingRuleID, r.ProviderCostMicro, r.Cost, r.CreditChargedMicro, r.Currency,
		ttft, r.LatencyMs, timingJSON, r.Attempts, r.FallbackUsed, r.Stream, r.ClientDisconnected,
		clientIP, nullStr(r.RequestBody), nullStr(r.ResponseBody),
	}
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// InsertRequestLog writes one ledger row WITHOUT charging. It is the funnel for
// every outcome that costs nothing (auth failures, rejections, upstream errors
// with no reported usage). Anything that consumed tokens goes through
// ChargeRequest, which writes the row and the ledger entry atomically.
func (s *Store) InsertRequestLog(ctx context.Context, r *RequestLog) error {
	_, err := s.pool.Exec(ctx, `
		insert into request_log (`+requestLogColumns+`)
		values (`+placeholders(43)+`)
		on conflict (id) do nothing`, r.args()...)
	return err
}

// InsertRequestLogWithLedger is the FALLBACK path for a failed ChargeRequest:
// it writes the request_log row AND the usage_charge credit_ledger row AND the
// balance_micro cache update in ONE transaction, so billing_account.balance_micro
// can never desync from SUM(credit_ledger.amount_micro) just because the charge
// transaction blew up. The plain InsertRequestLog above drops the ledger entry,
// which silently loses money the workspace owes.
//
// It mirrors ChargeRequest's logic but is tolerant of a PARTIAL failure: the
// request_log insert and the credit_ledger insert are both
// `on conflict do nothing` (idempotency key `usage:<request_id>`), so replaying
// a request whose first attempt committed the row but failed afterwards can
// never double-charge. The balance update is applied only when the ledger row
// was actually inserted, exactly as in ChargeRequest.
//
// The account is looked up WITHOUT `for update`: this runs on the recovery path
// where the primary transaction has already failed, so a lock would only add
// contention to an already-degraded moment, and the balance update is
// idempotent by construction (it is guarded by the ledger insert).
func (s *Store) InsertRequestLogWithLedger(ctx context.Context, r *RequestLog) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // rollback after Commit is a no-op
	// Same mirroring rule as ChargeRequest: request_log is self-describing.
	if r.CreditChargedMicro == 0 && r.Cost != 0 {
		r.CreditChargedMicro = r.Cost
	}
	if _, err := tx.Exec(ctx, `
		insert into request_log (`+requestLogColumns+`)
		values (`+placeholders(43)+`)
		on conflict (id) do nothing`, r.args()...); err != nil {
		return err
	}
	if r.WorkspaceID == "" {
		// Account-less tenant: nothing to charge, same as ChargeRequest.
		return tx.Commit(ctx)
	}
	var accountID string
	var currency string
	err = tx.QueryRow(ctx, `
		select id, currency from billing_account where workspace_id = $1`,
		r.WorkspaceID,
	).Scan(&accountID, &currency)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		// No account: the row stands on its own, nothing to charge.
		return tx.Commit(ctx)
	case err != nil:
		return err
	}
	amount := -r.Cost // a usage_charge debits the balance
	var charged bool
	err = tx.QueryRow(ctx, `
		insert into credit_ledger
		  (id, billing_account_id, type, amount_micro, currency, request_id,
		   idempotency_key, description, metadata)
		values ($1,$2,'usage_charge',$3,$4,$5,$6,$7,$8)
		on conflict (idempotency_key) do nothing
		returning true`,
		ids.New("txn"), accountID, amount, r.Currency, nullStr(r.ID),
		"usage:"+r.ID, "usage charge for "+r.ID, "{}",
	).Scan(&charged)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		// Already charged (or the row exists from the failed attempt): the
		// balance was already moved with it, so do not move it again.
		return tx.Commit(ctx)
	case err != nil:
		return err
	}
	if _, err := tx.Exec(ctx, `
		update billing_account
		set balance_micro = balance_micro + $2, updated_at = now()
		where id = $1`, accountID, amount); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RequestAttempt is one routing attempt against one target (spec §8).
//
// `ProviderModelID` carries the provider_model entity id (pmdl_…); the
// upstream's own model name is recorded in Metadata["upstream_model"].
type RequestAttempt struct {
	ID                string
	RequestID         string
	Attempt           int
	ProviderID        string
	ConnectionID      string
	CredentialID      string
	ProviderModelID   string
	HTTPStatus        *int
	ErrorCode         string
	Retryable         *bool
	LatencyMs         int64
	TTFTMs            *int
	ProviderCostMicro int64
	Reason            string // why this candidate won the attempt (spec §8)
	StartedAt         time.Time
	FinishedAt        time.Time
	Metadata          map[string]any
}

// InsertRequestAttempt appends one attempt. Every attempt of every request is
// recorded — including the ones that were skipped? No: an attempt is a real
// upstream exchange. A candidate that was filtered out or whose circuit was
// open never becomes an attempt; the attempt that hit an open circuit DOES,
// with reason recording why it was chosen and ErrorCode CIRCUIT_OPEN.
func (s *Store) InsertRequestAttempt(ctx context.Context, a *RequestAttempt) error {
	meta := []byte("{}")
	if len(a.Metadata) > 0 {
		if b, err := json.Marshal(a.Metadata); err == nil {
			meta = b
		}
	}
	var ttft any
	if a.TTFTMs != nil {
		ttft = *a.TTFTMs
	}
	var code, cred, conn, pm any
	if a.ErrorCode != "" {
		code = a.ErrorCode
	}
	if a.CredentialID != "" {
		cred = a.CredentialID
	}
	if a.ConnectionID != "" {
		conn = a.ConnectionID
	}
	if a.ProviderModelID != "" {
		pm = a.ProviderModelID
	}
	_, err := s.pool.Exec(ctx, `
		insert into request_attempt
		  (id, request_id, attempt, provider_id, connection_id, credential_id,
		   provider_model_id, http_status, error_code, retryable, latency_ms,
		   ttft_ms, provider_cost_micro, reason, started_at, finished_at, metadata)
		values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
		on conflict (request_id, attempt) do nothing`,
		a.ID, a.RequestID, a.Attempt, nullStr(a.ProviderID), conn, cred,
		pm, a.HTTPStatus, code, a.Retryable, a.LatencyMs,
		ttft, a.ProviderCostMicro, nullStr(a.Reason), a.StartedAt, a.FinishedAt, meta)
	return err
}

// placeholders builds "$1,$2,…" for the insert above. Kept next to
// requestLogColumns so the two cannot drift apart.
func placeholders(n int) string {
	out := make([]byte, 0, n*4)
	for i := range n {
		if i > 0 {
			out = append(out, ',')
		}
		out = append(out, '$')
		out = append(out, []byte(itoa(i+1))...)
	}
	return string(out)
}

func itoa(n int) string {
	if n < 10 {
		return string(rune('0' + n))
	}
	return string(rune('0'+n/10)) + string(rune('0'+n%10))
}
