package oauth

import (
	"context"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudrouter/internal/db"
)

const backgroundLead = 30 * time.Minute
const backgroundInterval = 5 * time.Minute

// StartBackgroundRefresh periodically refreshes OAuth connections.
func StartBackgroundRefresh(database *db.DB) {
	if truthy(os.Getenv("DISABLE_BACKGROUND_TOKEN_REFRESH")) {
		return
	}
	go func() {
		time.Sleep(10 * time.Second)
		t := time.NewTicker(backgroundInterval)
		defer t.Stop()
		for {
			runRefreshTick(database)
			<-t.C
		}
	}()
}

func truthy(v string) bool {
	v = strings.ToLower(strings.TrimSpace(v))
	return v == "1" || v == "true" || v == "yes" || v == "on"
}

func runRefreshTick(database *db.DB) {
	conns, err := database.ListConnections()
	if err != nil {
		return
	}
	now := time.Now()
	for _, c := range conns {
		if c.IsActive != 1 {
			continue
		}
		if !strings.EqualFold(strings.ReplaceAll(c.AuthType, "_", ""), "oauth") {
			continue
		}
		refresh := connString(c, "refreshToken", "refresh_token")
		if refresh == "" {
			continue
		}
		exp := connExpiry(c)
		if exp.IsZero() {
			continue
		}
		if exp.Sub(now) > backgroundLead {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		err := refreshConnection(ctx, database, c, refresh)
		cancel()
		if err != nil {
			slog.Error("oauth refresh failed", "provider", c.Provider, "id", c.ID, "error", err)
		} else {
			slog.Info("oauth refresh ok", "provider", c.Provider, "id", c.ID)
		}
		time.Sleep(1500 * time.Millisecond)
	}
}

func connString(c db.Connection, keys ...string) string {
	for _, k := range keys {
		if c.Data != nil {
			if v, ok := c.Data[k].(string); ok && v != "" {
				return v
			}
		}
		if k == "api_key" && c.APIKey != "" {
			return c.APIKey
		}
	}
	return ""
}

func connExpiry(c db.Connection) time.Time {
	if c.Data == nil {
		return time.Time{}
	}
	for _, k := range []string{"expiresAt", "expireTime", "expires_at"} {
		switch v := c.Data[k].(type) {
		case string:
			if tm, err := time.Parse(time.RFC3339, v); err == nil {
				return tm
			}
		case float64:
			// ms or sec
			if v > 1e12 {
				return time.UnixMilli(int64(v))
			}
			if v > 1e9 {
				return time.Unix(int64(v), 0)
			}
		}
	}
	return time.Time{}
}

func refreshConnection(ctx context.Context, database *db.DB, c db.Connection, refresh string) error {
	var tok map[string]any
	var err error
	switch strings.ToLower(c.Provider) {
	case "xai", "grok", "grok-cli":
		tok, err = RefreshXAI(ctx, refresh)
	case "qoder":
		tok, err = RefreshQoder(ctx, refresh)
	case "kiro":
		authMethod := ""
		clientID, clientSecret, region := "", "", "us-east-1"
		if c.Data != nil {
			authMethod, _ = c.Data["authMethod"].(string)
			clientID, _ = c.Data["clientId"].(string)
			clientSecret, _ = c.Data["clientSecret"].(string)
			if r, ok := c.Data["region"].(string); ok && r != "" {
				region = r
			}
			if te, ok := c.Data["tokenEndpoint"].(string); ok && te != "" && strings.Contains(strings.ToLower(authMethod), "external") {
				// external_idp path: POST refresh to custom endpoint is specialized; fall through social if unset
			}
		}
		if clientID != "" || authMethod == "idc" || authMethod == "builder-id" {
			tok, err = RefreshKiroOIDC(ctx, refresh, clientID, clientSecret, region)
		} else {
			tok, err = RefreshKiroSocial(ctx, refresh)
		}
	case "codex":
		tok, err = RefreshCodex(ctx, refresh)
	default:
		return nil // no refresh handler
	}
	if err != nil {
		return err
	}
	data := c.Data
	if data == nil {
		data = map[string]any{}
	}
	if at, ok := tok["access_token"].(string); ok && at != "" {
		data["accessToken"] = at
		c.APIKey = at
	}
	if rt, ok := tok["refresh_token"].(string); ok && rt != "" {
		data["refreshToken"] = rt
	}
	if exp, ok := tok["expires_in"].(float64); ok {
		data["expiresAt"] = time.Now().Add(time.Duration(exp) * time.Second).UTC().Format(time.RFC3339)
	}
	c.Data = data
	c.AuthType = "oauth"
	_, err = database.UpsertConnection(c)
	return err
}
