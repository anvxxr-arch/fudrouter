// Package tests provides DB-backed test helpers for the data plane.
// Requires DATABASE_URL pointing at the dev Postgres; without it the DB-backed
// tests skip locally, but FAIL in CI so a green pipeline always means the data
// plane was actually exercised.
package tests

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/services/router/internal/crypt"
	"github.com/anvxxr-arch/fudrouter/services/router/internal/proxy"
	"github.com/anvxxr-arch/fudrouter/services/router/internal/store"

	"github.com/gofrs/uuid/v5"
	"github.com/jackc/pgx/v5"
)

// RequireDB returns the DSN for DB-backed tests. It skips when the database is
// not configured locally, but FAILS when CI is set: a silent skip lets the
// pipeline go green while the data plane was never exercised at all, which is
// exactly the failure mode this guard exists to prevent.
func RequireDB(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		if os.Getenv("CI") != "" {
			t.Fatal("DATABASE_URL is not set in CI — DB-backed tests must run, not skip")
		}
		t.Skip("DATABASE_URL not set — DB-backed test skipped")
	}
	return dsn
}

type Env struct {
	Key         string // full sk-ar-... key
	Prefix      string
	APIKeyID    string
	UserID      string
	Slug        string
	ModelID     string
	ProviderID  string
	UpstreamKey string
}

const UpstreamKeyPlain = "sk-upstream-test-key-0123456789"

func randChars(n int) string {
	const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	b := make([]byte, n)
	rand.Read(b)
	out := make([]byte, n)
	for i := range out {
		out[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return string(out)
}

func secretHash(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// SeedEnv inserts a throwaway user + key + provider + model pointing at upstreamBaseURL.
func SeedEnv(t *testing.T, dsn, upstreamBaseURL string) *Env {
	t.Helper()
	return SeedEnvFull(t, dsn, upstreamBaseURL, "active", nil)
}

// SeedEnvWithHeaders is SeedEnv plus extra `default_headers` inside the
// encrypted credential blob (upstream requirements that are not auth).
func SeedEnvWithHeaders(t *testing.T, dsn, upstreamBaseURL string, extraHeaders map[string]string) *Env {
	t.Helper()
	return SeedEnvFull(t, dsn, upstreamBaseURL, "active", extraHeaders)
}

// SeedEnvWithStatus controls provider.status — e.g. 'dev', which the data plane
// must hide unless ROUTER_ALLOW_DEV_PROVIDERS is set (spec §1).
func SeedEnvWithStatus(t *testing.T, dsn, upstreamBaseURL, status string, extraHeaders map[string]string) *Env {
	t.Helper()
	return SeedEnvFull(t, dsn, upstreamBaseURL, status, extraHeaders)
}

func SeedEnvFull(t *testing.T, dsn, upstreamBaseURL, status string, extraHeaders map[string]string) *Env {
	t.Helper()
	extra := map[string]any{}
	if len(extraHeaders) > 0 {
		extra["default_headers"] = extraHeaders
	}
	return seedEnvCred(t, dsn, upstreamBaseURL, status, extra)
}

// SeedEnvFreebuff seeds a provider whose credential blob declares the native
// Codebuff/Freebuff protocol, so the data plane must run the session/run/
// metadata handshake instead of an [OI] passthrough.
func SeedEnvFreebuff(t *testing.T, dsn, upstreamBaseURL string) *Env {
	t.Helper()
	return SeedEnvFreebuffAccounts(t, dsn, upstreamBaseURL, nil)
}

// SeedEnvFreebuffAccounts is SeedEnvFreebuff with an explicit account pool, so a
// test can exercise per-account failover. Nil tokens → a single static api_key.
func SeedEnvFreebuffAccounts(t *testing.T, dsn, upstreamBaseURL string, tokens []string) *Env {
	t.Helper()
	cred := map[string]any{
		"api_key":   UpstreamKeyPlain,
		"protocol":  "freebuff",
		"auth_kind": "apikey",
	}
	if len(tokens) > 0 {
		accts := make([]map[string]any, 0, len(tokens))
		for i, tok := range tokens {
			accts = append(accts, map[string]any{
				"email":         "acct-" + randChars(4) + "@codebuff.com",
				"api_key":       tok,
				"access_token":  tok,
				"refresh_token": nil,
				"expired":       "2099-01-01T00:00:00Z",
			})
			_ = i
		}
		cred["accounts"] = accts
		cred["api_key"] = tokens[0]
	}
	return seedEnvCred(t, dsn, upstreamBaseURL, "active", cred)
}

// seedEnvCred is the shared seeder. extraCred is merged into the encrypted
// credential blob so a test can declare protocol/auth_kind/etc.
func seedEnvCred(t *testing.T, dsn, upstreamBaseURL, status string, extraCred map[string]any) *Env {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { conn.Close(context.Background()) })

	uid := "u_" + randChars(8)
	_, err = conn.Exec(ctx,
		`insert into "user" (id, name, email, email_verified, created_at, updated_at)
		 values ($1,'T',$2, true, now(), now())`, uid, "t_"+uid+"@example.com")
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}

	prefix := randChars(8)
	secret := randChars(32)
	kid := uuid.Must(uuid.NewV7()).String()
	_, err = conn.Exec(ctx,
		`insert into api_key (id, user_id, name, prefix, key_hash, limits, created_at)
		 values ($1,$2,'test',$3,$4,'{}'::jsonb, now())`, kid, uid, prefix, secretHash(secret))
	if err != nil {
		t.Fatalf("seed key: %v", err)
	}

	cr, err := crypt.New(testMasterKey(t))
	if err != nil {
		t.Fatal(err)
	}
	cred := map[string]any{"api_key": UpstreamKeyPlain}
	for k, v := range extraCred {
		cred[k] = v
	}
	credJSON, _ := json.Marshal(cred)
	enc, err := cr.Encrypt(string(credJSON))
	if err != nil {
		t.Fatal(err)
	}

	pid := uuid.Must(uuid.NewV7()).String()
	slug := "t_" + randChars(6)
	mid := uuid.Must(uuid.NewV7()).String()
	_, err = conn.Exec(ctx, `
		insert into provider (id, name, base_url, credentials_enc, status, priority, created_at)
		values ($1, $2, $3, $4, $5, 100, now())`,
		pid, "test-provider-"+slug, upstreamBaseURL, enc, status)
	if err != nil {
		t.Fatalf("seed provider: %v", err)
	}

	_, err = conn.Exec(ctx, `
		insert into model (id, provider_id, name, slug, context, input_price, output_price, currency, status, created_at)
		values ($1,$2,'Test',$3,128000,'150000.000000','600000.000000','USD','active', now())`,
		mid, pid, slug)
	if err != nil {
		t.Fatalf("seed model: %v", err)
	}

	// Teardown order matters: request_log references model/provider with
	// ON DELETE no action, so the user row (which cascades request_log away)
	// must be removed first or the provider/model deletes are FK-blocked.
	// Registered last so it runs before the conn.Close above (cleanups are LIFO).
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = conn.Exec(ctx, `delete from "user" where id = $1`, uid)
		_, _ = conn.Exec(ctx, `delete from provider where id = $1`, pid) // cascades model
	})

	return &Env{
		Key: "sk-ar-" + prefix + "_" + secret, Prefix: prefix, APIKeyID: kid, UserID: uid,
		Slug: slug, ModelID: mid, ProviderID: pid, UpstreamKey: UpstreamKeyPlain,
	}
}

func testMasterKey(t *testing.T) string {
	t.Helper()
	if v := os.Getenv("CREDENTIALS_MASTER_KEY"); v != "" {
		return v
	}
	// deterministic 32-byte key for tests
	b := make([]byte, 32)
	for i := range b {
		b[i] = byte(i)
	}
	return base64.StdEncoding.EncodeToString(b)
}

func NewProxy(t *testing.T, dsn, _ string) *proxy.Handler {
	t.Helper()
	return NewProxyWithRefresher(t, dsn, nil)
}

// NewProxyWithRefresher builds the hot-path handler with an explicit token
// refresher. A nil refresher is correct for static-api_key providers; pass a
// fake one to exercise the OAuth account pool without touching the network.
func NewProxyWithRefresher(t *testing.T, dsn string, refresher proxy.TokenRefresher) *proxy.Handler {
	t.Helper()
	ctx := context.Background()
	st, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	cr, err := crypt.New(testMasterKey(t))
	if err != nil {
		t.Fatal(err)
	}
	return proxy.New(st, cr, &http.Client{Timeout: 30 * time.Second}, refresher)
}

func RevokeKey(t *testing.T, dsn, keyID string) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `update api_key set revoked_at = now() where id = $1`, keyID); err != nil {
		t.Fatal(err)
	}
}

type LastLog struct {
	TokensIn, TokensOut, Cost int64
	Status                    string
}

func LastRequestLog(t *testing.T, dsn, apiKeyID string) LastLog {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var l LastLog
	err = conn.QueryRow(ctx, `
		select tokens_in, tokens_out, cost, status from request_log
		where api_key_id = $1 order by created_at desc limit 1`, apiKeyID,
	).Scan(&l.TokensIn, &l.TokensOut, &l.Cost, &l.Status)
	if err != nil {
		t.Fatalf("request_log lookup: %v", err)
	}
	return l
}
