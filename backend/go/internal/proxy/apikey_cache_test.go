package proxy

import (
	"context"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/vk"
)

// The API key cache (apikey_cache.go) removes a Postgres round trip from every
// request — measured live 2026-10-31 at p95 518 ms for the `auth` phase.
//
// It must not break the documented contract that "revocation takes effect
// immediately for new requests" (public.mjs). These tests pin the three ways it
// could: a cached row that outlives its revocation, a cached row that outlives
// its expiry, and a cache key that does not match the one the console deletes.

// cacheTestHandler builds a Handler with a fake Valkey and a store pointed at a
// dead DSN, so any DB read is a hard failure — which is exactly what proves the
// cache served the request.
func cacheTestHandler(t *testing.T) (*Handler, *vk.Fake) {
	t.Helper()
	st, err := store.New(context.Background(), "postgres://u:p@127.0.0.1:1/dead")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(st.Close)
	fake := vk.NewFake()
	return &Handler{store: st, vk: fake}, fake
}

// A cached row is served without touching the database. The store points at a
// dead DSN, so a DB read would error — a 200 here can only come from the cache.
func TestAPIKeyCacheServesWithoutDB(t *testing.T) {
	ctx := context.Background()
	h, fake := cacheTestHandler(t)

	row := &store.APIKeyRow{ID: "key_1", UserID: "usr_1", KeyHash: "hash", Status: "active"}
	if err := fake.SetJSON(ctx, h.apiKeyCacheKey("pref1"), row, time.Minute); err != nil {
		t.Fatal(err)
	}

	got, err := h.cachedAPIKeyRow(ctx, "pref1")
	if err != nil {
		t.Fatalf("cached read: %v (a DB read against the dead DSN would also fail here)", err)
	}
	if got.ID != "key_1" || got.KeyHash != "hash" {
		t.Errorf("got %+v, want the cached row", got)
	}
}

// The invalidation contract: deleting the entry (what the console does on
// revoke) must make the next read miss the cache. The store is dead, so the
// read then fails — which is the honest proof that the delete took effect.
func TestAPIKeyCacheInvalidationForcesMiss(t *testing.T) {
	ctx := context.Background()
	h, fake := cacheTestHandler(t)

	row := &store.APIKeyRow{ID: "key_1", UserID: "usr_1", KeyHash: "hash", Status: "active"}
	key := h.apiKeyCacheKey("pref1")
	if err := fake.SetJSON(ctx, key, row, time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, err := h.cachedAPIKeyRow(ctx, "pref1"); err != nil {
		t.Fatalf("warm read: %v", err)
	}

	// What invalidateApiKeyCache does.
	if err := fake.Del(ctx, key); err != nil {
		t.Fatal(err)
	}

	if _, err := h.cachedAPIKeyRow(ctx, "pref1"); err == nil {
		t.Error("read after invalidation succeeded — the entry survived the delete, so a revoked key would keep authenticating")
	}
}

// A key that expired while its row sat in the cache must not authenticate. The
// gate runs on the cached copy, not only on a fresh DB read.
func TestAPIKeyCacheRejectsExpiredRow(t *testing.T) {
	ctx := context.Background()
	h, fake := cacheTestHandler(t)

	past := time.Now().Add(-time.Minute)
	row := &store.APIKeyRow{ID: "key_1", UserID: "usr_1", KeyHash: "hash", Status: "active", ExpiresAt: &past}
	if err := fake.SetJSON(ctx, h.apiKeyCacheKey("pref1"), row, time.Minute); err != nil {
		t.Fatal(err)
	}

	_, err := h.cachedAPIKeyRow(ctx, "pref1")
	if err == nil {
		t.Fatal("an expired cached row authenticated")
	}
	if err != store.ErrKeyExpired {
		t.Errorf("err = %v, want ErrKeyExpired", err)
	}
}

// A revoked row in the cache must not authenticate either — the status gate is
// re-applied to the cached copy.
func TestAPIKeyCacheRejectsRevokedRow(t *testing.T) {
	ctx := context.Background()
	h, fake := cacheTestHandler(t)

	row := &store.APIKeyRow{ID: "key_1", UserID: "usr_1", KeyHash: "hash", Status: "revoked"}
	if err := fake.SetJSON(ctx, h.apiKeyCacheKey("pref1"), row, time.Minute); err != nil {
		t.Fatal(err)
	}

	_, err := h.cachedAPIKeyRow(ctx, "pref1")
	if err != store.ErrKeyInactive {
		t.Errorf("err = %v, want ErrKeyInactive", err)
	}
}

// The cache key must be namespaced by database, or two deployments sharing one
// Valkey would answer from each other's key rows.
func TestAPIKeyCacheKeyIsolatesDatabase(t *testing.T) {
	ctx := context.Background()
	mk := func(dsn string) *Handler {
		st, err := store.New(ctx, dsn)
		if err != nil {
			t.Fatalf("store.New(%s): %v", dsn, err)
		}
		t.Cleanup(st.Close)
		return &Handler{store: st}
	}
	a := mk("postgres://u:p@127.0.0.1:1/db_alpha")
	b := mk("postgres://u:p@127.0.0.1:1/db_beta")
	if a.apiKeyCacheKey("pref1") == b.apiKeyCacheKey("pref1") {
		t.Error("api key cache key ignores the database: two deployments share one key row")
	}
}
