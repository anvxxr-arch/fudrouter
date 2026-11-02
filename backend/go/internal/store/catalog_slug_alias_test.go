package store_test

// Canonical model identity (migration 0026) and the two defects it exists to
// close. Both were MEASURED on the real catalogue loaded into this test
// database (26 providers, 570 models, 523 provider_model rows, 74242
// credentials), not synthesised.
//
// WHY the identity table exists: `model.slug` is NOT NULL UNIQUE, and the bulk
// onboarders mint one row per (provider, upstream model id) with the provider
// namespace PREFIXED onto the slug and the upstream's own CASING. So ONE
// upstream model exists as several canonical rows — `kimi-k2.6`, `Kimi-K2.6`
// and `tokenharbor/kimi-k2.6` are three — and the candidate fan-out
// (`model.id -> provider_model -> provider`) gives each row only ITS OWN
// providers. An upstream model reachable through four providers becomes four
// depth-1 rows instead of one depth-4 model, and the attempt walker has nothing
// to fail over to when the first provider is down. 118 of the 570 rows belong
// to a family of two or more.
//
// WHY nothing is renamed: those prefixed and mixed-case strings are in the
// wild, and `request_log.model_id` still references the rows. The identity is
// recorded as an ADDITIONAL resolution arm that only fires when the literal arm
// MISSES, so a client-visible slug resolves to exactly the row it resolves to
// today.
//
// The table is `model_slug_alias`, deliberately NOT `model_alias` — that name
// belongs to a DIFFERENT feature that already exists (0006): a
// customer-authored NAME for an ordered SET of models, scoped per account. Its
// `(account_id, name)` unique index cannot carry a canonical-slug identity
// without overloading `name` with two meanings. One table per concept.

import (
	"context"
	"os"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
	"github.com/jackc/pgx/v5"
)

// slugAliasMigrationPath is the migration this file pins, relative to the
// package directory (`go test` runs each test binary from its own package dir).
const slugAliasMigrationPath = "../../migrations/0026_model_slug_alias.sql"

// TestVirtualAutoTargetsAreAllRoutable is the headline contract of this
// workstream: every model `fudrouter/auto` advertises must have at least one
// candidate the request path can actually attempt.
//
// WHY it is the headline: `activeModelIDs` builds the virtual's target set and
// the routing strategy SCORES that set before CandidatesBatch filters it. A
// model the batch discards is therefore not merely wasted work — it is a dead
// end the virtual advertises to its own admission loop. Measured before the
// fix: 38 active models carry an explicit `capabilities->'chat' = false` (image,
// video, audio and embedding rows) and `fudrouter/auto`, whose only requirement
// IS chat, listed every one of them, so 41 of its 200 targets could never come
// back with a candidate. An empty `CandidatesBatch` slice for an advertised
// model is that dead end made visible.
func TestVirtualAutoTargetsAreAllRoutable(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	ctx := context.Background()

	s, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	key := &store.APIKeyRow{UserID: env.UserID}

	// A second model, explicitly NOT chat-capable, hanging off the same
	// routable connection. It is the exact shape the dead ends had: active,
	// enabled mapping, live credential — and a capability the virtual's own
	// requirement contradicts.
	nonChatID := seedNonChatModel(t, dsn, env)

	res, err := s.ResolveModel(ctx, key, "fudrouter/auto")
	if err != nil {
		t.Fatalf("fudrouter/auto: %v", err)
	}
	if res.Kind != "virtual" {
		t.Fatalf("kind = %q, want virtual", res.Kind)
	}

	advertised := map[string]bool{}
	for _, id := range res.ModelIDs {
		advertised[id] = true
	}
	if advertised[nonChatID] {
		t.Error("fudrouter/auto advertises a model whose capabilities->>'chat' is false — " +
			"CandidatesBatch will always discard it, so the virtual is promising a dead end")
	}
	if !advertised[env.ModelID] {
		t.Fatal("fudrouter/auto dropped the chat-capable seeded model — the filter is too aggressive")
	}

	// The rule that matters: advertise ⊆ routable. Asserted through the batch
	// the admission loop actually calls, not a re-implementation of it.
	byModel, err := s.CandidatesBatch(ctx, res.ModelIDs, res.RequiredCapabilities)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range res.ModelIDs {
		if len(byModel[id]) == 0 {
			t.Errorf("fudrouter/auto advertised model %s with zero candidates", id)
		}
	}
}

// TestModelSlugAliasBackfillAndRouting pins both halves of migration 0026:
// the backfill picks the right survivor, and an OLD prefixed slug still routes
// after the duplicate row it used to name is gone.
//
// WHY the duplicate must be deleted to observe the alias arm: the literal arm
// wins on a live slug (deliberate — client-visible slugs behave exactly as
// today), so while the prefixed row exists the alias for it is never consulted.
// The alias is what keeps the name alive once an operator merges the duplicate
// away, which is the whole point of the identity table.
func TestModelSlugAliasBackfillAndRouting(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	ctx := context.Background()

	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)

	// A provider-prefixed duplicate of the SAME upstream model: the leaf is
	// already a slug of its own, which is what makes the family unambiguous and
	// is the only prefixed shape the backfill collapses.
	dupSlug := "vendorA/" + env.Slug
	dupID := "mdl_dupslug_" + tests.RandChars(8)
	if _, err := conn.Exec(ctx, `
		insert into model (id, provider_id, name, slug, context, input_price, output_price, status)
		values ($1,$2,'Duplicate',$3,8192,'150000.000000','600000.000000','active')`,
		dupID, env.ProviderID, dupSlug); err != nil {
		t.Fatalf("seed duplicate model: %v", err)
	}
	t.Cleanup(func() {
		// Belt and braces: the assertion below deletes it, and this covers an
		// early Fatal. The alias row cascades off the CANONICAL row, so it is
		// removed by the alias cleanup instead.
		_, _ = conn.Exec(context.Background(), `delete from model where id = $1`, dupID)
		_, _ = conn.Exec(context.Background(), `delete from model_slug_alias where alias = $1`, dupSlug)
	})

	// Run the migration ITSELF, so this test fails if the file's backfill and
	// the code drift apart.
	runSlugAliasMigration(t, conn)

	var canonical string
	if err := conn.QueryRow(ctx,
		`select canonical_model_id from model_slug_alias where alias = $1`, dupSlug,
	).Scan(&canonical); err != nil {
		t.Fatalf("backfill did not create an alias for %s: %v", dupSlug, err)
	}
	// Plain, lower-case, active beats prefixed — the identity a customer would
	// name, so the seeded canonical row must be the survivor.
	if canonical != env.ModelID {
		t.Fatalf("alias %s -> %s, want the plain seeded row %s", dupSlug, canonical, env.ModelID)
	}

	// While the prefixed row is live, the literal arm owns the name (unchanged
	// client-visible behaviour) — this is the promise the migration must not
	// break.
	s, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	key := &store.APIKeyRow{UserID: env.UserID}

	lit, err := s.ResolveModel(ctx, key, dupSlug)
	if err != nil {
		t.Fatalf("%s (live slug): %v", dupSlug, err)
	}
	if len(lit.ModelIDs) != 1 || lit.ModelIDs[0] != dupID {
		t.Fatalf("%s resolved to %v, want the live row %s — the literal arm must win", dupSlug, lit.ModelIDs, dupID)
	}

	// Merge the duplicate away: this is the state the alias exists for.
	if _, err := conn.Exec(ctx, `delete from model where id = $1`, dupID); err != nil {
		t.Fatalf("delete duplicate: %v", err)
	}

	old, err := s.ResolveModel(ctx, key, dupSlug)
	if err != nil {
		t.Fatalf("%s after the duplicate is merged away: %v — the old name stopped resolving", dupSlug, err)
	}
	if old.Kind != "model" {
		t.Errorf("kind = %q, want model (an input-name remap is not a new resolution shape)", old.Kind)
	}
	if len(old.ModelIDs) != 1 || old.ModelIDs[0] != env.ModelID {
		t.Fatalf("%s resolved to %v, want the canonical row %s", dupSlug, old.ModelIDs, env.ModelID)
	}
	// Resolving is not enough — the name has to ROUTE.
	cands, err := s.Candidates(ctx, old.ModelIDs[0], nil)
	if err != nil || len(cands) == 0 {
		t.Fatalf("old slug %s resolved but does not route: %v (%d candidates)", dupSlug, err, len(cands))
	}

	// The canonical slug itself is untouched by the addition.
	self, err := s.ResolveModel(ctx, key, env.Slug)
	if err != nil {
		t.Fatalf("canonical slug %s: %v", env.Slug, err)
	}
	if len(self.ModelIDs) != 1 || self.ModelIDs[0] != env.ModelID {
		t.Fatalf("canonical slug resolved to %v, want itself %s", self.ModelIDs, env.ModelID)
	}
}

// TestModelSlugAliasMigrationIsIdempotent executes the migration twice. Every
// migration file in this repo is re-runnable because a partially-applied
// database — or a rehearsal that follows the documented pg_dump + migrate
// recipe — must converge instead of aborting on the second run. A second
// application that inserted duplicate alias rows, or that failed on the
// existing table, would break that.
func TestModelSlugAliasMigrationIsIdempotent(t *testing.T) {
	dsn := tests.RequireDB(t)
	ctx := context.Background()

	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)

	before := countSlugAliases(t, conn)
	runSlugAliasMigration(t, conn)
	runSlugAliasMigration(t, conn)
	after := countSlugAliases(t, conn)
	if after != before {
		t.Errorf("running the migration twice changed the alias row count: %d -> %d", before, after)
	}
}

// runSlugAliasMigration executes the migration file verbatim. No arguments, so
// pgx uses the simple protocol and the file's multiple statements are one call
// — the same way ops/migrate.sh applies it.
func runSlugAliasMigration(t *testing.T, conn *pgx.Conn) {
	t.Helper()
	sql, err := os.ReadFile(slugAliasMigrationPath)
	if err != nil {
		t.Fatalf("read %s: %v", slugAliasMigrationPath, err)
	}
	if _, err := conn.Exec(context.Background(), string(sql)); err != nil {
		t.Fatalf("apply %s: %v", slugAliasMigrationPath, err)
	}
}

func countSlugAliases(t *testing.T, conn *pgx.Conn) int {
	t.Helper()
	var n int
	if err := conn.QueryRow(context.Background(), `select count(*) from model_slug_alias`).Scan(&n); err != nil {
		t.Fatalf("count model_slug_alias: %v", err)
	}
	return n
}

// seedNonChatModel hangs an explicitly non-chat model off the seeded provider's
// live connection, so its mapping satisfies every predicate EXCEPT the
// capability the virtual requires. That is the exact shape of the dead ends.
func seedNonChatModel(t *testing.T, dsn string, env *tests.Env) string {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(context.Background()) })

	id := "mdl_nonchat_" + tests.RandChars(8)
	slug := "nonchat-" + tests.RandChars(6)
	if _, err := conn.Exec(ctx, `
		insert into model (id, provider_id, name, slug, context, input_price, output_price, status, capabilities)
		values ($1,$2,'NonChat',$3,8192,'150000.000000','600000.000000','active','{"chat": false}'::jsonb)`,
		id, env.ProviderID, slug); err != nil {
		t.Fatalf("seed non-chat model: %v", err)
	}
	if _, err := conn.Exec(ctx, `
		insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled, status)
		values ($1,$2,$3,$4,$5,true,'available')`,
		"pmdl_nonchat_"+tests.RandChars(8), id, env.ProviderID, env.ConnectionID, slug); err != nil {
		t.Fatalf("seed non-chat mapping: %v", err)
	}
	t.Cleanup(func() {
		if _, err := conn.Exec(context.Background(), `delete from provider_model where model_id = $1`, id); err != nil {
			t.Errorf("teardown leaked a provider_model row: %v", err)
		}
		if _, err := conn.Exec(context.Background(), `delete from model where id = $1`, id); err != nil {
			t.Errorf("teardown leaked a model row: %v", err)
		}
	})
	return id
}
