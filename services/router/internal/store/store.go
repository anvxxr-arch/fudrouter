// Package store is the data plane's only database access.
package store

import (
	"context"
	"errors"
	"time"

	"github.com/gofrs/uuid/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrNotFound = errors.New("not found")

type Store struct{ pool *pgxpool.Pool }

func New(ctx context.Context, dsn string) (*Store, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() { s.pool.Close() }

type APIKeyRow struct {
	ID        string
	UserID    string
	KeyHash   string
	RevokedAt *time.Time
}

func (s *Store) LookupAPIKey(ctx context.Context, prefix string) (*APIKeyRow, error) {
	row := &APIKeyRow{}
	err := s.pool.QueryRow(ctx,
		`select id, user_id, key_hash, revoked_at from api_key where prefix = $1`, prefix,
	).Scan(&row.ID, &row.UserID, &row.KeyHash, &row.RevokedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return row, err
}

type ModelRow struct {
	ModelID     string
	ProviderID  string
	Slug        string
	InputPrice  string
	OutputPrice string
	Currency    string
	BaseURL     string
	CredEnc     string
}

func (s *Store) ModelWithProvider(ctx context.Context, slug string) (*ModelRow, error) {
	row := &ModelRow{}
	err := s.pool.QueryRow(ctx, `
		select m.id, m.provider_id, m.slug, m.input_price, m.output_price, m.currency,
		       p.base_url, p.credentials_enc
		from model m join provider p on p.id = m.provider_id
		where m.slug = $1 and m.status = 'active' and p.status = 'active'`, slug,
	).Scan(&row.ModelID, &row.ProviderID, &row.Slug, &row.InputPrice, &row.OutputPrice,
		&row.Currency, &row.BaseURL, &row.CredEnc)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return row, err
}

func (s *Store) TouchAPIKey(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `update api_key set last_used_at = now() where id = $1`, id)
	return err
}

func (s *Store) InsertRequestLog(ctx context.Context, r *RequestLog) error {
	if r.ID == "" {
		r.ID = uuid.Must(uuid.NewV7()).String()
	}
	_, err := s.pool.Exec(ctx, `
		insert into request_log
		  (id, user_id, api_key_id, model_id, provider_id, tokens_in, tokens_out,
		   cost, currency, latency_ms, status, error)
		values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
		r.ID, r.UserID, r.APIKeyID, r.ModelID, r.ProviderID, r.TokensIn, r.TokensOut,
		r.Cost, r.Currency, r.LatencyMs, r.Status, r.Error)
	return err
}

type RequestLog struct {
	ID         string
	UserID     string
	APIKeyID   string
	ModelID    string
	ProviderID string
	TokensIn   int64
	TokensOut  int64
	Cost       int64
	Currency   string
	LatencyMs  int64
	Status     string
	Error      string
}

type ModelInfo struct{ Slug, Name string }

func (s *Store) ActiveModels(ctx context.Context) ([]ModelInfo, error) {
	rows, err := s.pool.Query(ctx, `select slug, name from model where status = 'active' order by slug`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ModelInfo
	for rows.Next() {
		var m ModelInfo
		if err := rows.Scan(&m.Slug, &m.Name); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
