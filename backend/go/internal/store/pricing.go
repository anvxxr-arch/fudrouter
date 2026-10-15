package store

import (
	"context"
	"errors"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/cost"
	"github.com/jackc/pgx/v5"
)

// Pricing is the price snapshot a request is billed at (spec §6).
//
// All four prices are numeric(18,6) micro-units of currency per 1M tokens, kept
// as their STORED STRING for the request_log snapshot columns, and as the
// scaled int64 (`cost.Price`) for the arithmetic. Money never touches a float.
type Pricing struct {
	RuleID    string
	Currency  string
	InputStr  string
	CachedStr string // "" = NULL in the table = no cached pricing offered
	OutputStr string
	ReasonStr string // "" = NULL in the table = reasoning bills at output price

	InputMicro  int64 // scaled by 1e6 (cost.Price)
	CachedMicro int64
	OutputMicro int64
	ReasonMicro int64
	Legacy      bool // resolved from model.input_price/output_price (pre-0006 rows)
}

// ResolvePricingMany is ResolvePricing for MANY (model, provider_model) pairs in
// ONE round trip, keyed "<modelID>\x00<providerModelID>".
//
// Why it exists: the candidate pricing pass batches its Valkey reads into one
// MGET, but every cache MISS fell back to the single-row resolver — one query per
// model. A `[NAME]/*` virtual request from a cold cache therefore cost one query
// per model in the catalogue (measured: 500 for a 500-model catalogue, ~58ms of
// sequential database time before the first upstream byte), and it repeats on any
// TTL wave, deploy or flush, because every entry expires on the same clock.
//
// The SQL is the single-row predicate with `= any(...)` and a per-pair
// row_number, so the "provider_model-specific rule wins, then newest version"
// ordering — and therefore which price wins — is unchanged. Pairs with no
// pricing_rule and no legacy model row are simply absent from the result, which
// is what the single-row form's ErrNotFound means; a missing entry is not an
// error here because one dead pair must not fail the whole pricing pass.
//
// Money never touches a float: the same cost.Price scaling as ResolvePricing.
func (s *Store) ResolvePricingMany(ctx context.Context, keys [][2]string, at time.Time) (map[string]*Pricing, error) {
	out := make(map[string]*Pricing, len(keys))
	if len(keys) == 0 {
		return out, nil
	}
	modelIDs := make([]string, 0, len(keys))
	pmdlIDs := make([]string, 0, len(keys))
	for _, k := range keys {
		modelIDs = append(modelIDs, k[0])
		pmdlIDs = append(pmdlIDs, k[1])
	}

	rows, err := s.pool.Query(ctx, `
		with want as (
			select model_id, pmdl_id
			from unnest($1::text[], $2::text[]) as w(model_id, pmdl_id)
		), ranked as (
			select w.model_id, w.pmdl_id,
			       pr.id, pr.currency, pr.input_price::text, pr.cached_input_price::text,
			       pr.output_price::text, pr.reasoning_price::text,
			       row_number() over (
				   partition by w.model_id, w.pmdl_id
				   order by (pr.provider_model_id is not null) desc, pr.version desc
			       ) as rn
			from want w
			join pricing_rule pr
			  on pr.model_id = w.model_id
			 and (pr.provider_model_id = w.pmdl_id or pr.provider_model_id is null)
			 and pr.effective_from <= $3
			 and (pr.effective_until is null or pr.effective_until > $3)
		)
		select r.model_id, r.pmdl_id, r.id, r.currency, r.input_price, r.cached_input_price,
		       r.output_price, r.reasoning_price, false
		from ranked r where r.rn = 1
		union all
		-- The legacy fallback (spec §14): a model with no pricing_rule at all
		-- keeps billing at its S0 list price. Only for pairs the ranked CTE did
		-- not already answer.
		select w.model_id, w.pmdl_id, '', coalesce(m.currency, 'USD'),
		       m.input_price::text, null, m.output_price::text, null, true
		from want w
		join model m on m.id = w.model_id
		where not exists (
			select 1 from ranked r where r.model_id = w.model_id and r.pmdl_id = w.pmdl_id
		)`, modelIDs, pmdlIDs, at)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var p Pricing
		var modelID, pmdlID string
		var cached, reason *string
		if err := rows.Scan(&modelID, &pmdlID, &p.RuleID, &p.Currency, &p.InputStr, &cached,
			&p.OutputStr, &reason, &p.Legacy); err != nil {
			return nil, err
		}
		if cached != nil {
			p.CachedStr = *cached
		}
		if reason != nil {
			p.ReasonStr = *reason
		}
		p.InputMicro = cost.Price(p.InputStr)
		p.OutputMicro = cost.Price(p.OutputStr)
		p.CachedMicro = cost.Price(p.CachedStr)
		p.ReasonMicro = cost.Price(p.ReasonStr)
		out[modelID+"\x00"+pmdlID] = &p
	}
	return out, rows.Err()
}

// ResolvePricing returns the pricing_rule version effective at `at` (spec §6).
//
// Where both a provider_model-specific and a model-wide rule exist, the
// specific one wins; among equals the newest effective version wins. NULL
// semantics (PRD §122) fall back per spec §6: a NULL cached_input_price means
// cached input bills at input_price, a NULL reasoning_price means reasoning
// bills at output_price — the fallbacks are applied in BillablePrices, not by
// inventing a stored value.
func (s *Store) ResolvePricing(ctx context.Context, modelID, providerModelID string, at time.Time) (*Pricing, error) {
	p := &Pricing{Currency: "USD"}
	var cached, reason *string
	err := s.pool.QueryRow(ctx, `
		select id, currency, input_price::text, cached_input_price::text,
		       output_price::text, reasoning_price::text
		from pricing_rule
		where model_id = $1
		  and (provider_model_id = $2 or provider_model_id is null)
		  and effective_from <= $3
		  and (effective_until is null or effective_until > $3)
		order by (provider_model_id is not null) desc, version desc
		limit 1`, modelID, providerModelID, at,
	).Scan(&p.RuleID, &p.Currency, &p.InputStr, &cached, &p.OutputStr, &reason)
	switch {
	case err == nil:
		if cached != nil {
			p.CachedStr = *cached
		}
		if reason != nil {
			p.ReasonStr = *reason
		}
	case errors.Is(err, pgx.ErrNoRows):
		// Legacy fallback (spec §14 promise: pre-0006 model rows keep billing).
		// A model with no pricing_rule at all still has its S0 list price.
		legacy := &Pricing{Currency: "USD", Legacy: true}
		var in, out, cur *string
		err = s.pool.QueryRow(ctx,
			`select input_price::text, output_price::text, currency
			 from model where id = $1`, modelID,
		).Scan(&in, &out, &cur)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		if in != nil {
			legacy.InputStr = *in
		}
		if out != nil {
			legacy.OutputStr = *out
		}
		if cur != nil {
			legacy.Currency = *cur
		}
		p = legacy
	default:
		return nil, err
	}
	p.InputMicro = cost.Price(p.InputStr)
	p.OutputMicro = cost.Price(p.OutputStr)
	p.CachedMicro = cost.Price(p.CachedStr)
	p.ReasonMicro = cost.Price(p.ReasonStr)
	return p, nil
}

// BillablePrices returns the four prices with the spec §6 NULL fallbacks
// applied: cached input bills at input_price when no cached pricing is offered,
// reasoning bills at output_price when no reasoning price exists. Keeping the
// fallback here (rather than in ResolvePricing) preserves the difference
// between "NULL" and "0" in the stored snapshot (PRD §122).
func (p *Pricing) BillablePrices() (in, cached, out, reason int64) {
	in = p.InputMicro
	cached = p.CachedMicro
	if p.CachedStr == "" {
		cached = in
	}
	out = p.OutputMicro
	reason = p.ReasonMicro
	if p.ReasonStr == "" {
		reason = out
	}
	return in, cached, out, reason
}
