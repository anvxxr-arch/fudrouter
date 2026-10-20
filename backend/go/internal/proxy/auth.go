package proxy

import (
	"errors"
	"log"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/keys"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
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
		return nil, h.authFail(r, err)
	}
	k, ok := keys.Parse(raw)
	if !ok {
		return nil, h.authFail(r, errors.New("malformed api key"))
	}
	row, err := h.store.LookupAPIKey(r.Context(), k.Prefix)
	if err != nil {
		if errors.Is(err, store.ErrKeyInactive) {
			return nil, h.authFail(r, errors.New("api key is disabled or revoked"))
		}
		if errors.Is(err, store.ErrKeyExpired) {
			return nil, h.authFail(r, errors.New("api key expired"))
		}
		if errors.Is(err, store.ErrKeyScope) {
			return nil, h.authFail(r, errors.New("api key's workspace, project or environment is not active"))
		}
		// A lookup FAILURE (bad SQL, missing column) is not "invalid api key":
		// say so loudly here while the client still gets the no-key-oracle
		// answer below (spec §3).
		if !errors.Is(err, store.ErrNotFound) {
			log.Printf("[proxy] api key lookup failed for prefix %s: %v", k.Prefix, err)
			return nil, h.authFail(r, errors.New("invalid api key"))
		}
		return nil, h.authFail(r, errors.New("invalid api key"))
	}
	if !keys.Equal(row.KeyHash, keys.Hash(k.Secret)) {
		return nil, h.authFail(r, errors.New("invalid api key"))
	}
	return row, nil
}

// errAuthRateLimited signals that one client IP burned through its
// failed-authentication budget. Mapped to 429 RATE_LIMITED by begin —
// authenticate runs before limiter.Check, so without this a key-guessing
// loop never touches any counter.
var errAuthRateLimited = errors.New("too many failed authentication attempts")

// authFail records one failed authentication from the caller and returns the
// error the client should see: the original failure, or errAuthRateLimited
// once the IP passes 30 failures/minute. A Valkey outage degrades to the
// original error (fail-open would hide a brute force; failing closed would
// turn a cache blip into a 429 storm — the original 401 stays truthful
// either way). Only the prefix is ever logged, never the secret.
func (h *Handler) authFail(r *http.Request, err error) error {
	// M-a: the limiter is keyed on the SOCKET PEER, not clientIP(r). clientIP
	// walks X-Forwarded-For, which a caller behind the trusted proxy can set
	// to a fresh value per request — each forged IP got its own 30/min budget
	// and the brute-force cap enforced nothing. The peer host is the one
	// identity the client cannot forge; the budget stays 30/min.
	peer, _, perr := net.SplitHostPort(r.RemoteAddr)
	if perr != nil {
		peer = r.RemoteAddr
	}
	ok, rerr := h.vk.AllowRate(r.Context(), "rl:authfail:"+peer, 30, time.Minute)
	if rerr != nil {
		return err
	}
	if !ok {
		return errAuthRateLimited
	}
	return err
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
