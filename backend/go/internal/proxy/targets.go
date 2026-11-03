package proxy

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/egress"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/routing"
)

// target is one credential materialization for an attempt: the rotation pool
// over every usable credential ROW of a connection (spec §4: one account = one
// credential row), or — for providers whose secrets have not been split yet —
// the unsplit legacy provider blob (kept alive through the migration by spec
// §14 promises 1–2).
type target struct {
	pool     *Pool
	protocol string
	egress   egress.Policy
	// authKind is the connection's `auth_kind` ("bearer"/"oauth"/"noauth").
	// "noauth" means the upstream must receive NO Authorization header at all:
	// some anonymous endpoints (OVHcloud AI Endpoints) answer 403 to any request
	// that carries one, and a 403 would otherwise park a perfectly good row.
	authKind       string
	defaultHeaders map[string]string
	// connID + rateRPM/rateBurst pace THIS connection's traffic when the
	// upstream throttles by source IP (see connlimit.go). 0 rpm = no gate.
	connID       string
	rateRPM      int
	rateBurst    int
	rateWindowMs int
	// legacyCredID is "" for row-based pools (each picked account knows its own
	// row); non-empty only when the whole provider is served by its legacy blob.
	legacyCredID string
}

// targetFor builds (or reuses) the credential material for a candidate.
//
// Every usable credential row becomes ONE account in one connection-level pool,
// so per-account failover (401/403/429 → next account) works across rows AND
// across accounts inside a row's OAuth farm. A rotated token is written back to
// the ROW it came from (pool.persistAccount), never to a neighbour's secret.
func (h *Handler) targetFor(cand *routing.Candidate) *target {
	sc := cand.Store

	// Preferred: credential rows (spec §4).
	if len(sc.Credentials) > 0 {
		merged := credentials{AuthKind: "oauth"}
		var accounts []account
		for _, c := range sc.Credentials {
			plain, err := h.crypt.Decrypt(c.SecretEnc)
			if err != nil {
				log.Printf("[proxy] credential decrypt failed for %s", c.ID)
				continue
			}
			acct, ok := accountFromSecret(plain)
			if !ok {
				log.Printf("[proxy] credential %s malformed", c.ID)
				continue
			}
			acct.CredID = c.ID
			if acct.Email == "" {
				acct.Email = c.Name
			}
			accounts = append(accounts, acct)
		}
		if len(accounts) == 0 {
			return nil
		}
		merged.Accounts = accounts
		// The connection config carries the protocol + shared headers (spec §4).
		applyConnectionConfig(&merged, sc.ConfigJSON)
		// A candidate with no connection config is a silent catastrophe: auth_kind
		// falls back to "oauth" (so a keyless upstream gets an Authorization
		// header and answers 403), auth_type/pacing are lost, and the request
		// fails in a way that looks like the provider's fault. Say it out loud.
		if len(sc.ConfigJSON) == 0 {
			log.Printf("[proxy] WARNING candidate %s/%s has no connection config: authKind=%q rpm=%d",
				sc.ProviderID, sc.ConnectionID, merged.AuthKind, merged.Rpm)
		}

		poolKey := "conn:" + sc.ConnectionID
		if sc.ConnectionID == "" {
			poolKey = "prov:" + sc.ProviderID
		}
		pool := h.poolFor(poolKey, merged, nil, nil)
		pool.setPersistAccount(func(ctx context.Context, credID, plaintext string) error {
			enc, err := h.crypt.Encrypt(plaintext)
			if err != nil {
				return err
			}
			return h.store.UpdateCredentialSecret(ctx, credID, enc)
		})
		return &target{
			pool:           pool,
			egress:         egress.Policy{Mode: sc.EgressMode, StickyTTLSeconds: sc.StickyTTLSeconds, ProxyURL: sc.ProxyURL},
			protocol:       merged.Protocol,
			authKind:       merged.AuthKind,
			defaultHeaders: merged.DefaultHeaders,
			connID:         sc.ConnectionID,
			rateRPM:        merged.Rpm,
			rateBurst:      merged.Burst,
			rateWindowMs:   merged.WindowMs,
		}
	}

	// Legacy fallback: the unsplit provider blob (S0 providers through the
	// migration). Its protocol/headers live in the blob itself.
	if sc.LegacyBlob == "" {
		return nil
	}
	plain, err := h.crypt.Decrypt(sc.LegacyBlob)
	if err != nil {
		log.Printf("[proxy] legacy credential decrypt failed for provider %s", sc.ProviderID)
		return nil
	}
	var cred credentials
	if err := json.Unmarshal([]byte(plain), &cred); err != nil {
		log.Printf("[proxy] legacy credential blob malformed for provider %s", sc.ProviderID)
		return nil
	}
	if cred.APIKey == "" && len(cred.Accounts) == 0 {
		return nil
	}
	persist := func(ctx context.Context, blob string) error {
		enc, err := h.crypt.Encrypt(blob)
		if err != nil {
			return err
		}
		return h.store.UpdateProviderCredentials(ctx, sc.ProviderID, enc)
	}
	load := func(ctx context.Context) (credentials, error) {
		enc, err := h.store.ProviderCredentials(ctx, sc.ProviderID)
		if err != nil {
			return credentials{}, err
		}
		plain, err := h.crypt.Decrypt(enc)
		if err != nil {
			return credentials{}, err
		}
		var out credentials
		if err := json.Unmarshal([]byte(plain), &out); err != nil {
			return credentials{}, err
		}
		return out, nil
	}
	pool := h.poolFor("prov:"+sc.ProviderID, cred, persist, load)
	return &target{
		pool:           pool,
		egress:         egress.Policy{Mode: sc.EgressMode, StickyTTLSeconds: sc.StickyTTLSeconds, ProxyURL: sc.ProxyURL},
		protocol:       cred.Protocol,
		authKind:       cred.AuthKind,
		defaultHeaders: cred.DefaultHeaders,
		connID:         sc.ConnectionID,
		rateRPM:        cred.Rpm,
		rateBurst:      cred.Burst,
		rateWindowMs:   cred.WindowMs,
	}
}

// accountFromSecret normalizes ONE credential row's plaintext (spec §4: "one
// account JSON" — either {"api_key"} or the OAuth account fields) into a pool
// account. A static api_key becomes an account holding it as a long-lived
// access token, so one pool serves rows and OAuth farms alike.
func accountFromSecret(plain string) (account, bool) {
	var row struct {
		APIKey       string `json:"api_key"`
		Email        string `json:"email"`
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		IDToken      string `json:"id_token"`
		Expired      string `json:"expired"`
	}
	if err := json.Unmarshal([]byte(plain), &row); err != nil {
		return account{}, false
	}
	switch {
	case row.AccessToken != "" || row.RefreshToken != "":
		return account{
			Email:        row.Email,
			AccessToken:  row.AccessToken,
			RefreshToken: row.RefreshToken,
			IDToken:      row.IDToken,
			Expired:      row.Expired,
		}, true
	case row.APIKey != "":
		// A static key has no expiry: it lives until the row is disabled.
		return account{Email: row.Email, AccessToken: row.APIKey, Expired: "2099-01-01T00:00:00Z"}, true
	}
	return account{}, false
}

// applyConnectionConfig overlays the connection's shared config onto a
// per-account secret (spec §4: protocol/default_headers/auth_kind live on the
// CONNECTION, the account JSON carries only its own secrets).
func applyConnectionConfig(cred *credentials, configJSON []byte) {
	if len(configJSON) == 0 {
		return
	}
	var cfg struct {
		Protocol       string            `json:"protocol"`
		AuthKind       string            `json:"auth_kind"`
		DefaultHeaders map[string]string `json:"default_headers"`
		Rpm            int               `json:"rpm"`
		Burst          int               `json:"burst"`
		WindowMs       int               `json:"window_ms"`
		OAuthEndpoint  string            `json:"oauth_endpoint"`
		OAuthClientID  string            `json:"oauth_client_id"`
	}
	if err := json.Unmarshal(configJSON, &cfg); err != nil {
		return
	}
	if cred.Protocol == "" {
		cred.Protocol = cfg.Protocol
	}
	// A connection-specific OAuth token endpoint (non-xAI provider) is assigned,
	// never defaulted: it must override the handler-level xAI refresher.
	cred.OAuthEndpoint = cfg.OAuthEndpoint
	cred.OAuthClientID = cfg.OAuthClientID
	// auth_kind is the connection's call, not a default: the pool seeds
	// AuthKind="oauth" for credential rows, so an "only if empty" rule meant a
	// connection could never declare itself keyless. An explicit config always wins.
	if cfg.AuthKind != "" {
		cred.AuthKind = cfg.AuthKind
	}
	// Pacing is connection policy, not account state: it must survive the
	// per-account secret overlay, so it is assigned, never merged.
	if cfg.Rpm > 0 {
		cred.Rpm = cfg.Rpm
	}
	if cfg.Burst > 0 {
		cred.Burst = cfg.Burst
	}
	if cfg.WindowMs > 0 {
		cred.WindowMs = cfg.WindowMs
	}
	if cred.DefaultHeaders == nil {
		cred.DefaultHeaders = cfg.DefaultHeaders
	} else {
		for k, v := range cfg.DefaultHeaders {
			if _, ok := cred.DefaultHeaders[k]; !ok {
				cred.DefaultHeaders[k] = v
			}
		}
	}
}

// parseRetryAfter reads an upstream Retry-After hint in seconds.
//
// RFC 9110 allows two forms: delta-seconds ("120") and an HTTP-date
// ("Wed, 21 Oct 2026 07:28:00 GMT"). Both are accepted; anything else, a
// negative value, or a date in the past returns 0, which parkCredential reads
// as "use the 60s default".
//
// Why this exists: parkCredential has always accepted a retryAfterSeconds hint
// and lifecycle.go has always relayed Attempt.RetryAfterSeconds to the client,
// but NOTHING ever set the field — so a provider answering `retry-after: 3600`
// was retried 60x too early and one answering `retry-after: 5` was benched 12x
// too long. The 402 path hardcoded 900s for the same reason. The plumbing was
// complete; only the parse was missing.
//
// The value is clamped to 24h: a provider reporting a multi-day reset would
// otherwise take a credential out of rotation for that whole span on a single
// 429, and a clock-skewed HTTP-date could park it for years.
func parseRetryAfter(v string) int {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0
	}
	if secs, err := strconv.Atoi(v); err == nil {
		return clampRetryAfter(secs)
	}
	if t, err := http.ParseTime(v); err == nil {
		return clampRetryAfter(int(time.Until(t).Seconds()))
	}
	return 0
}

// clampRetryAfter bounds a hint to [0, 24h]. A non-positive value means "no
// usable hint" so the caller falls back to its default.
func clampRetryAfter(secs int) int {
	if secs <= 0 {
		return 0
	}
	if secs > 24*60*60 {
		return 24 * 60 * 60
	}
	return secs
}

// classify402 turns a 402 response BODY into a park duration in seconds.
//
// A 402 is not one fact. Free-tier providers hand out two very different
// rejections under the same status code, and parking both for the same
// hardcoded 15 minutes wastes the pool either way:
//
//	"used today's Free usage. It resets in 2h 11m"  -> a DAILY cap that comes
//	   back at a fixed wall-clock boundary. Parking 15 minutes retries the key
//	   9 times before it can possibly work, and every retry is a burned
//	   rotation slot the rest of the pool pays for. Park until the reset.
//
//	"used all your included credits. Top up"        -> the plan is gone. It
//	   never recovers on its own, so any cooldown is a lie; the caller parks it
//	   as 'invalid' instead of 'rate_limited'.
//
//	anything else                                   -> the generic
//	   out-of-budget answer: keep the historical 15-minute bench.
//
// Returns (seconds, permanent).
func classify402(body []byte) (int, bool) {
	// A permanent balance fact is permanent at ANY status code. freemodel.in
	// reports it as 429, other providers as 402; sharing the classifier keeps
	// the two paths from disagreeing (measured: this function used to answer
	// (900, false) — a 15-minute bench — for a drained balance, so the row
	// came back after the bench and failed again).
	if permanentQuotaFailure(body) {
		return 0, true
	}
	low := strings.ToLower(string(body))
	if strings.Contains(low, "today's free usage") || strings.Contains(low, "todays free usage") {
		return secondsUntilUTCReset(low), false
	}
	return 900, false
}

// permanentQuotaFailure reports whether a non-2xx body describes a balance that
// cannot recover on its own, whatever status code the provider wrapped it in.
//
// freemodel.in answers an exhausted free-tier balance with HTTP 429 and
// "Token balance exhausted. You have 0 tokens remaining and insufficient
// credit balance." That is a permanent fact about the account, but 429
// classifies as a per-account THROTTLE, so the row was parked 'rate_limited'
// for the 60s default and came straight back into rotation: measured 51
// attempts in one hour returning 429 while 146 freshly-imported credentials in
// the same pool recorded zero uses. classify402 already makes this judgement
// for providers that use 402; this is the same call for those that use 429.
func permanentQuotaFailure(body []byte) bool {
	low := strings.ToLower(string(body))
	for _, marker := range []string{
		"insufficient credit balance",
		"token balance exhausted",
		"0 tokens remaining",
		"included credits",
	} {
		if strings.Contains(low, marker) {
			return true
		}
	}
	return false
}

// secondsUntilUTCReset reads the provider's own "resets in 2h 11m" hint and
// converts it to a duration. Falling back to the next 00:00 UTC when the body
// carries no parsable hint keeps the daily-cap behaviour honest: the cap is
// wall-clock aligned even when the message is not.
func secondsUntilUTCReset(low string) int {
	// "resets in 2h 11m" / "resets in 47m" / "resets in 1h"
	if i := strings.Index(low, "resets in "); i >= 0 {
		rest := low[i+len("resets in "):]
		if end := strings.IndexAny(rest, ".,;)"); end >= 0 {
			rest = rest[:end]
		}
		var total int
		var matched bool
		for _, part := range strings.Fields(rest) {
			if len(part) < 2 {
				continue
			}
			n, err := strconv.Atoi(part[:len(part)-1])
			if err != nil || n < 0 {
				continue
			}
			switch part[len(part)-1] {
			case 'h':
				total += n * 3600
				matched = true
			case 'm':
				total += n * 60
				matched = true
			case 's':
				total += n
				matched = true
			}
		}
		// A hint under a minute is almost certainly a rounding artifact; give
		// the key a full minute rather than parking it for 0 and re-picking it
		// on the very next request.
		if matched {
			if total < 60 {
				return 60
			}
			return clampRetryAfter(total)
		}
	}
	now := time.Now().UTC()
	next := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC).Add(24 * time.Hour)
	return clampRetryAfter(int(next.Sub(now).Seconds()))
}

// parkCredential records a credential row's failure state (spec §4
// `credential.status` + `cooldown_until`) so the candidate query skips it while
// it is unusable. Best-effort: a failure here never fails a request. An empty
// credID (a legacy-blob account) parks nothing — the pool's own cooldown covers
// it.
//
// M-c: rate_limited carries a cooldown too. It used to set only the status, so
// a throttled credential was re-picked FIRST after a pool rebuild and burned
// the request's pick budget on an account the upstream had just refused.
// retryAfterSeconds honours the upstream's Retry-After hint when the caller
// parsed one; 0 falls back to 60s.
func (h *Handler) parkCredential(credID, status string, retryAfterSeconds int) {
	if credID == "" {
		return
	}
	var cooldown *time.Time
	switch status {
	case "auth_failed":
		until := time.Now().Add(5 * time.Minute) // S0 failCooldown
		cooldown = &until
	case "rate_limited":
		secs := retryAfterSeconds
		if secs <= 0 {
			secs = 60
		}
		until := time.Now().Add(time.Duration(secs) * time.Second)
		cooldown = &until
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(context.Background()), 5*time.Second)
	defer cancel()
	if err := h.store.UpdateCredentialState(ctx, credID, status, cooldown); err != nil {
		log.Printf("[proxy] credential state update failed for %s: %v", credID, err)
	}
}

// reviveCredential is the missing half of parkCredential: a 2xx is proof the
// credential works right now, which is exactly the claim 'invalid' makes. F3:
// a transient 401 parked the credential 'invalid' with cooldown_until NULL, and
// the ONLY revival was the hourly credential_validation fan-out — up to an hour
// of silently lost capacity. The data plane already knows the credential works
// (it just served the 200) and now records it.
//
// Detached in a goroutine, UNLIKE parkCredential, which blocks its caller.
// parkCredential runs on the error path — the request is already failing and
// about to walk to another candidate — so a 5s write there costs nothing. This
// runs on the SUCCESS path, where the response is about to be written; a
// synchronous write would add a DB round trip to every 200.
func (h *Handler) reviveCredential(credID string) {
	if credID == "" || h.store == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(context.Background()), 5*time.Second)
		defer cancel()
		if err := h.store.MarkCredentialHealthy(ctx, credID); err != nil {
			log.Printf("[proxy] credential revive failed for %s: %v", credID, err)
		}
	}()
}

// credentialStatus reports the status the candidate query loaded for credID, or
// "" when the credential is not on this candidate. The pool is built from the
// candidate's credential rows (targetFor sets acct.CredID = c.ID), so the
// account that served is on this list in the normal case.
func credentialStatus(cand *routing.Candidate, credID string) string {
	if cand == nil || cand.Store == nil || credID == "" {
		return ""
	}
	for _, c := range cand.Store.Credentials {
		if c.ID == credID {
			return c.Status
		}
	}
	return ""
}

// parseUsage pulls the provider's reported usage out of a JSON response,
// tolerating both the [OI] `usage` shape and the `input_tokens`/`output_tokens`
// variant (PRD §87: the router bills what the provider reports).
func parseUsage(b []byte) (usageCounts, bool) {
	var parsed struct {
		Usage *struct {
			PromptTokens     int64 `json:"prompt_tokens"`
			CompletionTokens int64 `json:"completion_tokens"`
			InputTokens      int64 `json:"input_tokens"`
			OutputTokens     int64 `json:"output_tokens"`
			TotalTokens      int64 `json:"total_tokens"`
			PromptDetails    struct {
				CachedTokens int64 `json:"cached_tokens"`
			} `json:"prompt_tokens_details"`
			CompletionDetails struct {
				ReasoningTokens int64 `json:"reasoning_tokens"`
			} `json:"completion_tokens_details"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(b, &parsed); err != nil || parsed.Usage == nil {
		return usageCounts{}, false
	}
	u := usageCounts{
		TokensIn:          parsed.Usage.PromptTokens,
		TokensOut:         parsed.Usage.CompletionTokens,
		TotalTokens:       parsed.Usage.TotalTokens,
		ReasoningTokens:   parsed.Usage.CompletionDetails.ReasoningTokens,
		CachedInputTokens: parsed.Usage.PromptDetails.CachedTokens,
	}
	if u.TokensIn == 0 {
		u.TokensIn = parsed.Usage.InputTokens
	}
	if u.TokensOut == 0 {
		u.TokensOut = parsed.Usage.OutputTokens
	}
	return u, true
}

// keylessAuth reports whether a connection's credential is a placeholder, i.e.
// there is no real secret that a 401/403 could legitimately reject.
//
// Two flavours exist and they point in opposite directions:
//   - "noauth"      the upstream must receive NO Authorization header — OVHcloud
//     AI Endpoints answers 403 "authentication failed" to any request carrying one
//   - "placeholder" the upstream demands the header but never validates the value —
//     pollinations.ai answers 401 to a headerless request
//
// In both cases a rejection must not park the row, or a healthy keyless provider
// disappears from the catalog until its cooldown expires.
func keylessAuth(kind string) bool {
	return kind == "noauth" || kind == "placeholder"
}
