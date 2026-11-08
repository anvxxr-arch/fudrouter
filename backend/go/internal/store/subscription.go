package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/ids"
)

// Subscription is one paid entitlement window (migration 0025). The data plane
// reads it to answer "may this account use the router right now"; the control
// plane writes it when a payment settles.
type Subscription struct {
	ID        string
	AccountID string
	Plan      string
	Status    string
	StartsAt  time.Time
	ExpiresAt time.Time
	PriceIDR  int64
	PaymentID *string
}

// ErrNoSubscription is the "this account has never paid" answer, distinct from
// "the row exists but expired" so the caller can warn differently.
var ErrNoSubscription = errors.New("no subscription")

// LiveSubscription returns the account's current live subscription, or
// ErrNoSubscription when none is active. It is the hot-path read: one indexed
// query, partial on status='active', ordered so the latest expiry wins when a
// member stacked two plans.
//
// The caller caches this per key (60s, like EffectiveLimits) — the query is
// cheap but it must not run per request at 15k concurrent.
func (s *Store) LiveSubscription(ctx context.Context, accountID string) (*Subscription, error) {
	row := &Subscription{}
	err := s.pool.QueryRow(ctx, `
		select id, account_id, plan, status, starts_at, expires_at, price_idr, payment_id
		from subscription
		where account_id = $1 and status = 'active' and expires_at > now()
		order by expires_at desc
		limit 1`, accountID,
	).Scan(&row.ID, &row.AccountID, &row.Plan, &row.Status,
		&row.StartsAt, &row.ExpiresAt, &row.PriceIDR, &row.PaymentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNoSubscription
	}
	if err != nil {
		return nil, err
	}
	return row, nil
}

// LatestSubscription returns the account's most recent subscription row
// REGARDLESS of whether it is still live. It is the admission gate's read
// (B0): owner rule 12 needs to distinguish "a window that lapsed" from "never
// subscribed at all", and LiveSubscription's live-only `expires_at > now()`
// filter collapses those two into one ErrNoSubscription — which would make
// "expired" and "broke" the same state, exactly the collapse the 0025 schema
// split the tables apart to avoid.
//
// An active window wins over a lapsed one even when its expiry is not the
// latest (a cancelled/refunded row must never shadow a still-live window), and
// the latest expiry wins within a status, matching LiveSubscription's stacking
// semantics. The wire's classification (live vs expired) happens in the caller
// from the returned row's status + expires_at; this method only says "here is
// the window that decides, or none has ever been granted".
//
// Like LiveSubscription it is cached by the caller (60s, AdmissionSubscription)
// so a lapsed-window account does not pay a Postgres round trip per request.
func (s *Store) LatestSubscription(ctx context.Context, accountID string) (*Subscription, error) {
	row := &Subscription{}
	err := s.pool.QueryRow(ctx, `
		select id, account_id, plan, status, starts_at, expires_at, price_idr, payment_id
		from subscription
		where account_id = $1
		order by (status = 'active') desc, expires_at desc
		limit 1`, accountID,
	).Scan(&row.ID, &row.AccountID, &row.Plan, &row.Status,
		&row.StartsAt, &row.ExpiresAt, &row.PriceIDR, &row.PaymentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNoSubscription
	}
	if err != nil {
		return nil, err
	}
	return row, nil
}

// GrantSubscription inserts a paid window and returns it. `paymentID` may be
// empty for an admin comp. The window starts now and runs `days` days.
//
// It is idempotent on payment_id: a replayed webhook that already granted this
// payment returns the existing row instead of stacking a second window. That is
// the same idempotency the ledger gets from `usage:<request id>`.
func (s *Store) GrantSubscription(ctx context.Context, accountID, plan string, days int, priceIDR int64, paymentID string) (*Subscription, error) {
	var pid *string
	if paymentID != "" {
		pid = &paymentID
		// A payment that already granted a subscription must not grant again.
		existing := &Subscription{}
		err := s.pool.QueryRow(ctx, `
			select id, account_id, plan, status, starts_at, expires_at, price_idr, payment_id
			from subscription where payment_id = $1 limit 1`, paymentID,
		).Scan(&existing.ID, &existing.AccountID, &existing.Plan, &existing.Status,
			&existing.StartsAt, &existing.ExpiresAt, &existing.PriceIDR, &existing.PaymentID)
		if err == nil {
			return existing, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
	}

	row := &Subscription{}
	err := s.pool.QueryRow(ctx, `
		insert into subscription (id, account_id, plan, status, starts_at, expires_at, price_idr, payment_id)
		values ($1, $2, $3, 'active', now(), now() + make_interval(days => $4), $5, $6)
		returning id, account_id, plan, status, starts_at, expires_at, price_idr, payment_id`,
		ids.New("sub"), accountID, plan, days, priceIDR, pid,
	).Scan(&row.ID, &row.AccountID, &row.Plan, &row.Status,
		&row.StartsAt, &row.ExpiresAt, &row.PriceIDR, &row.PaymentID)
	if err != nil {
		return nil, err
	}
	return row, nil
}

// KeyIPs returns the admitted client addresses for a key (owner rule 14). The
// caller seeds the in-process guard with this once per key.
func (s *Store) KeyIPs(ctx context.Context, apiKeyID string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		select host(ip) from api_key_ip where api_key_id = $1 order by first_seen_at`, apiKeyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var ip string
		if err := rows.Scan(&ip); err != nil {
			return nil, err
		}
		out = append(out, ip)
	}
	return out, rows.Err()
}

// RecordKeyIP persists a newly admitted address. Best-effort: a failure here
// does not fail the request (the in-process guard already admitted it), but it
// means the address is not durable across a restart — the next restart re-seeds
// from whatever did land.
func (s *Store) RecordKeyIP(ctx context.Context, apiKeyID, ip string) error {
	_, err := s.pool.Exec(ctx, `
		insert into api_key_ip (id, api_key_id, ip)
		values ($1, $2, $3::inet)
		on conflict (api_key_id, ip) do update set last_seen_at = now()`,
		ids.New("kip"), apiKeyID, ip)
	return err
}

// RestrictKey sets the auto-restrict flag (owner rule 15). A restricted key
// authenticates but is refused at the policy gate, so the member sees a clear
// message rather than a generic 401.
func (s *Store) RestrictKey(ctx context.Context, apiKeyID, reason string) error {
	_, err := s.pool.Exec(ctx, `
		update api_key set restricted_at = now(), restricted_reason = $2
		where id = $1 and restricted_at is null`, apiKeyID, reason)
	return err
}

// UnrestrictKey clears the flag, so an operator can restore a key after a
// member resolves the breach.
func (s *Store) UnrestrictKey(ctx context.Context, apiKeyID string) error {
	_, err := s.pool.Exec(ctx, `
		update api_key set restricted_at = null, restricted_reason = null where id = $1`, apiKeyID)
	return err
}

// ActiveKeyCount reports how many non-revoked keys an account holds. The
// single-key rule (owner rule 13) is enforced by the create path consulting
// this; the index `api_key_user_active_idx` makes it O(1).
func (s *Store) ActiveKeyCount(ctx context.Context, userID string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `
		select count(*) from api_key where user_id = $1 and revoked_at is null`, userID).Scan(&n)
	return n, err
}

// Warning is one auto-warn row (owner rule 16).
type Warning struct {
	ID        string
	AccountID string
	Kind      string
	Severity  string
	Message   string
	Delivered []string
	CreatedAt time.Time
}

// InsertWarning records a warning and returns it. `delivered` is the list of
// channels the caller has already pushed to (api/telegram/discord).
func (s *Store) InsertWarning(ctx context.Context, accountID, kind, severity, message string, delivered []string) (*Warning, error) {
	if delivered == nil {
		delivered = []string{}
	}
	row := &Warning{}
	err := s.pool.QueryRow(ctx, `
		insert into member_warning (id, account_id, kind, severity, message, delivered)
		values ($1, $2, $3, $4, $5, $6)
		returning id, account_id, kind, severity, message, delivered, created_at`,
		ids.New("wrn"), accountID, kind, severity, message, delivered,
	).Scan(&row.ID, &row.AccountID, &row.Kind, &row.Severity, &row.Message, &row.Delivered, &row.CreatedAt)
	if err != nil {
		return nil, err
	}
	return row, nil
}

// ListWarnings returns an account's warnings, newest first.
func (s *Store) ListWarnings(ctx context.Context, accountID string, limit int) ([]Warning, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `
		select id, account_id, kind, severity, message, delivered, created_at
		from member_warning where account_id = $1
		order by created_at desc limit $2`, accountID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Warning
	for rows.Next() {
		var w Warning
		if err := rows.Scan(&w.ID, &w.AccountID, &w.Kind, &w.Severity, &w.Message, &w.Delivered, &w.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}
