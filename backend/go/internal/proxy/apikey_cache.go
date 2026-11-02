package proxy

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
)

// API key cache (Valkey, best-effort, fail-open to DB).
//
// Why it exists: authenticate ran a Postgres SELECT on `api_key` for EVERY
// request — measured live 2026-10-31 at p95 518 ms for the `auth` phase, on a
// path whose only other work is a sha256 compare. The row changes only when an
// operator revokes a key or edits its policy, so a short TTL removes a DB round
// trip from every request.
//
// The contract this must not break: public.mjs documents "revocation takes
// effect immediately for new requests". A plain TTL would keep a revoked key
// working for the whole window, so the console DELETES this entry when it
// revokes (apps/web/server/pages.mjs, key.revoke) — the TTL is only the
// backstop for a console that could not reach Valkey.
//
// Fail-open, like every other cache here: a miss, a disabled client, or a
// transport error falls through to the DB read. A cache outage must never stop
// a paying member, and it must never be the reason a key authenticates.

// apiKeyCacheTTL bounds how long a stale row can survive a console that failed
// to invalidate. Short on purpose: the invalidation is the real mechanism, this
// is the backstop.
const apiKeyCacheTTL = 30 * time.Second

// apiKeyCacheKey is the Valkey key for one key's row, namespaced by database so
// two deployments sharing a Valkey cannot answer from each other's rows.
//
// Exported shape (the console must spell it identically to delete it):
// rt:<ns>:apikey:<prefix>. The console builds it from the same namespace the
// router derives from DATABASE_URL — see store.CacheNamespace.
func (h *Handler) apiKeyCacheKey(prefix string) string {
	return cacheKey(h.cacheNS(), "apikey", prefix)
}

// cachedAPIKeyRow resolves a key by prefix through the cache, falling back to
// the DB. The returned row is a COPY: the caller must not mutate it, because
// the same cached bytes serve every request for that key.
func (h *Handler) cachedAPIKeyRow(ctx context.Context, prefix string) (*store.APIKeyRow, error) {
	key := h.apiKeyCacheKey(prefix)
	var row store.APIKeyRow
	if err := h.vk.GetJSON(ctx, key, &row, 5*time.Second); err == nil {
		// A cached row still carries its status/expiry, so the gates below run
		// on the cached copy exactly as they would on a fresh read. A key that
		// expired while cached must not authenticate.
		if err := row.Gate(time.Now()); err != nil {
			return nil, err
		}
		return &row, nil
	}
	// Any miss or error (ErrNotFound, ErrDisabled, transport failure) falls
	// through to the DB read below; vk logs transport errors itself.
	r, err := h.store.LookupAPIKey(ctx, prefix)
	if err != nil {
		return nil, err
	}
	_ = h.vk.SetJSON(ctx, key, r, apiKeyCacheTTL) // best-effort: a failed Set never fails the request
	return r, nil
}
