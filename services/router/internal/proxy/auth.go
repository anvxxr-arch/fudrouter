package proxy

import (
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/anvxxr-arch/fudrouter/services/router/internal/keys"
	"github.com/anvxxr-arch/fudrouter/services/router/internal/store"
)

// Authentication — the one decision that gates every forwarded request.
//
// The contract is the S0 one (schema spec §14 promise 1): a Bearer
// `sk-ar-<prefix>_<secret>` parsed by internal/keys and matched against
// sha256(secret), byte-compatible with the TS control plane. There is NO
// internal trust header and there must never be one — the data plane
// authenticates independently, so a compromised control plane cannot mint
// traffic the router accepts.

// authenticate parses + validates the key against the api_key table.
// Errors here surface as 401 AUTHENTICATION_ERROR; the unknown-prefix and
// wrong-secret cases are deliberately indistinguishable (no key oracle).
//
// Two credential carriers are accepted because the router serves two inbound
// wire protocols: [OI]-shaped clients send `Authorization: Bearer <key>`, while
// an Anthropic-native client (the Messages API) sends `x-api-key: <key>` and no
// Authorization header. Accepting only one would make the Anthropic surface
// unusable by the very clients it exists for.
func (h *Handler) authenticate(r *http.Request) (*store.APIKeyRow, error) {
	raw, err := bearerOrAPIKey(r)
	if err != nil {
		return nil, err
	}
	k, ok := keys.Parse(raw)
	if !ok {
		return nil, errors.New("malformed api key")
	}
	row, err := h.store.LookupAPIKey(r.Context(), k.Prefix)
	if err != nil {
		if errors.Is(err, store.ErrKeyInactive) {
			return nil, errors.New("api key is disabled or revoked")
		}
		if errors.Is(err, store.ErrKeyExpired) {
			return nil, errors.New("api key expired")
		}
		if errors.Is(err, store.ErrKeyScope) {
			return nil, errors.New("api key's workspace, project or environment is not active")
		}
		// A lookup FAILURE (bad SQL, missing column) is not "invalid api key":
		// say so loudly here while the client still gets the no-key-oracle
		// answer below (spec §3).
		if !errors.Is(err, store.ErrNotFound) {
			log.Printf("[proxy] api key lookup failed for prefix %s: %v", k.Prefix, err)
			return nil, errors.New("invalid api key")
		}
		return nil, errors.New("invalid api key")
	}
	if !keys.Equal(row.KeyHash, keys.Hash(k.Secret)) {
		return nil, errors.New("invalid api key")
	}
	return row, nil
}

// bearerOrAPIKey extracts the raw key from whichever carrier the client used.
// `Authorization: Bearer <key>` wins when present (the [OI] convention); a bare
// `x-api-key: <key>` is the Anthropic convention. A missing/blank pair is the
// only case that reports "missing bearer token" so the 401 body stays stable
// for clients that only ever send one of them.
func bearerOrAPIKey(r *http.Request) (string, error) {
	if auth := r.Header.Get("Authorization"); auth != "" {
		if !strings.HasPrefix(auth, "Bearer ") {
			return "", errors.New("missing bearer token")
		}
		return strings.TrimPrefix(auth, "Bearer "), nil
	}
	if k := r.Header.Get("x-api-key"); k != "" {
		return k, nil
	}
	return "", errors.New("missing bearer token")
}

// shouldFailover reports whether ANOTHER pooled account could plausibly turn
// this upstream status into a success. A 401/403 is a dead credential and a 429
// is a per-account throttle or quota: both belong to the account that produced
// them. A 502/503/504 is the upstream itself misbehaving (every account shares
// it, but a retry can still land on a healthy instance). Everything else
// (400/404/422...) is request-shaped - another credential changes nothing.
//
// Kept as the failover predicate for the account pool INSIDE one candidate;
// candidate-level fallback (spec §9) is internal/routing.Execute, which
// classifies with routing.ClassifyRetryable.
func shouldFailover(code int) bool {
	switch code {
	case http.StatusUnauthorized, http.StatusForbidden, http.StatusTooManyRequests,
		http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	}
	return false
}

// parksAccount reports whether a failoverable status blames THIS account. 401/403
// (dead credential) and 429 (per-account throttle) do, so the account is parked
// for failCooldown instead of being re-probed by every later request. 5xx does
// NOT: the whole pool shares one upstream, and parking every account during a
// provider-wide outage would empty the pool for five minutes and turn a blip
// into an outage.
func parksAccount(code int) bool {
	return code == http.StatusUnauthorized || code == http.StatusForbidden ||
		code == http.StatusTooManyRequests
}
