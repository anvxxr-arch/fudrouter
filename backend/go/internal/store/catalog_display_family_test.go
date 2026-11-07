package store_test

// The catalogue publishes ONE entry per same-model display family, not one per
// raw slug. On the deployed catalogue one upstream model exists as several rows
// — `deepseek-v4.1-flash`, `tokenharbor/deepseek-v4.1-flash:free`,
// `deepseek-v4.1-flash:free` — because the bulk onboarders mint a row per
// (provider, upstream id) with the provider namespace prefixed and the
// upstream's own casing, and the model farms publish trailing variants
// (`:free`, `-thinking`, `-fast`). Listing each spelling separately advertised
// the same model five times at five prices.
//
// The fold is DISPLAY ONLY. `ResolveModel` and billing still see the raw slug,
// deliberately: folding `-thinking` at resolution would serve the
// non-reasoning base to a client that explicitly asked for the reasoning
// variant, and folding `:free` would merge free/paid pricing in the biller.
// These tests pin the presentation contract and nothing about resolution.

import (
	"context"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/ids"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
	"github.com/jackc/pgx/v5"
)

// displayFixture seeds rows of ONE display family on the env's provider and
// returns the ids by spelling. Every row is a real chat model with a live
// provider_model mapping, so the servable gate is satisfied for each.
func displayFixture(t *testing.T, dsn string, env *tests.Env, base string, slugs ...string) map[string]string {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(context.Background()) })

	out := map[string]string{}
	for _, slug := range slugs {
		id := ids.New("mdl")
		if _, err := conn.Exec(ctx, `
			insert into model (id, provider_id, name, slug, context, input_price, output_price, currency, status, capabilities)
			values ($1,$2,$3,$4,128000,'150000.000000','600000.000000','USD','active','{"chat":true}'::jsonb)`,
			id, env.ProviderID, slug, slug); err != nil {
			t.Fatalf("seed model %s: %v", slug, err)
		}
		if _, err := conn.Exec(ctx, `
			insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled, status)
			values ($1,$2,$3,$4,$5,true,'available')`,
			ids.New("pmdl"), id, env.ProviderID, env.ConnectionID, slug); err != nil {
			t.Fatalf("seed provider_model %s: %v", slug, err)
		}
		t.Cleanup(func() {
			if _, err := conn.Exec(context.Background(), `delete from provider_model where model_id = $1`, id); err != nil {
				t.Errorf("teardown leaked a provider_model row: %v", err)
			}
			if _, err := conn.Exec(context.Background(), `delete from model where id = $1`, id); err != nil {
				t.Errorf("teardown leaked a model row: %v", err)
			}
		})
		out[slug] = id
	}
	return out
}

// TestDisplayFamilyIDsFoldsVariantsAndAliases is the headline contract: every
// spelling of one model is ONE family, the list publishes exactly one entry for
// it, and the detail endpoint answers every spelling with that same entry.
func TestDisplayFamilyIDsFoldsVariantsAndAliases(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	ctx := context.Background()

	base := "foldbase-" + tests.RandChars(6)
	// The env's own row becomes the plain base; the variants hang off it.
	if _, err := pgx.Connect(ctx, dsn); err != nil {
		t.Fatal(err)
	}
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(context.Background()) })
	if _, err := conn.Exec(ctx, `update model set slug = $2, capabilities = '{"chat":true}'::jsonb where id = $1`,
		env.ModelID, base); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		// The seeder's own teardown matches the id, not the slug.
		if _, err := conn.Exec(context.Background(), `update model set slug = $2 where id = $1`, env.ModelID, env.Slug); err != nil {
			t.Errorf("restore base slug: %v", err)
		}
	})

	prefixed := "zro/" + base
	idsBySlug := displayFixture(t, dsn, env, base, base+":free", base+"-thinking:free", prefixed)
	if _, err := conn.Exec(ctx, `insert into model_slug_alias (alias, canonical_model_id) values ($1,$2)`,
		prefixed, env.ModelID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := conn.Exec(context.Background(), `delete from model_slug_alias where alias = $1`, prefixed); err != nil {
			t.Errorf("teardown leaked an alias row: %v", err)
		}
	})

	st, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	want := []string{env.ModelID, idsBySlug[base+":free"], idsBySlug[base+"-thinking:free"], idsBySlug[prefixed]}
	family, err := st.DisplayFamilyIDs(ctx, base)
	if err != nil {
		t.Fatal(err)
	}
	if len(family) != len(want) {
		t.Fatalf("DisplayFamilyIDs(%s) = %v, want the %d family members %v", base, family, len(want), want)
	}
	got := map[string]bool{}
	for _, id := range family {
		got[id] = true
	}
	for _, id := range want {
		if !got[id] {
			t.Errorf("family is missing %s: %v", id, family)
		}
	}

	// The list publishes ONE entry, under the plainest slug, and the variants
	// are gone from it.
	models, err := st.ActiveModels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var listed []string
	for _, m := range models {
		switch m.Slug {
		case base, base + ":free", base + "-thinking:free", prefixed:
			listed = append(listed, m.Slug)
		}
	}
	if len(listed) != 1 || listed[0] != base {
		t.Fatalf("catalogue emitted %v for one family, want exactly [%s]", listed, base)
	}

	// Every spelling of the family answers the detail endpoint with the SAME
	// object the list publishes — the endpoint-surface §7 invariant.
	for _, slug := range []string{base, base + ":free", base + "-thinking:free", prefixed} {
		published, err := st.PublishedModel(ctx, slug)
		if err != nil {
			t.Fatalf("PublishedModel(%s): %v", slug, err)
		}
		if published.Slug != base {
			t.Errorf("PublishedModel(%s) = %s, want the list entry %s", slug, published.Slug, base)
		}
	}
}

// TestDisplayFamilyFollowsVariantChainsTransitively pins the shape the real
// catalogue actually has: a prefixed variant is aliased to a variant, and also
// has its own prefixed sibling. A one-hop fold stops at the sibling and leaves
// a second entry; the closure must reach the plain base.
func TestDisplayFamilyFollowsVariantChainsTransitively(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	ctx := context.Background()

	base := "chainbase-" + tests.RandChars(6)
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(context.Background()) })
	if _, err := conn.Exec(ctx, `update model set slug = $2, capabilities = '{"chat":true}'::jsonb where id = $1`,
		env.ModelID, base); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := conn.Exec(context.Background(), `update model set slug = $2 where id = $1`, env.ModelID, env.Slug); err != nil {
			t.Errorf("restore base slug: %v", err)
		}
	})

	free := base + ":free"
	prefixedFree := "tokenharbor/" + base + ":free"
	prefixedBase := "tokenharbor/" + base
	idsBySlug := displayFixture(t, dsn, env, base, free, prefixedFree, prefixedBase)
	if _, err := conn.Exec(ctx, `insert into model_slug_alias (alias, canonical_model_id) values ($1,$2)`,
		prefixedFree, idsBySlug[free]); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := conn.Exec(context.Background(), `delete from model_slug_alias where alias = $1`, prefixedFree); err != nil {
			t.Errorf("teardown leaked an alias row: %v", err)
		}
	})

	st, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	family, err := st.DisplayFamilyIDs(ctx, base)
	if err != nil {
		t.Fatal(err)
	}
	if len(family) != 4 {
		t.Fatalf("DisplayFamilyIDs(%s) = %v, want all 4 chained members", base, family)
	}

	models, err := st.ActiveModels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var listed []string
	for _, m := range models {
		switch m.Slug {
		case base, free, prefixedFree, prefixedBase:
			listed = append(listed, m.Slug)
		}
	}
	if len(listed) != 1 || listed[0] != base {
		t.Fatalf("chained family emitted %v, want exactly [%s]", listed, base)
	}
}

// TestActiveModelsKeepsFamilyWhileAnyMemberIsServable is the combo promise at
// the catalogue layer: a family whose primary provider has no usable credential
// stays published while a sibling provider still serves it. Publishing "gone"
// because the primary is down is the same lie as publishing "down" for it.
func TestActiveModelsKeepsFamilyWhileAnyMemberIsServable(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	ctx := context.Background()

	base := "combobase-" + tests.RandChars(6)
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(context.Background()) })
	if _, err := conn.Exec(ctx, `update model set slug = $2, capabilities = '{"chat":true}'::jsonb where id = $1`,
		env.ModelID, base); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := conn.Exec(context.Background(), `update model set slug = $2 where id = $1`, env.ModelID, env.Slug); err != nil {
			t.Errorf("restore base slug: %v", err)
		}
	})
	displayFixture(t, dsn, env, base, base+":free")

	// The base row gets its OWN provider + connection so parking it does not
	// touch the variant's provider — the primary/fallback split.
	primaryProv := ids.New("prv")
	if _, err := conn.Exec(ctx, `
		insert into provider (id, name, base_url, credentials_enc, status, tier, priority)
		values ($1,$2,'http://127.0.0.1:1','','operational','commercial',100)`,
		primaryProv, "primary-"+tests.RandChars(6)); err != nil {
		t.Fatal(err)
	}
	primaryConn := ids.New("con")
	if _, err := conn.Exec(ctx, `
		insert into connection (id, provider_id, name, slug, base_url)
		values ($1,$2,'primary','primary','http://127.0.0.1:1')`, primaryConn, primaryProv); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		insert into credential (id, connection_id, name, secret_enc, status, priority, weight)
		values ($1,$2,'primary','','healthy',100,100)`, ids.New("cred"), primaryConn); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled, status)
		values ($1,$2,$3,$4,$5,true,'available')`,
		ids.New("pmdl"), env.ModelID, primaryProv, primaryConn, base); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		conn.Exec(context.Background(), `delete from provider_model where connection_id = $1`, primaryConn)
		conn.Exec(context.Background(), `delete from credential where connection_id = $1`, primaryConn)
		conn.Exec(context.Background(), `delete from connection where id = $1`, primaryConn)
		conn.Exec(context.Background(), `delete from provider where id = $1`, primaryProv)
	})

	st, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	// Park the primary's only credential: the base row is now unroutable while
	// its `:free` sibling still has a live provider.
	if _, err := conn.Exec(ctx, `update credential set cooldown_until = now() + interval '1 hour' where connection_id = $1`, primaryConn); err != nil {
		t.Fatal(err)
	}
	models, err := st.ActiveModels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, m := range models {
		if m.Slug == base {
			found = true
		}
	}
	if !found {
		t.Fatal("family vanished from the catalogue although a member provider is still servable")
	}
	if _, err := st.PublishedModel(ctx, base); err != nil {
		t.Fatalf("PublishedModel(%s) after parking the primary: %v", base, err)
	}

	// Now take the last servable member away too: the family must disappear.
	if _, err := conn.Exec(ctx, `update provider_model set enabled = false where model_id = $1 and provider_id = $2`,
		env.ModelID, env.ProviderID); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `update provider_model set enabled = false where model_id <> $1 and provider_id = $2`,
		env.ModelID, env.ProviderID); err != nil {
		t.Fatal(err)
	}
	models, err = st.ActiveModels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range models {
		if m.Slug == base {
			t.Fatal("family still published with no servable member")
		}
	}
}

// TestVariantSuffixWithoutBaseKeepsItsOwnEntry pins the fold's GUARD: a trailing
// suffix only folds when the stripped remainder names an existing active chat
// row. `command-a-plus:free` has no `command-a-plus`, so it is a model in its
// own right and must keep its entry. Without the guard every slug ending in
// `:free` would be swallowed by a base that does not exist.
//
// `glm-4.7-flash` is the control: `-flash` is NOT a variant suffix, so a model
// whose name merely ends in a stripped-looking token stays untouched.
func TestVariantSuffixWithoutBaseKeepsItsOwnEntry(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	ctx := context.Background()

	// Both rows are chat models with live mappings but NO base row exists.
	idsBySlug := displayFixture(t, dsn, env, "", "command-a-plus:free", "glm-4.7-flash")

	st, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	models, err := st.ActiveModels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	listed := map[string]bool{}
	for _, m := range models {
		listed[m.Slug] = true
	}
	for _, slug := range []string{"command-a-plus:free", "glm-4.7-flash"} {
		if !listed[slug] {
			t.Errorf("%q vanished from the catalogue: a suffix with no base row must not fold", slug)
		}
		published, err := st.PublishedModel(ctx, slug)
		if err != nil {
			t.Errorf("PublishedModel(%s): %v", slug, err)
			continue
		}
		if published.Slug != slug {
			t.Errorf("PublishedModel(%s) = %s, want itself", slug, published.Slug)
		}
		// Each stays its own single-member family.
		family, err := st.DisplayFamilyIDs(ctx, slug)
		if err != nil {
			t.Fatalf("DisplayFamilyIDs(%s): %v", slug, err)
		}
		if len(family) != 1 || family[0] != idsBySlug[slug] {
			t.Errorf("family(%s) = %v, want only its own id", slug, family)
		}
	}
}
