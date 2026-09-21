package oauth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	CodexClientID     = "app_EMoamEEZ73f0CkXaXp7hrann"
	CodexAuthURL      = "https://auth.openai.com/oauth/authorize"
	CodexTokenURL     = "https://auth.openai.com/oauth/token"
	CodexAPIBase      = "https://chatgpt.com/backend-api/codex"
	CodexUsageURL     = "https://chatgpt.com/backend-api/wham/usage"
	CodexResetCreditsURL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
	CodexProfileURL   = "https://api.openai.com/profile"
)

func StartCodexPKCE(ctx context.Context, store *Store, redirectURI string) (*Pending, error) {
	if redirectURI == "" {
		redirectURI = "http://localhost:1455/auth/callback"
	}
	p, err := NewPending("codex", 10*time.Minute)
	if err != nil {
		return nil, err
	}
	ver, err := PKCEVerifier(96)
	if err != nil {
		return nil, err
	}
	ch := PKCEChallengeS256(ver)
	p.CodeVerifier = ver
	p.State = p.ID
	p.RedirectURI = redirectURI
	q := url.Values{}
	q.Set("client_id", CodexClientID)
	q.Set("response_type", "code")
	q.Set("redirect_uri", redirectURI)
	q.Set("scope", "openid profile email offline_access codex")
	q.Set("code_challenge", ch)
	q.Set("code_challenge_method", "S256")
	q.Set("state", p.State)
	q.Set("prompt", "login")
	q.Set("redirect_parameters_type", "query")
	p.AuthURL = CodexAuthURL + "?" + q.Encode()
	store.Put(p)
	return p, nil
}

func ExchangeCodexCode(ctx context.Context, store *Store, sessionID, code string) (*Pending, error) {
	p, ok := store.Get(sessionID)
	if !ok || p.Provider != "codex" {
		if sessionID == "" {
			return nil, fmt.Errorf("codex session required")
		}
		return nil, fmt.Errorf("codex session not found")
	}
	if code == "" {
		return nil, fmt.Errorf("authorization code required")
	}
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("client_id", CodexClientID)
	form.Set("code", code)
	form.Set("redirect_uri", p.RedirectURI)
	form.Set("code_verifier", p.CodeVerifier)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, CodexTokenURL, strings.NewReader(form.Encode()))
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
		_, _ = store.Update(sessionID, func(pp *Pending) {
			pp.Status = "error"
			pp.Error = string(b)
		})
		return nil, fmt.Errorf("codex token exchange: %s", string(b))
	}
	var tok map[string]any
	if err := json.Unmarshal(b, &tok); err != nil {
		return nil, err
	}
	access := firstString(tok, "access_token", "accessToken")
	refresh := firstString(tok, "refresh_token", "refreshToken")
	email := DecodeIDTokenEmail(firstString(tok, "id_token", "idToken"))
	if email == "" && access != "" {
		email = fetchCodexEmail(ctx, access)
	}
	expiresIn := firstFloat(tok, "expires_in", "expiresIn")
	result := map[string]any{
		"accessToken":  access,
		"refreshToken": refresh,
		"email":        email,
		"provider":     "codex",
		"authType":     "oauth",
		"authMethod":   "codex-pkce",
		"apiBaseUrl":   CodexAPIBase,
		"idToken":      firstString(tok, "id_token", "idToken"),
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

func fetchCodexEmail(ctx context.Context, accessToken string) string {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, CodexProfileURL, nil)
	if err != nil {
		return ""
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return ""
	}
	var body map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&body)
	return firstString(body, "email", "name")
}

func ImportCodexToken(accessToken, name string) (map[string]any, error) {
	accessToken = strings.TrimSpace(accessToken)
	if accessToken == "" {
		return nil, fmt.Errorf("accessToken required")
	}
	if len(accessToken) < 20 {
		return nil, fmt.Errorf("accessToken too short")
	}
	email := DecodeIDTokenEmail(accessToken)
	if name == "" {
		name = "codex-imported"
	}
	return map[string]any{
		"accessToken":  accessToken,
		"refreshToken": "",
		"email":        email,
		"name":         name,
		"provider":     "codex",
		"authType":     "oauth",
		"authMethod":   "import",
		"apiBaseUrl":   CodexAPIBase,
	}, nil
}

func RefreshCodex(ctx context.Context, refreshToken string) (map[string]any, error) {
	if refreshToken == "" {
		return nil, fmt.Errorf("codex: empty refresh")
	}
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("client_id", CodexClientID)
	form.Set("refresh_token", refreshToken)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, CodexTokenURL, strings.NewReader(form.Encode()))
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
		return nil, fmt.Errorf("codex refresh: %s", string(b))
	}
	var tok map[string]any
	if err := json.Unmarshal(b, &tok); err != nil {
		return nil, err
	}
	out := map[string]any{
		"access_token":  firstString(tok, "access_token", "accessToken"),
		"refresh_token": firstString(tok, "refresh_token", "refreshToken"),
		"expires_in":    firstFloat(tok, "expires_in", "expiresIn"),
	}
	return out, nil
}

func CodexUsage(ctx context.Context, accessToken string) (map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, CodexUsageURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("usage: %s", string(b))
	}
	var body map[string]any
	_ = json.Unmarshal(b, &body)
	return body, nil
}

func CodexResetCredits(ctx context.Context, accessToken string) (map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, CodexResetCreditsURL, strings.NewReader("{}"))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("reset credits: %s", string(b))
	}
	var body map[string]any
	_ = json.Unmarshal(b, &body)
	return body, nil
}
