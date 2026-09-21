package oauth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	XAIClientIDFallback = "b1a00492-073a-47ea-816f-4c329264a828"
	XAIIssuer           = "https://auth.x.ai"
	XAIAuthorizePath    = "/oauth2/authorize"
	XAITokenPath        = "/oauth2/token"
	XAIDiscoveryPath    = "/.well-known/openid-configuration"
	XAIScope            = "openid profile email offline_access grok-cli:access api:access"
	XAIAPIBase          = "https://api.x.ai/v1"
	XAILoopbackPort     = 56121
	XAICallbackPath     = "/callback"
	XAIVerifierBytes    = 96
)

type xaiDiscovery struct {
	AuthorizeURL string
	TokenURL     string
}

var (
	xaiDiscMu  sync.Mutex
	xaiDisc    *xaiDiscovery
	httpClient = &http.Client{Timeout: 30 * time.Second}
)

func validateXAIEndpoint(raw, field string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "https" {
		return "", fmt.Errorf("xai discovery %s invalid", field)
	}
	host := strings.ToLower(u.Hostname())
	if host != "x.ai" && !strings.HasSuffix(host, ".x.ai") {
		return "", fmt.Errorf("xai discovery %s host %s not on x.ai", field, host)
	}
	return u.String(), nil
}

func DiscoverXAI(ctx context.Context) (xaiDiscovery, error) {
	xaiDiscMu.Lock()
	defer xaiDiscMu.Unlock()
	if xaiDisc != nil {
		return *xaiDisc, nil
	}
	fallback := xaiDiscovery{
		AuthorizeURL: XAIIssuer + XAIAuthorizePath,
		TokenURL:     XAIIssuer + XAITokenPath,
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, XAIIssuer+XAIDiscoveryPath, nil)
	if err != nil {
		xaiDisc = &fallback
		return fallback, nil
	}
	req.Header.Set("Accept", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil || resp.StatusCode >= 300 {
		if resp != nil {
			resp.Body.Close()
		}
		xaiDisc = &fallback
		return fallback, nil
	}
	defer resp.Body.Close()
	var body struct {
		AuthorizationEndpoint string `json:"authorization_endpoint"`
		TokenEndpoint         string `json:"token_endpoint"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		xaiDisc = &fallback
		return fallback, nil
	}
	au, err1 := validateXAIEndpoint(body.AuthorizationEndpoint, "authorization_endpoint")
	tu, err2 := validateXAIEndpoint(body.TokenEndpoint, "token_endpoint")
	if err1 != nil || err2 != nil {
		xaiDisc = &fallback
		return fallback, nil
	}
	d := xaiDiscovery{AuthorizeURL: au, TokenURL: tu}
	xaiDisc = &d
	return d, nil
}

func BuildXAIAuthURL(authorizeURL, redirectURI, state, challenge string) (string, error) {
	nonce, err := RandomHex(16)
	if err != nil {
		return "", err
	}
	q := url.Values{}
	q.Set("response_type", "code")
	q.Set("client_id", XAIClientIDFallback)
	q.Set("redirect_uri", redirectURI)
	q.Set("scope", XAIScope)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	q.Set("state", state)
	q.Set("nonce", nonce)
	q.Set("plan", "generic")
	q.Set("referrer", "cli-proxy-api")
	return authorizeURL + "?" + q.Encode(), nil
}

func ExchangeXAICode(ctx context.Context, tokenURL, code, redirectURI, verifier string) (map[string]any, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("client_id", XAIClientIDFallback)
	form.Set("code", code)
	form.Set("redirect_uri", redirectURI)
	form.Set("code_verifier", verifier)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("xAI token exchange failed: %s", string(b))
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func RefreshXAI(ctx context.Context, refreshToken string) (map[string]any, error) {
	d, _ := DiscoverXAI(ctx)
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("client_id", XAIClientIDFallback)
	form.Set("refresh_token", refreshToken)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("xAI token refresh failed: %s", string(b))
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func DecodeIDTokenEmail(idToken string) string {
	parts := strings.Split(idToken, ".")
	if len(parts) != 3 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		// try padded
		payload, err = base64.URLEncoding.DecodeString(parts[1])
		if err != nil {
			return ""
		}
	}
	var m map[string]any
	if json.Unmarshal(payload, &m) != nil {
		return ""
	}
	for _, k := range []string{"email", "preferred_username", "sub"} {
		if v, ok := m[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

// StartXAI creates a pending PKCE session. Callback is expected at redirectURI.
func StartXAI(ctx context.Context, store *Store, redirectURI string) (*Pending, error) {
	if redirectURI == "" {
		redirectURI = fmt.Sprintf("http://127.0.0.1:%d%s", XAILoopbackPort, XAICallbackPath)
	}
	d, _ := DiscoverXAI(ctx)
	p, err := NewPending("xai", 10*time.Minute)
	if err != nil {
		return nil, err
	}
	ver, err := PKCEVerifier(XAIVerifierBytes)
	if err != nil {
		return nil, err
	}
	ch := PKCEChallengeS256(ver)
	p.CodeVerifier = ver
	// Use crypto-random state, not session ID (prevents CSRF)
	state, err := RandomState()
	if err != nil {
		return nil, err
	}
	p.State = state
	p.RedirectURI = redirectURI
	authURL, err := BuildXAIAuthURL(d.AuthorizeURL, redirectURI, state, ch)
	if err != nil {
		return nil, err
	}
	p.AuthURL = authURL
	store.Put(p)
	return p, nil
}

func CompleteXAI(ctx context.Context, store *Store, sessionID, code, state string) (*Pending, error) {
	// Look up by state (crypto-random), not session ID
	p, ok := store.GetByState(state)
	if !ok {
		// Fallback: try session ID for backwards compatibility
		p, ok = store.Get(sessionID)
		if !ok || p.Provider != "xai" {
			return nil, fmt.Errorf("xai session not found")
		}
	}
	if state != "" && p.State != "" && state != p.State {
		_, _ = store.Update(p.ID, func(pp *Pending) {
			pp.Status = "error"
			pp.Error = "state mismatch"
		})
		return nil, fmt.Errorf("state mismatch")
	}
	d, _ := DiscoverXAI(ctx)
	tok, err := ExchangeXAICode(ctx, d.TokenURL, code, p.RedirectURI, p.CodeVerifier)
	if err != nil {
		_, _ = store.Update(p.ID, func(pp *Pending) {
			pp.Status = "error"
			pp.Error = err.Error()
		})
		return nil, err
	}
	email := ""
	if idt, ok := tok["id_token"].(string); ok {
		email = DecodeIDTokenEmail(idt)
	}
	result := map[string]any{
		"accessToken":  tok["access_token"],
		"refreshToken": tok["refresh_token"],
		"idToken":      tok["id_token"],
		"tokenType":    tok["token_type"],
		"expiresIn":    tok["expires_in"],
		"email":        email,
		"apiBaseUrl":   XAIAPIBase,
		"provider":     "xai",
		"authType":     "oauth",
	}
	if exp, ok := tok["expires_in"].(float64); ok {
		result["expiresAt"] = time.Now().Add(time.Duration(exp) * time.Second).UTC().Format(time.RFC3339)
	}
	return store.Update(p.ID, func(pp *Pending) {
		pp.Status = "done"
		pp.Result = result
	})
}
