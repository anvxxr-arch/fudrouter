// Package tests provides DB-backed test helpers for the data plane.
// Requires DATABASE_URL pointing at a THROWAWAY Postgres; without it the DB-backed
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
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/crypt"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/ids"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/proxy"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/vk"

	"github.com/gofrs/uuid/v5"
	"github.com/jackc/pgx/v5"
)

// allowProdEnv is the deliberate override for running the suite against a real
// database. It must never be set by accident, and it is never set by the
// documented workflow — `set -a; source .env` sources the production
// DSN, which is exactly the trap the guard below closes.
const allowProdEnv = "FUDROUTER_ALLOW_PROD_TESTS"

// productionDatabases are database names the suite must never touch. The suite
// INSERTS and DELETEs in whatever DATABASE_URL names (see SeedEnv/Seed), and
// before this guard existed that was silently the application database: one run
// churned the live `request_log` ledger, and its teardown left rows behind. The
// name is the one thing that reliably distinguishes "the app" from "a scratch
// database", because both are the same Postgres instance and the same role.
var productionDatabases = map[string]bool{
	"fudrouter": true,
}

// databaseName extracts the target database from a DSN without opening a
// connection. Handles both the URL form (postgres://user:pw@host:port/name?opts)
// and a key=value DSN (host=… dbname=…). Returns "" when it cannot tell, which
// the caller treats as untrusted.
func databaseName(dsn string) string {
	lower := strings.ToLower(dsn)
	if !strings.HasPrefix(lower, "postgres://") && !strings.HasPrefix(lower, "postgresql://") {
		// key=value form: find dbname= up to whitespace
		for _, field := range strings.Fields(dsn) {
			if k, v, ok := strings.Cut(field, "="); ok && strings.EqualFold(k, "dbname") {
				return v
			}
		}
		return ""
	}
	rest := dsn[strings.Index(dsn, "://")+3:]
	// strip query/params
	if i := strings.IndexAny(rest, "?"); i >= 0 {
		rest = rest[:i]
	}
	// the path is the database name; a slash in the password is already consumed
	// by taking the LAST segment
	if i := strings.LastIndex(rest, "/"); i >= 0 {
		return rest[i+1:]
	}
	return ""
}

// RequireDB returns the DSN for DB-backed tests. It skips when the database is
// not configured locally, but FAILS when CI is set: a silent skip lets the
// pipeline go green while the data plane was never exercised at all, which is
// exactly the failure mode this guard exists to prevent.
//
// It also REFUSES the application database. The suite writes to and deletes
// from whatever DATABASE_URL names, and the documented local workflow
// (`set -a; source .env`) points that variable at the live app
// database. A plain run therefore used to insert and delete real usage rows and
// provider rows in production. Point DATABASE_URL at a throwaway database, or
// set FUDROUTER_ALLOW_PROD_TESTS=1 to accept the risk explicitly.
func RequireDB(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		if os.Getenv("CI") != "" {
			t.Fatal("DATABASE_URL is not set in CI — DB-backed tests must run, not skip")
		}
		t.Skip("DATABASE_URL not set — DB-backed test skipped")
	}
	if os.Getenv(allowProdEnv) != "" {
		return dsn
	}
	if name := databaseName(dsn); productionDatabases[name] {
		t.Fatalf("DATABASE_URL points at the %q application database. "+
			"The suite inserts and DELETEs in this database and will destroy the "+
			"live request_log ledger. Point DATABASE_URL at a throwaway database, "+
			"or set %s=1 if you really mean to run the suite against %q.",
			name, allowProdEnv, name)
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
	// The account chain (spec §2–§4 after migration 0019): the key belongs to
	// the user, the billing account belongs to the user, and the provider
	// network a request resolves through hangs off the model.
	BillingAccountID string
	ConnectionID     string
	ProviderModelID  string
	CredentialID     string
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
//
// t is testing.TB, not *testing.T, so a benchmark can seed the same way a test
// does — the store benchmarks need a real environment and the alternative is a
// second seeder that drifts from this one.
func SeedEnv(t testing.TB, dsn, upstreamBaseURL string) *Env {
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

func SeedEnvFull(t testing.TB, dsn, upstreamBaseURL, status string, extraHeaders map[string]string) *Env {
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
	// The freebuff upstream in these tests is an httptest server on 127.0.0.1,
	// and the freebuff client carries the same SSRF dial guard as the [OI] one
	// (internal/netguard) — so a loopback upstream is refused unless the escape
	// hatch is on. t.Setenv, not os.Setenv: it restores the value when the test
	// ends, so the guard stays fail-closed for every other test in the run.
	//
	// See SeedEnvFreebuffAccounts for why the escape hatch is set there.
	return SeedEnvFreebuffAccounts(t, dsn, upstreamBaseURL, nil)
}

// SeedEnvFreebuffAccounts is SeedEnvFreebuff with an explicit account pool, so a
// test can exercise per-account failover. Nil tokens → a single static api_key.
func SeedEnvFreebuffAccounts(t *testing.T, dsn, upstreamBaseURL string, tokens []string) *Env {
	t.Helper()
	// See SeedEnvFreebuff: the freebuff tests use a loopback httptest upstream,
	// and the client carries the real SSRF dial guard.
	t.Setenv("ALLOW_PRIVATE_UPSTREAMS", "1")
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
func seedEnvCred(t testing.TB, dsn, upstreamBaseURL, status string, extraCred map[string]any) *Env {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { conn.Close(context.Background()) })

	// Seeded rows start the clock for orphan-row teardown below (rows written
	// for failed-auth requests carry no owner at all).
	start := time.Now()

	uid := ids.New("usr")
	_, err = conn.Exec(ctx,
		`insert into "user" (id, name, email, email_verified, created_at, updated_at)
		 values ($1,'T',$2, true, now(), now())`, uid, "t_"+uid+"@example.com")
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}

	// Billing account (spec §10): a user with no account has no credit line and
	// the usage_charge ledger path never runs. Funded far above the default
	// warning threshold so ordinary test traffic never trips the hard stop
	// (tests that need a stop set one explicitly). Keyed by user since
	// migration 0019 removed the workspace it used to hang off.
	baID := ids.New("bac")
	if _, err := conn.Exec(ctx,
		`insert into billing_account (id, user_id, currency, status, balance_micro)
		 values ($1,$2,'USD','active',10000000000)`, baID, uid); err != nil {
		t.Fatalf("seed billing account: %v", err)
	}

	prefix := randChars(8)
	secret := randChars(32)
	kid := ids.New("key")
	_, err = conn.Exec(ctx,
		`insert into api_key (id, user_id, name, prefix, key_hash, limits, created_at)
		 values ($1,$2,'test',$3,$4,'{}'::jsonb, now())`,
		kid, uid, prefix, secretHash(secret))
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

	pid := ids.New("prv")
	slug := "t_" + randChars(6)
	mid := ids.New("mdl")
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

	// Pricing rule (spec §6): a model-wide version-1 rule at the SAME prices as
	// the legacy model columns, so the versioned path is exercised while the
	// money stays identical (cost asserts are price-agnostic).
	prcID := ids.New("prc")
	if _, err := conn.Exec(ctx, `
		insert into pricing_rule (id, model_id, version, currency, input_price, output_price, effective_from)
		values ($1,$2,1,'USD','150000.000000','600000.000000', now() - interval '1 minute')`,
		prcID, mid); err != nil {
		t.Fatalf("seed pricing rule: %v", err)
	}

	// The provider network (spec §4): one connection, one provider_model
	// mapping, and ONE CREDENTIAL ROW PER ACCOUNT. store.Candidates resolves
	// model -> provider_model -> connection -> credential, and targetFor
	// rotates the rows — the multi-account failover tests depend on the rows,
	// not on the legacy blob (which is seeded too, for the S0 path).
	conID := ids.New("con")
	cfg := map[string]any{}
	if v, ok := cred["protocol"].(string); ok && v != "" {
		cfg["protocol"] = v
	}
	if v, ok := cred["auth_kind"].(string); ok && v != "" {
		cfg["auth_kind"] = v
	}
	if hs, ok := cred["default_headers"].(map[string]string); ok && len(hs) > 0 {
		cfg["default_headers"] = hs
	}
	cfgJSON, _ := json.Marshal(cfg)
	if _, err := conn.Exec(ctx, `
		insert into connection (id, provider_id, name, slug, base_url, auth_type, config)
		values ($1,$2,'default','default',$3,'bearer',$4::jsonb)`,
		conID, pid, upstreamBaseURL, string(cfgJSON)); err != nil {
		t.Fatalf("seed connection: %v", err)
	}
	pmID := ids.New("pmdl")
	if _, err := conn.Exec(ctx, `
		insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled, status)
		values ($1,$2,$3,$4,$5,true,'available')`,
		pmID, mid, pid, conID, slug); err != nil {
		t.Fatalf("seed provider_model: %v", err)
	}
	credIDs := make([]string, 0, 2)
	for i, acc := range seedAccounts(cred) {
		accJSON, _ := json.Marshal(acc)
		accEnc, err := cr.Encrypt(string(accJSON))
		if err != nil {
			t.Fatal(err)
		}
		cid := ids.New("cred")
		// priority 100+i pins the pool order: usableCredentials sorts by
		// priority asc and Pick round-robins from the front, so the account a
		// test expects to fail FIRST really is probed first — the failover is
		// real, not lucky ordering.
		if _, err := conn.Exec(ctx, `
			insert into credential (id, connection_id, name, secret_enc, status, priority, weight)
			values ($1,$2,$3,$4,'healthy',$5,100)`,
			cid, conID, "acct-"+strconv.Itoa(i), accEnc, 100+i); err != nil {
			t.Fatalf("seed credential: %v", err)
		}
		credIDs = append(credIDs, cid)
	}

	// Teardown must be EXPLICIT and ORDERED. `request_log` references model and
	// provider with ON DELETE no action, and it no longer disappears with the user
	// (the ledger moved to ON DELETE SET NULL) — so deleting the user first is not
	// enough: the provider/model delete is FK-blocked. When that error is
	// discarded, every run silently leaks a provider + model + log row into
	// whatever DATABASE_URL points at (observed: 24 leaked providers, all
	// status='active', from one suite run against the app database). RequireDB
	// now refuses the app database outright, so that run cannot happen by
	// accident; the ordering below is still required for correctness.
	// Registered last so it runs before the conn.Close above (cleanups are LIFO).
	t.Cleanup(func() {
		ctx := context.Background()
		// A failed teardown must be LOUD, not a silently swallowed error.
		exec := func(query string, args ...any) {
			if _, err := conn.Exec(ctx, query, args...); err != nil {
				t.Errorf("seed teardown failed (leaks rows): %s: %v", query, err)
			}
		}
		// request_attempt rides along (request_id FK is ON DELETE CASCADE);
		// credit_ledger rides along with its billing account (same cascade).
		exec(`delete from request_log where api_key_id = $1 or model_id = $2 or user_id = $3`, kid, mid, uid)
		// Orphan rows (failed-auth outcomes) carry no owner at all: only their
		// birth time links them to this seed.
		exec(`delete from request_log where created_at >= $1 and api_key_id is null and model_id is null`, start)
		exec(`delete from pricing_rule where model_id = $1`, mid)
		exec(`delete from provider_model where model_id = $1`, mid)
		exec(`delete from credential where connection_id = $1`, conID)
		exec(`delete from connection where id = $1`, conID)
		exec(`delete from model where id = $1`, mid)
		exec(`delete from provider where id = $1`, pid)
		exec(`delete from billing_account where id = $1`, baID)
		exec(`delete from api_key where id = $1`, kid)
		exec(`delete from "user" where id = $1`, uid)
	})

	return &Env{
		Key: "sk-ar-" + prefix + "_" + secret, Prefix: prefix, APIKeyID: kid, UserID: uid,
		Slug: slug, ModelID: mid, ProviderID: pid, UpstreamKey: UpstreamKeyPlain,
		BillingAccountID: baID, ConnectionID: conID, ProviderModelID: pmID,
		CredentialID: credIDs[0],
	}
}

// seedAccounts expands the seeded credential material into ONE ENTRY PER
// ACCOUNT (spec §4: one account = one credential row). A multi-account pool
// becomes one row per account; anything else becomes a single row.
func seedAccounts(cred map[string]any) []map[string]any {
	if rows, ok := cred["accounts"].([]map[string]any); ok && len(rows) > 0 {
		return rows
	}
	return []map[string]any{cred}
}

func testMasterKey(t testing.TB) string {
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

func NewProxy(t testing.TB, dsn, _ string) *proxy.Handler {
	t.Helper()
	return NewProxyWithRefresher(t, dsn, nil)
}

// NewProxyWithRefresher builds the hot-path handler with an explicit token
// refresher. A nil refresher is correct for static-api_key providers; pass a
// fake one to exercise the OAuth account pool without touching the network.
func NewProxyWithRefresher(t testing.TB, dsn string, refresher proxy.TokenRefresher) *proxy.Handler {
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
	// The handler must run on the in-process limiter, NOT the deployment's cache.
	//
	// This comment used to say "VALKEY_URL is empty in tests unless a test sets
	// it" — which was true of the CI shell and false of the deployment shell,
	// where VALKEY_URL is exported. In that environment every proxy test shared
	// one live Valkey: the catalogue cache (45s) and the counters were global
	// across tests, so a seeded model was missing from a list another test had
	// just cached, and a token-window counter from one test bounded the next.
	// vk.Disabled states the intent — the disabled client returns ErrDisabled,
	// which every caller already reads as "fall back to in-process behaviour"
	// (spec §12) — and it is what a test that wants real Valkey must ask for
	// explicitly.
	c := vk.Disabled()
	return proxy.New(st, cr, &http.Client{Timeout: 30 * time.Second}, refresher, c)
}

// NewProxyDefaultClient builds the handler exactly as main.go does — nil client,
// so proxy.New uses its production upstream client (no whole-request timeout).
func NewProxyDefaultClient(t testing.TB, dsn string) *proxy.Handler {
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
	// vk.Disabled, for the same reason as NewProxyWithRefresher: the deployment
	// shell exports VALKEY_URL, and a test that silently shared the live cache
	// would fail on state another test left behind.
	c := vk.Disabled()
	return proxy.New(st, cr, nil, nil, c)
}

func NewStore(t testing.TB, dsn string) *store.Store {
	t.Helper()
	st, err := store.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	return st
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

// SetKeyLimits writes the api_key.limits jsonb (e.g. `{"rpm":1}`) so a test can
// exercise the data plane's limit enforcement.
func SetKeyLimits(t *testing.T, dsn, keyID, limitsJSON string) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `update api_key set limits = $2::jsonb where id = $1`, keyID, limitsJSON); err != nil {
		t.Fatal(err)
	}
}

// SetBillingAccountHardStop pins a user account's billing thresholds and balance,
// so a test can drive the admission hard stop (spec §10: at/under
// hard_stop_threshold_micro the request is refused with 402
// INSUFFICIENT_CREDITS).
//
// Nothing else in the suite sets a non-default threshold: the seeded account
// comes from the migration defaults (hard stop 0, balance 0), which means the
// gate's REJECT branch — the one that decides whether a customer can spend —
// had no end-to-end test at all. SetKeyLimits covers the key-level caps, not
// this.
func SetBillingAccountHardStop(t *testing.T, dsn, userID string, hardStopMicro, balanceMicro int64) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx,
		`update billing_account set hard_stop_threshold_micro = $2, balance_micro = $3
		 where user_id = $1`, userID, hardStopMicro, balanceMicro); err != nil {
		t.Fatal(err)
	}
}

// SetBillingAccountStatus flips `billing_account.status` ('active'/'suspended'
// and whatever the control plane writes next), so a test can prove the
// admission gate refuses a non-active account independently of its balance.
func SetBillingAccountStatus(t *testing.T, dsn, userID, status string) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx,
		`update billing_account set status = $2 where user_id = $1`,
		userID, status); err != nil {
		t.Fatal(err)
	}
}

// SetEnvironmentMonthlyBudgetMicro is gone with `environment.monthly_budget_micro`
// in migration 0019. The equivalent cap is an account-scoped `budget` row
// (scope 'account', scope_id = user id), which SeedBudget writes.

// RequestLogCount returns how many request_log rows belong to a key, so a test
// can assert that a path actually wrote a usage row (or did not).
func RequestLogCount(t *testing.T, dsn, apiKeyID string) int {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var n int
	if err := conn.QueryRow(ctx, `select count(*) from request_log where api_key_id = $1`, apiKeyID).Scan(&n); err != nil {
		t.Fatalf("request_log count: %v", err)
	}
	return n
}

// SeedModels inserts `n` extra active models on the environment's provider —
// each with the `provider_model` mapping that makes it ROUTABLE — and returns
// their ids.
//
// It exists for the SCALE tests: a `[NAME]/*` virtual name resolves its candidate
// set from every active model (store.activeModelIDs), and the catalogue seeds
// two — so a fan-out bug (one store query per model) is invisible at that size
// and fatal at the ~250 a real deployment serves.
//
// The provider_model row is NOT optional: activeModelIDs requires an EXISTS on
// an enabled + servable provider_model, so models seeded without one are
// silently excluded and a "250 models" fixture would measure one model's fan-out.
// That is exactly what the first version of this helper did.
func SeedModels(t testing.TB, dsn string, env *Env, n int) []string {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	out := make([]string, 0, n)
	// One transaction: 250 separate inserts on a loopback box is mostly
	// round-trip overhead, and the test does not care about partial state.
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // rollback after commit is a no-op
	for i := range n {
		modelID := "mdl_bulk_" + randChars(8)
		slug := "bulk-" + strconv.Itoa(i) + "-" + randChars(4)
		if _, err := tx.Exec(ctx, `
			insert into model (id, provider_id, name, slug, context, input_price, output_price, status)
			values ($1, $2, $3, $4, 8192, '150000.000000', '600000.000000', 'active')`,
			modelID, env.ProviderID, slug, slug); err != nil {
			t.Fatalf("seed bulk model %d: %v", i, err)
		}
		if _, err := tx.Exec(ctx, `
			insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled, status)
			values ($1, $2, $3, $4, $5, true, 'available')`,
			ids.New("pmdl"), modelID, env.ProviderID, env.ConnectionID, slug); err != nil {
			t.Fatalf("seed bulk provider_model %d: %v", i, err)
		}
		out = append(out, modelID)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return out
}

// SeedAlias inserts an account-scoped `model_alias` with its `model_alias_target`
// rows, in the given order (spec §5: alias targets are ordered by `position`).
//
// It exists because the alias branch of ResolveModel was two queries — the row
// lookup, then the ordered target list — and nothing else in the suite seeded
// a POPULATED alias: every existing test used the seeded `[NAME]/*` descriptors,
// which carry no targets and take the virtual fall-through instead. A
// query-count change there would have had no test to break.
func SeedAlias(t testing.TB, dsn string, env *Env, name string, modelIDs []string) string {
	return SeedAliasAtScope(t, dsn, env, name, modelIDs, "account")
}

// SeedAliasAtScope is SeedAlias with an explicit scope, so a test can prove
// account beats global.
func SeedAliasAtScope(t testing.TB, dsn string, env *Env, name string, modelIDs []string, scope string) string {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)

	aliasID := "als_test_" + randChars(10)
	var accountID any
	switch scope {
	case "account":
		// Account scope wins in ResolveModel's ORDER BY, so this is the shape a
		// customer actually creates.
		accountID = env.UserID
	case "global":
		// NULL — the `[NAME]/*` virtual descriptor shape
	default:
		t.Fatalf("unknown alias scope %q", scope)
	}
	if _, err := conn.Exec(ctx,
		`insert into model_alias (id, account_id, name, enabled)
		 values ($1, $2, $3, true)`,
		aliasID, accountID, name); err != nil {
		t.Fatalf("seed %s alias %s: %v", scope, name, err)
	}
	for i, modelID := range modelIDs {
		if _, err := conn.Exec(ctx,
			`insert into model_alias_target (alias_id, model_id, position) values ($1, $2, $3)`,
			aliasID, modelID, i); err != nil {
			t.Fatalf("seed alias target %d: %v", i, err)
		}
	}
	return aliasID
}

// DisableAlias flips `enabled` off for every row with this name, so a test can
// prove a disabled alias is invisible to resolution rather than surfacing as an
// alias with no targets.
func DisableAlias(t testing.TB, dsn, name string) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `update model_alias set enabled = false where name = $1`, name); err != nil {
		t.Fatalf("disable alias %s: %v", name, err)
	}
}

// SeedModel inserts one extra `model` row on the environment's provider, so a
// test can give an alias more than one distinct target.
//
// `model.provider_id` is NOT NULL and is the only FK the insert cannot avoid,
// so it reuses the seeded provider. The alias path reads `model` by id and
// never joins the provider, which is why this is enough for an alias test —
// but it is NOT enough for a routing test, which needs a `provider_model`.
func SeedModel(t testing.TB, dsn string, env *Env, slug, inputPrice string) string {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)

	modelID := "mdl_alias_" + strings.ReplaceAll(slug, "-", "_")
	if _, err := conn.Exec(ctx, `
		insert into model (id, provider_id, name, slug, context, input_price, output_price, status)
		values ($1, $2, $3, $4, 8192, $5::numeric, $5::numeric, 'active')`,
		modelID, env.ProviderID, slug, slug, inputPrice); err != nil {
		t.Fatalf("seed model %s: %v", slug, err)
	}
	return modelID
}

// SeedEnvAccounts seeds an [OI]-passthrough provider with an explicit account
// pool (no native protocol), so a test can exercise per-account failover on the
// generic /v1/* path. The first token is the one the first Pick returns.
func SeedEnvAccounts(t testing.TB, dsn, upstreamBaseURL string, tokens []string) *Env {
	t.Helper()
	accts := make([]map[string]any, 0, len(tokens))
	for _, tok := range tokens {
		accts = append(accts, map[string]any{
			"email":         "acct-" + randChars(4) + "@example.com",
			"api_key":       tok,
			"access_token":  tok,
			"refresh_token": nil,
			"expired":       "2099-01-01T00:00:00Z",
		})
	}
	return seedEnvCred(t, dsn, upstreamBaseURL, "active", map[string]any{
		"api_key":  tokens[0],
		"accounts": accts,
	})
}

// LastLog is one request_log row's assertion surface (spec §8). The price
// fields are the STORED numeric strings (`150000.000000`), so a test can pin
// exactly what was frozen at request start.
type LastLog struct {
	ID                                string
	TokensIn, TokensOut, Cost         int64
	CreditCharged                     int64
	Status                            string
	HTTPStatus                        *int
	Attempts                          int
	FallbackUsed, Stream              bool
	TTFTMs                            *int
	PricingRuleID                     *string
	InputPriceMicro, OutputPriceMicro *string
}

// InsertRequestLogRow writes one request_log row with an explicit cost, so a test
// can set up a month-to-date total that the monthly cost cap is checked against,
// or spend against a budget scope.
//
// user_id / api_key_id are populated because the budget sums key off them
// (store.SpendMicro: `user_id = $1` for the account scope, `api_key_id = $1`
// for the key scope). The earlier version set NONE of them, so the row was
// invisible to every scoped sum and the account-budget branch could never be
// exercised — a test written against it silently passed a 200.
func InsertRequestLogRow(t *testing.T, dsn string, env *Env, costMicro int64) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	_, err = conn.Exec(ctx, `
		insert into request_log
		  (id, user_id, api_key_id,
		   model_id, provider_id, tokens_in, tokens_out,
		   cost, currency, latency_ms, status, error)
		values ($1,$2,$3,$4,$5,0,0,$6,'USD',0,'success','')`,
		uuid.Must(uuid.NewV7()).String(), env.UserID, env.APIKeyID,
		env.ModelID, env.ProviderID, costMicro)
	if err != nil {
		t.Fatalf("insert request_log: %v", err)
	}
}

// lastLogColumns is the assertion projection over request_log. NULLs come back
// as typed nil pointers (PRD §122: NULL ≠ 0), except credit_charged_micro where
// pre-ledger rows carry NULL and the tests want the number.
const lastLogColumns = `id, tokens_in, tokens_out, cost, coalesce(credit_charged_micro, 0),
	status, http_status, attempts, fallback_used, stream, ttft_ms, pricing_rule_id,
	input_price_micro, output_price_micro`

func scanLastLog(t *testing.T, row pgx.Row) LastLog {
	t.Helper()
	var l LastLog
	err := row.Scan(&l.ID, &l.TokensIn, &l.TokensOut, &l.Cost, &l.CreditCharged, &l.Status,
		&l.HTTPStatus, &l.Attempts, &l.FallbackUsed, &l.Stream, &l.TTFTMs, &l.PricingRuleID,
		&l.InputPriceMicro, &l.OutputPriceMicro)
	if err != nil {
		t.Fatalf("request_log lookup: %v", err)
	}
	return l
}

func LastRequestLog(t *testing.T, dsn, apiKeyID string) LastLog {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	return scanLastLog(t, conn.QueryRow(ctx, `
		select `+lastLogColumns+` from request_log
		where api_key_id = $1 order by created_at desc, id desc limit 1`, apiKeyID))
}

// RequestLogByID follows ONE specific request across later writes — created_at
// has no sub-second guarantee, so "the last row" is ambiguous the moment a
// test makes a second call (the price-freeze test does exactly that).
func RequestLogByID(t *testing.T, dsn, id string) LastLog {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	return scanLastLog(t, conn.QueryRow(ctx,
		`select `+lastLogColumns+` from request_log where id = $1`, id))
}

// LedgerRow is one credit_ledger entry (spec §10).
type LedgerRow struct {
	Type           string
	AmountMicro    int64
	IdempotencyKey string
}

// LedgerRows returns every credit_ledger entry written for one request — the
// usage_charge proof behind "a streaming call ... with a usage_charge ledger
// row" and the idempotency key `usage:<request id>` (PRD §118/§128).
func LedgerRows(t *testing.T, dsn, requestID string) []LedgerRow {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	rows, err := conn.Query(ctx, `
		select type, amount_micro, coalesce(idempotency_key, '')
		from credit_ledger where request_id = $1 order by created_at, id`, requestID)
	if err != nil {
		t.Fatalf("credit_ledger lookup: %v", err)
	}
	defer rows.Close()
	out := []LedgerRow{}
	for rows.Next() {
		var r LedgerRow
		if err := rows.Scan(&r.Type, &r.AmountMicro, &r.IdempotencyKey); err != nil {
			t.Fatalf("credit_ledger scan: %v", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// AttemptRec is one persisted request_attempt row (spec §8).
type AttemptRec struct {
	Attempt    int
	HTTPStatus *int
	ErrorCode  string
	Retryable  *bool
	Reason     string
}

// AttemptRecs returns a request's attempt rows in attempt order — the proof
// that a 429-then-200 failover recorded two attempts (spec §8).
func AttemptRecs(t *testing.T, dsn, requestID string) []AttemptRec {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	rows, err := conn.Query(ctx, `
		select attempt, http_status, coalesce(error_code, ''), retryable, coalesce(reason, '')
		from request_attempt where request_id = $1 order by attempt`, requestID)
	if err != nil {
		t.Fatalf("request_attempt lookup: %v", err)
	}
	defer rows.Close()
	out := []AttemptRec{}
	for rows.Next() {
		var r AttemptRec
		if err := rows.Scan(&r.Attempt, &r.HTTPStatus, &r.ErrorCode, &r.Retryable, &r.Reason); err != nil {
			t.Fatalf("request_attempt scan: %v", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// InsertPricingRule adds one pricing_rule version (spec §6) and returns its id.
// Prices are numeric(18,6) strings — money never touches a float here either.
func InsertPricingRule(t *testing.T, dsn, modelID string, version int, inputPrice, outputPrice string, effectiveFrom time.Time) string {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	// Registered here (before the row teardown below) so LIFO cleanup deletes
	// the row FIRST and closes the conn after — a `defer` would close the conn
	// before any t.Cleanup runs and leak the row.
	t.Cleanup(func() { conn.Close(context.Background()) })
	id := ids.New("prc")
	if _, err := conn.Exec(ctx, `
		insert into pricing_rule (id, model_id, version, currency, input_price, output_price, effective_from)
		values ($1,$2,$3,'USD',$4,$5,$6)`,
		id, modelID, version, inputPrice, outputPrice, effectiveFrom); err != nil {
		t.Fatalf("seed pricing rule: %v", err)
	}
	t.Cleanup(func() {
		if _, err := conn.Exec(context.Background(),
			`delete from pricing_rule where id = $1`, id); err != nil {
			t.Errorf("pricing_rule teardown failed (leaks row): %v", err)
		}
	})
	return id
}

// SetSystemSetting upserts a system_setting row (spec §9) for one test and
// DELETES it on cleanup: the key is platform-wide and the next test must see
// the default (absent) again.
func SetSystemSetting(t *testing.T, dsn, key string, value any) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	// LIFO: the row delete below runs before this close. See InsertPricingRule.
	t.Cleanup(func() { conn.Close(context.Background()) })
	if _, err := conn.Exec(ctx, `
		insert into system_setting (key, value) values ($1, $2::jsonb)
		on conflict (key) do update set value = excluded.value, updated_at = now()`,
		key, string(raw)); err != nil {
		t.Fatalf("seed system_setting: %v", err)
	}
	t.Cleanup(func() {
		if _, err := conn.Exec(context.Background(),
			`delete from system_setting where key = $1`, key); err != nil {
			t.Errorf("system_setting teardown failed: %v", err)
		}
	})
}

// SeedUnpublishedModel inserts a canonical model that is NOT in the catalogue:
// it has no provider_model mapping, so the publish gate (endpoint-surface spec
// §2.1: model active AND provider servable) hides it and /v1/models/{model}
// must answer 404 for it.
func SeedUnpublishedModel(t *testing.T, dsn string, env *Env, slug string) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	// LIFO: the row delete below runs before this close. See InsertPricingRule.
	t.Cleanup(func() { conn.Close(context.Background()) })
	id := ids.New("mdl")
	if _, err := conn.Exec(ctx, `
		insert into model (id, provider_id, name, slug, context, input_price, output_price, currency, status, created_at)
		values ($1,$2,'Unpublished',$3,128000,'150000.000000','600000.000000','USD','active', now())`,
		id, env.ProviderID, slug); err != nil {
		t.Fatalf("seed unpublished model: %v", err)
	}
	t.Cleanup(func() {
		if _, err := conn.Exec(context.Background(),
			`delete from model where id = $1`, id); err != nil {
			t.Errorf("unpublished model teardown failed (leaks row): %v", err)
		}
	})
}
