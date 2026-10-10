package proxy

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/apps/router/internal/store"
	"github.com/anvxxr-arch/fudrouter/apps/router/internal/vk"
)

// The catalogue cache key must carry BOTH the serving database and the
// dev-provider opt-in.
//
// It used to be the constant "rt:models:v1", so the production drill's second
// boot (ROUTER_ALLOW_DEV_PROVIDERS=1, same Valkey, same database) read the
// dev-hidden list its first boot had written seconds earlier and reported the
// spec §1 interlock broken — the interlock was fine, the cache was lying.
// These are the two ways it can come back.
func TestCatalogueCacheKeyIsolatesFlagAndDatabase(t *testing.T) {
	ctx := context.Background()

	newStore := func(t *testing.T, dsn, flag string) *store.Store {
		t.Helper()
		// Lazy pool: New parses the DSN and reads the flag without dialing,
		// so the key logic is testable with no database behind it.
		t.Setenv("ROUTER_ALLOW_DEV_PROVIDERS", flag)
		st, err := store.New(ctx, dsn)
		if err != nil {
			t.Fatalf("store.New(%s): %v", dsn, err)
		}
		t.Cleanup(st.Close)
		return st
	}
	// Port 1 is never a Postgres: nothing here may reach the network.
	const dsnA = "postgres://u:p@127.0.0.1:1/db_alpha"
	const dsnB = "postgres://u:p@127.0.0.1:1/db_beta"

	offA := newStore(t, dsnA, "")
	onA := newStore(t, dsnA, "1")
	offB := newStore(t, dsnB, "")

	hOffA := &Handler{store: offA}
	hOnA := &Handler{store: onA}
	hOffB := &Handler{store: offB}

	if hOffA.catalogueKey("models:v2") == hOnA.catalogueKey("models:v2") {
		t.Error("catalogue key ignores ROUTER_ALLOW_DEV_PROVIDERS: a process with the opt-in reads the dev-hidden list")
	}
	if hOffA.catalogueKey("models:v2") == hOffB.catalogueKey("models:v2") {
		t.Error("catalogue key ignores the database: two deployments sharing one Valkey share one answer")
	}
	if hOnA.catalogueKey("model:v2", "m") == hOffA.catalogueKey("model:v2", "m") {
		t.Error("per-model key ignores ROUTER_ALLOW_DEV_PROVIDERS")
	}

	// Positive control: the same handler reads back what it wrote, so the
	// negative assertion below cannot pass on a key builder that is merely
	// unique.
	fake := vk.NewFake()
	entry := []store.ModelInfo{{Slug: "dev-hidden-model"}}
	if err := fake.SetJSON(ctx, hOffA.catalogueKey("models:v2"), entry, time.Minute); err != nil {
		t.Fatalf("seed: %v", err)
	}
	var back []store.ModelInfo
	if err := fake.GetJSON(ctx, hOffA.catalogueKey("models:v2"), &back, time.Second); err != nil {
		t.Fatalf("positive control: the writer cannot read its own entry: %v", err)
	}
	if len(back) != 1 || back[0].Slug != "dev-hidden-model" {
		t.Fatalf("positive control: got %+v", back)
	}

	// The regression itself: the opt-in must not be served the other one's
	// list out of the shared cache.
	var leaked []store.ModelInfo
	err := fake.GetJSON(ctx, hOnA.catalogueKey("models:v2"), &leaked, time.Second)
	if !errors.Is(err, vk.ErrNotFound) {
		t.Errorf("dev-opt-in handler read the dev-hidden entry (err=%v, leaked=%+v)", err, leaked)
	}
}

// A policy entry is scoped by the key's environment/project/workspace triple —
// the only inputs RoutingPolicyFor reads. An unscoped key must not share an
// entry with a scoped one either.
func TestPolicyCacheKeyIsolatesScopeAndDatabase(t *testing.T) {
	ctx := context.Background()
	newStore := func(t *testing.T, dsn string) *store.Store {
		t.Helper()
		st, err := store.New(ctx, dsn)
		if err != nil {
			t.Fatalf("store.New(%s): %v", dsn, err)
		}
		t.Cleanup(st.Close)
		return st
	}
	hA := &Handler{store: newStore(t, "postgres://u:p@127.0.0.1:1/db_alpha")}
	hB := &Handler{store: newStore(t, "postgres://u:p@127.0.0.1:1/db_beta")}

	scoped := hA.policyKey("env_1", "prj_1", "wsp_1")
	if scoped == hA.policyKey("", "", "") {
		t.Error("policy key collapses an unscoped key into a scoped entry")
	}
	if scoped == hA.policyKey("env_1", "prj_1", "wsp_2") {
		t.Error("policy key ignores the workspace")
	}
	if scoped == hB.policyKey("env_1", "prj_1", "wsp_1") {
		t.Error("policy key ignores the database: two deployments share one policy entry")
	}
}
