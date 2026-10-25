package proxy

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/routing"
)

// target is one credential materialization for an attempt: the rotation pool
// over every usable credential ROW of a connection (spec §4: one account = one
// credential row), or — for providers whose secrets have not been split yet —
// the unsplit legacy provider blob (kept alive through the migration by spec
// §14 promises 1–2).
type target struct {
	pool           *Pool
	protocol       string
	defaultHeaders map[string]string
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
			protocol:       merged.Protocol,
			defaultHeaders: merged.DefaultHeaders,
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
		protocol:       cred.Protocol,
		defaultHeaders: cred.DefaultHeaders,
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
	}
	if err := json.Unmarshal(configJSON, &cfg); err != nil {
		return
	}
	if cred.Protocol == "" {
		cred.Protocol = cfg.Protocol
	}
	if cred.AuthKind == "" {
		cred.AuthKind = cfg.AuthKind
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
