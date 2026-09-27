package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// refreshLead is how far before expiry a token is proactively exchanged. xAI
// access tokens live 6h; refreshing a few minutes early avoids racing expiry
// mid-request.
const refreshLead = 5 * time.Minute

// failCooldown is how long an account is skipped after a failed refresh, so one
// revoked account is not retried on every single request.
const failCooldown = 5 * time.Minute

// maxPickAttempts caps how many accounts one Pick may probe.
//
// A pool is walked round-robin until an account yields a token. When a
// provider is dead — revoked refresh tokens, an upstream 403 on every account,
// a mass session invalidation — the walk is the entire cost of the request and
// the client pays all of it: one HTTP round trip per account, serially. On the
// live xAI farm (663 accounts, ~150ms per refresh) a single request spent 99.652
// seconds learning that the pool was dead, 83% of the 120s non-streaming
// upstream budget, before it ever reached the upstream.
//
// The outer failover loop already caps its own attempts at 3, so this bound
// does not reduce the number of accounts a healthy request can reach: a
// working account is found within the first few probes. It only stops the walk
// from being unbounded when nothing works.
const maxPickAttempts = 20

// pickBudget bounds the wall-clock time one Pick may spend on refreshes.
//
// A deadline is honoured, not relied upon as the only guard: with
// maxPickAttempts alone a single slow upstream (30s http.Client timeout) could
// still cost 20 x 30s. The bound is a fraction of the tightest upstream budget
// (nonStreamTimeout, 120s) so a credential search cannot consume the whole
// request. See proxy.go: the caller hands Pick the request context, which
// carries no deadline, so Pick must bound itself.
//
// Sized against measurement, not taste: a refresh costs ~150ms live
// (DEEPDIVE-pool-walk-2026-09-26), so a full capped walk of 20 costs ~3s. 5s
// leaves headroom for a slow upstream while staying far below the 120s it is
// charged to, and below the 30s the refresh client itself allows.
const pickBudget = 5 * time.Second

// account is one upstream identity inside a provider's credential blob.
type account struct {
	Email        string `json:"email"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	IDToken      string `json:"id_token"`
	Expired      string `json:"expired"`
}

// credentials is the decrypted provider credential blob.
//
// `default_headers` carries upstream requirements that are not auth — e.g. the
// xAI Grok CLI proxy rejects every chat completion without
// `x-grok-client-version`.
//
// `accounts` is the OAuth pool. `api_key` is retained for providers that are a
// single static key, and for a blob written before the pool existed.
//
// `protocol` selects the upstream wire protocol. Empty means the default
// [OI] passthrough (POST {base_url}/chat/completions with a Bearer token).
// "freebuff" means the Codebuff/Freebuff private protocol, which needs a
// session, an agent run, and codebuff_metadata injection — see
// internal/freebuff.
type credentials struct {
	APIKey         string            `json:"api_key"`
	AuthKind       string            `json:"auth_kind"`
	Protocol       string            `json:"protocol"`
	DefaultHeaders map[string]string `json:"default_headers"`
	Accounts       []account         `json:"accounts"`
}

// ProtocolFreebuff selects the native Codebuff/Freebuff upstream protocol.
const ProtocolFreebuff = "freebuff"

// TokenRefresher exchanges a refresh token for a fresh access token.
//
// xAI rotates the refresh token on every exchange, so the returned refresh
// value MUST be persisted: dropping it kills the account at the next expiry.
type TokenRefresher interface {
	Refresh(ctx context.Context, refreshToken string) (accessToken, nextRefreshToken string, expiresIn int, err error)
}

// poolAccount is one account plus its refresh state.
type poolAccount struct {
	mu        sync.Mutex
	data      account
	expiresAt time.Time
	deadUntil time.Time
}

// Pool round-robins a provider's accounts and keeps their tokens fresh.
//
// Before this existed the data plane used `api_key` — a single access token —
// so a provider built from a farm of accounts silently behaved like a
// one-account provider, and died outright when that token expired (xAI tokens
// last 6h and nothing refreshed them).
type Pool struct {
	mu             sync.Mutex
	accounts       []*poolAccount
	next           int
	fallbackAPIKey string
	protocol       string
	authKind       string
	defaultHeaders map[string]string
	refresher      TokenRefresher
	encrypt        func(plaintext string) (string, error)
	persist        func(ctx context.Context, blob string) error

	// load re-reads the provider's credential blob, so save can merge into the
	// CURRENT state instead of overwriting it — see the note on save. Nil means
	// "write the snapshot", the older and lossier behaviour.
	load func(ctx context.Context) (credentials, error)

	// loadedAt bounds how long a built pool is trusted. Anything outside this
	// process can rewrite the blob (an import, a maintenance rotation), and a
	// pool that is never rebuilt keeps serving tokens that were rotated away —
	// which is exactly how 362 accounts read as unusable until a restart.
	loadedAt time.Time
}

// newPool builds a rotation pool from a decrypted blob.
func newPool(
	cred credentials,
	refresher TokenRefresher,
	encrypt func(plaintext string) (string, error),
	persist func(ctx context.Context, blob string) error,
	load func(ctx context.Context) (credentials, error),
) *Pool {
	p := &Pool{
		loadedAt:       time.Now(),
		load:           load,
		fallbackAPIKey: cred.APIKey,
		protocol:       cred.Protocol,
		authKind:       cred.AuthKind,
		defaultHeaders: cred.DefaultHeaders,
		refresher:      refresher,
		encrypt:        encrypt,
		persist:        persist,
	}
	for _, a := range cred.Accounts {
		p.accounts = append(p.accounts, &poolAccount{data: a, expiresAt: parseExpiry(a.Expired)})
	}
	return p
}

// parseExpiry reads the blob's `expired` field. A missing or unparseable value
// is treated as already expired, which forces a refresh — the safe direction.
func parseExpiry(s string) time.Time {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}
	}
	for _, layout := range []string{
		time.RFC3339Nano, time.RFC3339,
		"2006-01-02T15:04:05Z", "2006-01-02T15:04:05.000Z",
	} {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

// Picked is one credential selection.
type Picked struct {
	Token string
	Email string
}

// Pick returns a usable credential, refreshing it when needed. Accounts are
// tried round-robin so load spreads across the pool; an account that cannot be
// refreshed is skipped until its cooldown expires.
func (p *Pool) Pick(ctx context.Context) (Picked, error) {
	p.mu.Lock()
	n := len(p.accounts)
	if n == 0 {
		key := p.fallbackAPIKey
		p.mu.Unlock()
		if key == "" {
			return Picked{}, errors.New("provider has no credentials")
		}
		return Picked{Token: key, Email: "(static api_key)"}, nil
	}
	start := p.next
	p.next = (p.next + 1) % n
	p.mu.Unlock()

	var lastErr error
	// Bound the walk twice, in the unit that actually costs money: round trips
	// and wall clock. The caller passes the request context, which carries no
	// deadline (the non-streaming budget is applied to upCtx, not to
	// r.Context()), so Pick cannot inherit one and must impose its own.
	walkCtx, cancelWalk := context.WithTimeout(ctx, pickBudget)
	defer cancelWalk()

	// spent counts round trips; scanned counts accounts examined. A cooling-down
	// account or a live token is answered locally, so it advances scanned
	// without advancing spent — that is what lets a pool of 600 dead accounts
	// still reach the one healthy account without exhausting the budget.
	spent, scanned := 0, 0
	for i := 0; i < n; i++ {
		if spent >= maxPickAttempts {
			log.Printf("[proxy] pool walk stopped at the cap: %d round trip(s) spent, %d of %d account(s) examined",
				spent, scanned, n)
			break
		}
		select {
		case <-walkCtx.Done():
			log.Printf("[proxy] pool walk stopped after %v: %d of %d account(s) examined, %d round trip(s) spent: %v",
				pickBudget, scanned, n, spent, walkCtx.Err())
			lastErr = walkCtx.Err()
			scanned = n
		default:
		}
		if scanned >= n {
			break
		}
		a := p.accounts[(start+i)%n]
		scanned++
		tok, rotated, err := a.token(walkCtx, p.refresher, &spent)
		if err != nil {
			lastErr = err
			continue
		}
		if rotated {
			// Detach from the request context: xAI rotates the refresh token on
			// every exchange, so a failed write here kills the account at its
			// next expiry. With the request context, a client that disconnects
			// mid-request cancels the write and the rotated token is lost
			// silently — the request itself still succeeded, so nothing
			// surfaces the loss. Bounded so a wedged DB cannot block the pool.
			saveCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			err := p.save(saveCtx)
			cancel()
			if err != nil {
				// The request still succeeds; only durability is at risk.
				log.Printf("[proxy] persisting rotated credentials failed: %v", err)
			}
		}
		return Picked{Token: tok, Email: a.data.Email}, nil
	}
	if lastErr == nil {
		lastErr = errors.New("no usable account")
	}
	// Say what actually happened. "all N unusable" would be false once the cap
	// or the budget stops the walk early, and that inflated count is exactly
	// what makes a bounded failure look like a whole-pool outage in the logs.
	if scanned < n {
		return Picked{}, fmt.Errorf("%d of %d account(s) examined, %d refresh(es) attempted, all unusable (walk bounded): %w",
			scanned, n, spent, lastErr)
	}
	return Picked{}, fmt.Errorf("all %d account(s) unusable: %w", n, lastErr)
}

// token returns a valid access token, refreshing it when it is near expiry. The
// second result reports whether the stored refresh token changed, so the caller
// knows the blob must be written back.
//
// A false result here is cheap: a cooling-down account and an already-live
// token are both answered from local state, with no HTTP round trip. Only the
// paths that call r.Refresh cost a request. Pick's walk cap must be measured in
// round trips, not in iterations, or a pool of 600 dead accounts would exhaust
// the cap on free probes and never reach the one healthy account at the back.
// cost, if non-nil, is incremented once per round trip actually attempted.
func (a *poolAccount) token(ctx context.Context, r TokenRefresher, cost *int) (string, bool, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if time.Now().Before(a.deadUntil) {
		return "", false, fmt.Errorf("%s: cooling down after a failed refresh", a.data.Email)
	}
	// Valid well past the lead window: no exchange needed.
	if a.data.AccessToken != "" && time.Now().Add(refreshLead).Before(a.expiresAt) {
		return a.data.AccessToken, false, nil
	}
	if a.data.RefreshToken == "" {
		if a.data.AccessToken != "" && time.Now().Before(a.expiresAt) {
			return a.data.AccessToken, false, nil
		}
		return "", false, fmt.Errorf("%s: access token expired and no refresh token", a.data.Email)
	}
	if r == nil {
		return "", false, fmt.Errorf("%s: token expired and no refresher configured", a.data.Email)
	}

	if cost != nil {
		*cost++
	}
	access, refresh, expiresIn, err := r.Refresh(ctx, a.data.RefreshToken)
	if err != nil {
		a.deadUntil = time.Now().Add(failCooldown)
		return "", false, fmt.Errorf("%s: refresh failed: %w", a.data.Email, err)
	}
	if access == "" {
		a.deadUntil = time.Now().Add(failCooldown)
		return "", false, fmt.Errorf("%s: refresh returned no access token", a.data.Email)
	}

	a.data.AccessToken = access
	rotated := false
	if refresh != "" && refresh != a.data.RefreshToken {
		a.data.RefreshToken = refresh
		rotated = true
	}
	if expiresIn <= 0 {
		expiresIn = 21600
	}
	a.expiresAt = time.Now().Add(time.Duration(expiresIn) * time.Second)
	a.data.Expired = a.expiresAt.UTC().Format("2006-01-02T15:04:05Z")
	a.deadUntil = time.Time{}
	return access, rotated, nil
}

// expiryAtLeast reports whether a is at least as fresh as b. Parsing first, and
// the raw strings as a fallback: a maintainer can write an expiry this parser
// does not know, and lexicographic order is still right for ISO-8601 where
// "always prefer one side" would confidently keep a stale token.
func expiryAtLeast(a, b string) bool {
	if b == "" {
		return true
	}
	if a == "" {
		return false
	}
	ta, tb := parseExpiry(a), parseExpiry(b)
	if !ta.IsZero() && !tb.IsZero() {
		return !ta.Before(tb)
	}
	return a >= b
}

// mergeAccounts overlays `ours` onto `theirs` by email. Both sides describe the
// same accounts; the copy whose access token expires later is the one that
// rotated more recently, so it wins. Ties keep ours. Entries only `theirs` has
// are preserved — they come from a writer that saw accounts this pool never had.
func mergeAccounts(ours, theirs []account) []account {
	if len(theirs) == 0 {
		return ours
	}
	out := make([]account, len(theirs))
	copy(out, theirs)
	idx := make(map[string]int, len(out))
	for i, a := range out {
		idx[a.Email] = i
	}
	for _, a := range ours {
		j, ok := idx[a.Email]
		if !ok {
			idx[a.Email] = len(out)
			out = append(out, a)
			continue
		}
		if expiryAtLeast(a.Expired, out[j].Expired) {
			out[j] = a
		}
	}
	return out
}

// stale reports whether the pool was built long enough ago that it should be
// rebuilt from the provider's current blob.
func (p *Pool) stale(now time.Time, ttl time.Duration) bool {
	return now.Sub(p.loadedAt) > ttl
}

// save re-encrypts the blob and hands it to the store.
//
// The snapshot is merged into whatever the store holds NOW rather than
// overwriting it. Two writers persist this column — the router's on-demand
// refresh and a maintenance rotation — and a blind overwrite drops whichever
// rotation landed first, which is how an account loses its live refresh chain.
func (p *Pool) save(ctx context.Context) error {
	if p.persist == nil || p.encrypt == nil {
		return nil
	}
	p.mu.Lock()
	snap := make([]account, 0, len(p.accounts))
	for _, a := range p.accounts {
		a.mu.Lock()
		snap = append(snap, a.data)
		a.mu.Unlock()
	}
	p.mu.Unlock()

	if p.load != nil {
		cur, err := p.load(ctx)
		if err != nil {
			log.Printf("[proxy] save: current blob unreadable, writing the snapshot: %v", err)
		} else {
			snap = mergeAccounts(snap, cur.Accounts)
		}
	}

	// protocol and auth_kind must survive a rewrite: dropping protocol turns a
	// freebuff provider into a broken [OI] passthrough on the next rotation.
	kind := p.authKind
	if kind == "" {
		kind = "oauth"
	}
	plain, err := json.Marshal(credentials{
		APIKey:         p.fallbackAPIKey,
		AuthKind:       kind,
		Protocol:       p.protocol,
		DefaultHeaders: p.defaultHeaders,
		Accounts:       snap,
	})
	if err != nil {
		return err
	}
	blob, err := p.encrypt(string(plain))
	if err != nil {
		return err
	}
	return p.persist(ctx, blob)
}

// MarkFailed parks the account holding this access token. Called when the
// upstream rejects a credential (401/403), so the next request tries a
// different account instead of repeating the failure.
func (p *Pool) MarkFailed(accessToken string) {
	if accessToken == "" {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, a := range p.accounts {
		a.mu.Lock()
		if a.data.AccessToken == accessToken {
			a.deadUntil = time.Now().Add(failCooldown)
		}
		a.mu.Unlock()
	}
}

// Accounts returns a snapshot, for diagnostics and tests.
func (p *Pool) Accounts() []account {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]account, 0, len(p.accounts))
	for _, a := range p.accounts {
		a.mu.Lock()
		out = append(out, a.data)
		a.mu.Unlock()
	}
	return out
}

// XAIRefresher performs the RFC 6749 refresh_token grant against xAI.
//
// The client_id is the public Grok CLI client — the same one the token's own
// `aud` claim carries, and the same one the farm used. It is not a secret.
type XAIRefresher struct {
	Client   *http.Client
	Endpoint string
	ClientID string
}

func NewXAIRefresher() *XAIRefresher {
	return &XAIRefresher{
		Client:   &http.Client{Timeout: 30 * time.Second},
		Endpoint: envOr("XAI_TOKEN_ENDPOINT", "https://auth.x.ai/oauth2/token"),
		ClientID: envOr("XAI_OAUTH_CLIENT_ID", "b1a00492-073a-47ea-816f-4c329264a828"),
	}
}

func envOr(name, def string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return def
}

func (x *XAIRefresher) Refresh(ctx context.Context, refreshToken string) (string, string, int, error) {
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", refreshToken)
	form.Set("client_id", x.ClientID)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, x.Endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return "", "", 0, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := x.Client.Do(req)
	if err != nil {
		return "", "", 0, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))

	if resp.StatusCode != http.StatusOK {
		return "", "", 0, fmt.Errorf("token endpoint %d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	var out struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", "", 0, fmt.Errorf("token endpoint returned an unparseable body: %w", err)
	}
	return out.AccessToken, out.RefreshToken, out.ExpiresIn, nil
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
