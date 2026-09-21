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
	"time"
)

const (
	KiroSocialAuthBase = "https://prod.us-east-1.auth.desktop.kiro.dev"
	KiroSocialLogin    = KiroSocialAuthBase + "/login"
	KiroSocialToken    = KiroSocialAuthBase + "/oauth/token"
	KiroSocialRefresh  = KiroSocialAuthBase + "/refreshToken"
	KiroOIDCBase       = "https://oidc.us-east-1.amazonaws.com"
	KiroRegisterClient = KiroOIDCBase + "/client/register"
	KiroDeviceAuth     = KiroOIDCBase + "/device_authorization"
	KiroTokenOIDC      = KiroOIDCBase + "/token"
)

// StartKiroSocial begins Google/GitHub social login for Kiro desktop auth.
// providerHint: "google" | "github"
func StartKiroSocial(store *Store, providerHint string) (*Pending, error) {
	p, err := NewPending("kiro", 15*time.Minute)
	if err != nil {
		return nil, err
	}
	ver, err := PKCEVerifier(32)
	if err != nil {
		return nil, err
	}
	ch := PKCEChallengeS256(ver)
	state := p.ID
	p.CodeVerifier = ver
	p.State = state
	idp := strings.ToLower(providerHint)
	if idp == "" {
		idp = "google"
	}
	q := url.Values{}
	q.Set("idp", idp)
	q.Set("code_challenge", ch)
	q.Set("code_challenge_method", "S256")
	q.Set("state", state)
	// redirect handled by kiro:// deep link or user paste of code
	p.AuthURL = KiroSocialLogin + "?" + q.Encode()
	p.Result = map[string]any{"idp": idp, "flow": "social"}
	store.Put(p)
	return p, nil
}

// ExchangeKiroSocial exchanges authorization code (from kiro:// callback or pasted URL) for tokens.
func ExchangeKiroSocial(ctx context.Context, store *Store, sessionID, code string) (*Pending, error) {
	p, ok := store.Get(sessionID)
	if !ok || p.Provider != "kiro" {
		// also allow completing without session by creating ephemeral
		if sessionID == "" {
			return nil, fmt.Errorf("kiro session required")
		}
		return nil, fmt.Errorf("kiro session not found")
	}
	code = extractKiroCode(code)
	if code == "" {
		return nil, fmt.Errorf("missing authorization code")
	}
	body := map[string]any{
		"code":          code,
		"code_verifier": p.CodeVerifier,
		"redirect_uri":  "kiro://kiro.kiroAgent/authenticate-success",
	}
	raw, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, KiroSocialToken, strings.NewReader(string(raw)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "kiro-cli/1.0.0")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		_, _ = store.Update(sessionID, func(pp *Pending) {
			pp.Status = "error"
			pp.Error = string(b)
		})
		return nil, fmt.Errorf("kiro social exchange failed: %s", string(b))
	}
	var tok map[string]any
	if err := json.Unmarshal(b, &tok); err != nil {
		return nil, err
	}
	access := firstString(tok, "accessToken", "access_token")
	refresh := firstString(tok, "refreshToken", "refresh_token")
	email := DecodeIDTokenEmail(access)
	if email == "" {
		email = DecodeIDTokenEmail(firstString(tok, "idToken", "id_token"))
	}
	expiresIn := firstFloat(tok, "expiresIn", "expires_in")
	result := map[string]any{
		"accessToken":  access,
		"refreshToken": refresh,
		"email":        email,
		"provider":     "kiro",
		"authType":     "oauth",
		"authMethod":   "social",
		"profileArn":   firstString(tok, "profileArn", "profile_arn"),
	}
	if expiresIn > 0 {
		result["expiresAt"] = time.Now().Add(time.Duration(expiresIn) * time.Second).UTC().Format(time.RFC3339)
		result["expiresIn"] = expiresIn
	}
	return store.Update(sessionID, func(pp *Pending) {
		pp.Status = "done"
		pp.Result = result
	})
}

// RefreshKiroSocial refreshes via desktop auth endpoint.
func RefreshKiroSocial(ctx context.Context, refreshToken string) (map[string]any, error) {
	if refreshToken == "" {
		return nil, fmt.Errorf("kiro: empty refresh token")
	}
	raw, _ := json.Marshal(map[string]string{"refreshToken": refreshToken})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, KiroSocialRefresh, strings.NewReader(string(raw)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "kiro-cli/1.0.0")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("kiro refresh failed: %s", string(b))
	}
	var tok map[string]any
	if err := json.Unmarshal(b, &tok); err != nil {
		return nil, err
	}
	// normalize keys
	out := map[string]any{
		"access_token":  firstString(tok, "accessToken", "access_token"),
		"refresh_token": firstString(tok, "refreshToken", "refresh_token"),
		"expires_in":    firstFloat(tok, "expiresIn", "expires_in"),
		"profileArn":    firstString(tok, "profileArn", "profile_arn"),
	}
	return out, nil
}

// StartKiroDevice registers a public OIDC client and starts device authorization (Builder ID / IDC).
func StartKiroDevice(ctx context.Context, store *Store, startURL, region string) (*Pending, error) {
	if region == "" {
		region = "us-east-1"
	}
	registerURL := fmt.Sprintf("https://oidc.%s.amazonaws.com/client/register", region)
	deviceURL := fmt.Sprintf("https://oidc.%s.amazonaws.com/device_authorization", region)
	regBody := map[string]any{
		"clientName":   "kiro-oauth-client",
		"clientType":   "public",
		"scopes":       []string{"codewhisperer:completions", "codewhisperer:analysis", "codewhisperer:conversations", "codewhisperer:transformations", "codewhisperer:taskassist"},
		"grantTypes":   []string{"urn:ietf:params:oauth:grant-type:device_code", "refresh_token"},
		"issuerUrl":    "https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6",
	}
	if startURL != "" {
		regBody["issuerUrl"] = startURL
	}
	rb, _ := json.Marshal(regBody)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, registerURL, strings.NewReader(string(rb)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("kiro register client failed: %s", string(b))
	}
	var reg map[string]any
	if err := json.Unmarshal(b, &reg); err != nil {
		return nil, err
	}
	clientID := firstString(reg, "clientId", "client_id")
	clientSecret := firstString(reg, "clientSecret", "client_secret")

	form := url.Values{}
	form.Set("client_id", clientID)
	if clientSecret != "" {
		form.Set("client_secret", clientSecret)
	}
	form.Set("scope", "codewhisperer:completions codewhisperer:analysis codewhisperer:conversations")
	dreq, err := http.NewRequestWithContext(ctx, http.MethodPost, deviceURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	dreq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	dresp, err := httpClient.Do(dreq)
	if err != nil {
		return nil, err
	}
	defer dresp.Body.Close()
	db, _ := io.ReadAll(dresp.Body)
	if dresp.StatusCode >= 300 {
		return nil, fmt.Errorf("kiro device auth failed: %s", string(db))
	}
	var dev map[string]any
	if err := json.Unmarshal(db, &dev); err != nil {
		return nil, err
	}
	p, err := NewPending("kiro", 15*time.Minute)
	if err != nil {
		return nil, err
	}
	p.AuthURL = firstString(dev, "verificationUriComplete", "verification_uri_complete")
	if p.AuthURL == "" {
		p.AuthURL = firstString(dev, "verificationUri", "verification_uri")
	}
	p.Result = map[string]any{
		"flow":                "device",
		"region":              region,
		"clientId":            clientID,
		"clientSecret":        clientSecret,
		"deviceCode":          firstString(dev, "deviceCode", "device_code"),
		"userCode":            firstString(dev, "userCode", "user_code"),
		"interval":            firstFloat(dev, "interval"),
		"verificationUri":     firstString(dev, "verificationUri", "verification_uri"),
		"verificationUriComplete": firstString(dev, "verificationUriComplete", "verification_uri_complete"),
	}
	// stash secrets in pending private fields via Result is ok for short TTL; also CodeVerifier unused
	p.CodeVerifier = firstString(dev, "deviceCode", "device_code")
	p.MachineID = clientID
	p.Nonce = clientSecret
	store.Put(p)
	return p, nil
}

// PollKiroDevice polls OIDC token endpoint for device flow.
func PollKiroDevice(ctx context.Context, store *Store, sessionID string) (*Pending, error) {
	p, ok := store.Get(sessionID)
	if !ok || p.Provider != "kiro" {
		return nil, fmt.Errorf("kiro session not found")
	}
	if p.Status == "done" {
		return p, nil
	}
	region := "us-east-1"
	if p.Result != nil {
		if r, ok := p.Result["region"].(string); ok && r != "" {
			region = r
		}
	}
	tokenURL := fmt.Sprintf("https://oidc.%s.amazonaws.com/token", region)
	form := url.Values{}
	form.Set("grant_type", "urn:ietf:params:oauth:grant-type:device_code")
	form.Set("device_code", p.CodeVerifier)
	form.Set("client_id", p.MachineID)
	if p.Nonce != "" {
		form.Set("client_secret", p.Nonce)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == 400 {
		var errBody map[string]any
		_ = json.Unmarshal(b, &errBody)
		errStr := firstString(errBody, "error")
		if errStr == "authorization_pending" || errStr == "slow_down" {
			return p, nil
		}
	}
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("kiro device poll: %s", string(b))
	}
	var tok map[string]any
	if err := json.Unmarshal(b, &tok); err != nil {
		return nil, err
	}
	access := firstString(tok, "access_token", "accessToken")
	refresh := firstString(tok, "refresh_token", "refreshToken")
	email := DecodeIDTokenEmail(access)
	result := map[string]any{
		"accessToken":  access,
		"refreshToken": refresh,
		"email":        email,
		"provider":     "kiro",
		"authType":     "oauth",
		"authMethod":   "builder-id",
		"clientId":     p.MachineID,
		"clientSecret": p.Nonce,
		"region":       region,
		"expiresIn":    firstFloat(tok, "expires_in", "expiresIn"),
	}
	if exp := firstFloat(tok, "expires_in", "expiresIn"); exp > 0 {
		result["expiresAt"] = time.Now().Add(time.Duration(exp) * time.Second).UTC().Format(time.RFC3339)
	}
	return store.Update(sessionID, func(pp *Pending) {
		pp.Status = "done"
		pp.Result = result
	})
}

// ImportKiroRefresh builds a connection result from a pasted refresh token.
func ImportKiroRefresh(ctx context.Context, refreshToken, clientID, clientSecret, region, authMethod string) (map[string]any, error) {
	refreshToken = strings.TrimSpace(refreshToken)
	if refreshToken == "" {
		return nil, fmt.Errorf("refresh token required")
	}
	var tok map[string]any
	var err error
	if authMethod == "idc" || authMethod == "builder-id" || clientID != "" {
		tok, err = RefreshKiroOIDC(ctx, refreshToken, clientID, clientSecret, region)
	} else {
		tok, err = RefreshKiroSocial(ctx, refreshToken)
	}
	if err != nil {
		// still store refresh token for later — return partial
		return map[string]any{
			"refreshToken": refreshToken,
			"accessToken":  "",
			"provider":     "kiro",
			"authType":     "oauth",
			"authMethod":   pick(authMethod, "social"),
			"clientId":     clientID,
			"clientSecret": clientSecret,
			"region":       pick(region, "us-east-1"),
			"importError":  err.Error(),
		}, nil
	}
	access := firstString(tok, "access_token", "accessToken")
	out := map[string]any{
		"accessToken":  access,
		"refreshToken": firstString(tok, "refresh_token", "refreshToken"),
		"email":        DecodeIDTokenEmail(access),
		"provider":     "kiro",
		"authType":     "oauth",
		"authMethod":   pick(authMethod, "social"),
		"clientId":     clientID,
		"clientSecret": clientSecret,
		"region":       pick(region, "us-east-1"),
		"profileArn":   firstString(tok, "profileArn"),
	}
	if out["refreshToken"] == "" {
		out["refreshToken"] = refreshToken
	}
	if exp := firstFloat(tok, "expires_in", "expiresIn"); exp > 0 {
		out["expiresAt"] = time.Now().Add(time.Duration(exp) * time.Second).UTC().Format(time.RFC3339)
		out["expiresIn"] = exp
	}
	// best-effort profile arn
	if out["profileArn"] == "" && access != "" {
		if arn, err := FetchKiroProfileArn(ctx, access); err == nil && arn != "" {
			out["profileArn"] = arn
		}
	}
	return out, nil
}

func RefreshKiroOIDC(ctx context.Context, refreshToken, clientID, clientSecret, region string) (map[string]any, error) {
	if region == "" {
		region = "us-east-1"
	}
	tokenURL := fmt.Sprintf("https://oidc.%s.amazonaws.com/token", region)
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", refreshToken)
	if clientID != "" {
		form.Set("client_id", clientID)
	}
	if clientSecret != "" {
		form.Set("client_secret", clientSecret)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("kiro oidc refresh: %s", string(b))
	}
	var tok map[string]any
	if err := json.Unmarshal(b, &tok); err != nil {
		return nil, err
	}
	return map[string]any{
		"access_token":  firstString(tok, "access_token", "accessToken"),
		"refresh_token": firstString(tok, "refresh_token", "refreshToken"),
		"expires_in":    firstFloat(tok, "expires_in", "expiresIn"),
	}, nil
}

func FetchKiroProfileArn(ctx context.Context, accessToken string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://codewhisperer.us-east-1.amazonaws.com/ListAvailableProfiles", strings.NewReader("{}"))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("x-amz-sso-bearer", accessToken)
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return "", fmt.Errorf("list profiles: %s", string(b))
	}
	var body map[string]any
	if err := json.Unmarshal(b, &body); err != nil {
		return "", err
	}
	// profiles array
	if arr, ok := body["profiles"].([]any); ok && len(arr) > 0 {
		if m, ok := arr[0].(map[string]any); ok {
			return firstString(m, "arn", "profileArn"), nil
		}
	}
	return "", nil
}

func extractKiroCode(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	// full kiro:// URL or https callback
	if strings.Contains(raw, "code=") {
		if u, err := url.Parse(raw); err == nil {
			if c := u.Query().Get("code"); c != "" {
				return c
			}
		}
		// kiro:// may not parse well
		if i := strings.Index(raw, "code="); i >= 0 {
			rest := raw[i+5:]
			if j := strings.IndexAny(rest, "&\n\r "); j >= 0 {
				rest = rest[:j]
			}
			if c, err := url.QueryUnescape(rest); err == nil {
				return c
			}
			return rest
		}
	}
	return raw
}

func firstString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

func firstFloat(m map[string]any, keys ...string) float64 {
	for _, k := range keys {
		switch v := m[k].(type) {
		case float64:
			return v
		case int:
			return float64(v)
		case json.Number:
			f, _ := v.Float64()
			return f
		}
	}
	return 0
}

func pick(v, def string) string {
	if strings.TrimSpace(v) == "" {
		return def
	}
	return v
}

// DecodeJWTPayload returns raw payload map without verify (for debugging).
func DecodeJWTPayload(tok string) map[string]any {
	parts := strings.Split(tok, ".")
	if len(parts) < 2 {
		return nil
	}
	b, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		b, err = base64.URLEncoding.DecodeString(parts[1])
		if err != nil {
			return nil
		}
	}
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	return m
}
