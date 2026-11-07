package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// BridgeTarget is a loopback media bridge: the connection that points at it and
// one usable credential to authenticate with.
//
// It exists because the media surface has a path with NO model in the request —
// `GET /v1/media/{name}`, which serves the bytes a generation produced. That
// path cannot resolve a model, so it cannot use Candidates, and it must not
// run the admission half of the lifecycle (auth → limits → budget): the image
// was already billed when it was generated, and charging a byte fetch would
// make fetching what you paid for cost extra. It therefore needs the upstream
// address and a token in ONE round trip, which is what this returns.
type BridgeTarget struct {
	ConnectionID string
	BaseURL      string
	CredentialID string
	// SecretEnc is the raw encrypted secret blob. Callers decrypt it through
	// their own Crypt; the store never holds a plaintext key.
	SecretEnc string
}

// MediaBridge resolves the enabled connection backing a provider slug, with its
// first usable credential in the same statement.
//
// The credential predicate mirrors CandidatesBatch exactly (not
// disabled/invalid, not cooling down, ordered by priority then weight) so a
// rotated pool answers the same account the chat path would use. The lateral
// join is what keeps it one round trip: a plain join would multiply the
// connection row by its credentials and make the ordering ambiguous.
//
// `health_status is distinct from 'unhealthy'` rather than `= 'healthy'`:
// health_status is NULL on a connection that has never been probed, and a
// fresh install must not read as "no bridge".
func (s *Store) MediaBridge(ctx context.Context, providerSlug string) (*BridgeTarget, error) {
	var t BridgeTarget
	err := s.pool.QueryRow(ctx, `
		select c.id, c.base_url, cr.id, cr.secret_enc
		from connection c
		join provider p on p.id = c.provider_id
		join lateral (
			select cr.id, cr.secret_enc
			from credential cr
			where cr.connection_id = c.id
			  and cr.status not in ('disabled', 'invalid')
			  and (cr.cooldown_until is null or cr.cooldown_until <= now())
			order by cr.priority asc, cr.weight desc, cr.id
			limit 1
		) cr on true
		where p.slug = $1
		  and c.enabled
		  and c.health_status is distinct from 'unhealthy'
		order by c.id
		limit 1`, providerSlug).Scan(&t.ConnectionID, &t.BaseURL, &t.CredentialID, &t.SecretEnc)
	if errors.Is(err, pgx.ErrNoRows) {
		// The store's own "no such row" answer, so callers do not have to know
		// pgx exists to answer a missing bridge with a 404.
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}
