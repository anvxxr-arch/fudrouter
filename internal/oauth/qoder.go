package oauth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	QoderLoginURL       = "https://qoder.com/device/selectAccounts"
	QoderDeviceTokenURL = "https://openapi.qoder.sh/api/v1/deviceToken/poll"
	QoderUserInfoURL    = "https://openapi.qoder.sh/api/v1/userinfo"
	QoderRefreshURL     = "https://center.qoder.sh/algo/api/v3/user/refresh_token"
)

func StartQoder(store *Store) (*Pending, error) {
	p, err := NewPending("qoder", 10*time.Minute)
	if err != nil {
		return nil, err
	}
	ver, err := PKCEVerifier(32)
	if err != nil {
		return nil, err
	}
	ch := PKCEChallengeS256(ver)
	nonce := uuid.NewString()
	machineID := uuid.NewString()
	q := url.Values{}
	q.Set("challenge", ch)
	q.Set("challenge_method", "S256")
	q.Set("machine_id", machineID)
	q.Set("nonce", nonce)
	p.CodeVerifier = ver
	p.Nonce = nonce
	p.MachineID = machineID
	p.AuthURL = QoderLoginURL + "?" + q.Encode()
	store.Put(p)
	return p, nil
}

func PollQoder(ctx context.Context, store *Store, sessionID string) (*Pending, error) {
	p, ok := store.Get(sessionID)
	if !ok || p.Provider != "qoder" {
		return nil, fmt.Errorf("qoder session not found")
	}
	if p.Status == "done" || p.Status == "error" {
		return p, nil
	}
	u := fmt.Sprintf("%s?nonce=%s&verifier=%s&challenge_method=S256",
		QoderDeviceTokenURL, url.QueryEscape(p.Nonce), url.QueryEscape(p.CodeVerifier))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Go-http-client/2.0")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 202 || resp.StatusCode == 404 {
		return p, nil // still pending
	}
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		msg := fmt.Sprintf("Qoder device token poll failed: HTTP %d", resp.StatusCode)
		var body map[string]any
		if json.Unmarshal(b, &body) == nil {
			if m, ok := body["message"].(string); ok && m != "" {
				msg = "Qoder device token poll failed: " + m
			}
		}
		_, _ = store.Update(sessionID, func(pp *Pending) {
			pp.Status = "error"
			pp.Error = msg
		})
		return nil, fmt.Errorf("%s", msg)
	}
	var body map[string]any
	if err := json.Unmarshal(b, &body); err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}
	tok, _ := body["token"].(string)
	if tok == "" {
		return nil, fmt.Errorf("Qoder poll 200 but no token")
	}
	expireMs := parseQoderExpiry(body["expires_at"], body["expires_in"])
	email, name := "", ""
	if info, err := fetchQoderUser(ctx, tok); err == nil {
		email, _ = info["email"].(string)
		name, _ = info["name"].(string)
	}
	refresh, _ := body["refresh_token"].(string)
	userID, _ := body["user_id"].(string)
	result := map[string]any{
		"accessToken":  tok,
		"refreshToken": refresh,
		"userId":       userID,
		"email":        email,
		"name":         name,
		"machineId":    p.MachineID,
		"expireTime":   expireMs,
		"expiresAt":    time.UnixMilli(expireMs).UTC().Format(time.RFC3339),
		"provider":     "qoder",
		"authType":     "oauth",
	}
	return store.Update(sessionID, func(pp *Pending) {
		pp.Status = "done"
		pp.Result = result
	})
}

func fetchQoderUser(ctx context.Context, accessToken string) (map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, QoderUserInfoURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Go-http-client/2.0")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return map[string]any{}, nil
	}
	var body map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&body)
	name := strings.TrimSpace(strAny(body["name"]))
	if name == "" {
		name = strings.TrimSpace(strAny(body["username"]))
	}
	return map[string]any{
		"name":  name,
		"email": strings.TrimSpace(strAny(body["email"])),
	}, nil
}

func strAny(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func parseQoderExpiry(expiresAt, expiresIn any) int64 {
	now := time.Now()
	switch v := expiresAt.(type) {
	case float64:
		if v > 0 {
			return int64(v)
		}
	case string:
		t := strings.TrimSpace(v)
		if t != "" {
			if n, err := strconv.ParseInt(t, 10, 64); err == nil && n > 0 {
				return n
			}
			if tm, err := time.Parse(time.RFC3339, t); err == nil {
				return tm.UnixMilli()
			}
		}
	}
	switch v := expiresIn.(type) {
	case float64:
		if v >= 0 {
			return now.Add(time.Duration(v) * time.Second).UnixMilli()
		}
	case string:
		if n, err := strconv.ParseFloat(v, 64); err == nil && n >= 0 {
			return now.Add(time.Duration(n) * time.Second).UnixMilli()
		}
	}
	return now.Add(30 * 24 * time.Hour).UnixMilli()
}

// RefreshQoder is best-effort; upstream often 403s for device tokens.
func RefreshQoder(ctx context.Context, refreshToken string) (map[string]any, error) {
	if refreshToken == "" {
		return nil, fmt.Errorf("qoder: no refresh token")
	}
	form := url.Values{}
	form.Set("refresh_token", refreshToken)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, QoderRefreshURL, strings.NewReader(form.Encode()))
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
		return nil, fmt.Errorf("qoder refresh failed: %s", string(b))
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}
