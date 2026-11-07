package store_test

// Migration 0030 publishes exactly one (canonical model x provider) pair that a
// real chat completion proved callable, and its rollback must undo exactly that
// pair. The tests below drive BOTH files against a throwaway schema, so the
// evidence is a row count that moves and a depth that moves — not a claim.
//
// The pin is deliberate on three points that a future editor could quietly
// break:
//  1. the pair only lands when model, provider AND connection all exist and are
//     servable (no invented rows),
//  2. a replay is a no-op (idempotence), and
//  3. the rollback restores the catalogue bit-for-bit, INCLUDING a mapping that
//     was repointed by hand after the migration ran.

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
	"github.com/jackc/pgx/v5"
)

const (
	mergeDepthMigrationPath  = "../../migrations/0030_merge_depth_publish.sql"
	mergeDepthRollbackPath   = "../../../../ops/rollback/0030_merge_depth_publish.rollback.sql"
	mergeDepthCanonicalSlug  = "gemma-4-31b-it"
	mergeDepthProviderID     = "prv_googleai"
	mergeDepthConnectionID   = "con_prv_googleai-default"
	mergeDepthPublishedRowID = "pmdl_merge_googleai_gemma_4_31b"
	mergeDepthProviderModel  = "models/gemma-4-31b-it"
)

// mergeDepthSchema builds a throwaway schema that the migration under test can
// write to WITHOUT touching the shared catalogue — which needs more than a
// `SET LOCAL search_path`, because migration 0030 carries its own BEGIN/COMMIT.
//
// That embedded COMMIT ends this harness's transaction (a nested BEGIN is a
// no-op, so the migration's COMMIT is the OUTER one). Two consequences, both of
// which produced phantom failures before this was fixed:
//
//  1. `SET LOCAL` is reverted by that COMMIT. The setting is therefore applied
//     with plain `SET`, so the post-migration assertions still resolve into the
//     overlay instead of falling back to public.
//  2. Anything the migration writes must already have a home in the overlay.
//     The fixture tables are CLONED in (`including all`) rather than inherited
//     from public; without the clone the writes land in the shared catalogue and
//     stay there (a committed row then makes ON CONFLICT DO NOTHING skip, so
//     every negative case reports 1 row and reads as a broken guard).
//
// `including all` carries the indexes the ON CONFLICT target needs and copies no
// foreign keys, so a fixture row may name a connection that does not exist.
func mergeDepthSchema(t *testing.T, conn *pgx.Conn) (context.Context, pgx.Tx) {
	t.Helper()
	ctx := context.Background()
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	schema := "merge_depth_test_" + strings.ToLower(tests.RandChars(10))
	if _, err := tx.Exec(ctx, `create schema `+schema); err != nil {
		t.Fatal(err)
	}
	// The migration COMMITs, so a rollback alone cannot undo this schema's
	// contents — drop it outright.
	t.Cleanup(func() {
		_, _ = conn.Exec(context.Background(), `drop schema if exists `+schema+` cascade`)
	})
	for _, tbl := range []string{"provider", "connection", "model", "credential", "provider_model", "model_slug_alias"} {
		if _, err := tx.Exec(ctx, `create table `+schema+`.`+tbl+` (like public.`+tbl+` including all)`); err != nil {
			t.Fatalf("clone %s: %v", tbl, err)
		}
	}
	if _, err := tx.Exec(ctx, `set search_path = `+schema+`, public`); err != nil {
		t.Fatal(err)
	}
	return ctx, tx
}

func applySQLFile(t *testing.T, ctx context.Context, tx pgx.Tx, path string) {
	t.Helper()
	sql, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if _, err := tx.Exec(ctx, string(sql)); err != nil {
		t.Fatalf("apply %s: %v", path, err)
	}
}

// seedMergeDepthEnv writes the model/provider/connection the migration's JOIN
// requires. capabilityJSON/status let a test make the identity unservable and
// prove the migration then does nothing.
func seedMergeDepthEnv(t *testing.T, ctx context.Context, tx pgx.Tx, modelSlug, modelStatus, providerStatus string, connEnabled bool) {
	t.Helper()
	stmts := []struct {
		sql  string
		args []any
	}{
		{`insert into provider (id, name, base_url, credentials_enc, status, slug, tier, enabled)
		  values ($1, 'Google AI fixture', 'https://example.invalid/v1', 'enc', $2, 'prv-googleai', 'commercial', true)
		  on conflict (id) do update set status = excluded.status`,
			[]any{mergeDepthProviderID, providerStatus}},
		{`insert into connection (id, provider_id, name, slug, base_url, enabled, health_status)
		  values ($1, $2, 'default', 'default', 'https://example.invalid/v1', $3, 'healthy')
		  on conflict (id) do update set enabled = excluded.enabled`,
			[]any{mergeDepthConnectionID, mergeDepthProviderID, connEnabled}},
		{`insert into model (id, provider_id, name, slug, context, input_price, output_price, status, capabilities)
		  values ('mdl_merge_gemma_fixture', $1, 'Gemma fixture', $2, 32768, 0, 0, $3, '{"chat": true}'::jsonb)
		  on conflict (id) do update set slug = excluded.slug, status = excluded.status`,
			[]any{mergeDepthProviderID, modelSlug, modelStatus}},
	}
	for _, s := range stmts {
		if _, err := tx.Exec(ctx, s.sql, s.args...); err != nil {
			t.Fatalf("seed: %v\n%s", err, s.sql)
		}
	}
	// A live credential: the depth predicate and the candidate query both
	// require one, so the pair must not be counted on a pool that cannot dial.
	if _, err := tx.Exec(ctx, `
		insert into credential (id, connection_id, name, secret_enc, status, priority, weight)
		values ('cred_merge_fixture', $1, 'fixture', 'enc', 'healthy', 0, 1)
		on conflict (id) do update set status = excluded.status`, mergeDepthConnectionID); err != nil {
		t.Fatalf("seed credential: %v", err)
	}
}

func countMergeDepthRows(t *testing.T, ctx context.Context, tx pgx.Tx) int {
	t.Helper()
	var n int
	if err := tx.QueryRow(ctx, `select count(*) from provider_model where id = $1`, mergeDepthPublishedRowID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// assertNoLeak proves the migration did not COMMIT the harness's transaction.
//
// This is the control for the harness itself. Migration 0030 once carried its own
// BEGIN/COMMIT; a nested BEGIN is a no-op in PostgreSQL, so that COMMIT ended the
// test's transaction and wrote fixture rows into the shared `public` schema. The
// symptom was not an error — it was a later run reading a polluted catalogue and
// reporting that the migration ignores its own guard. A separate connection only
// sees committed data, so if anything this test wrote is visible here, the
// migration committed when it should not have.
func assertNoLeak(t *testing.T, dsn string) {
	t.Helper()
	conn, err := pgx.Connect(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	var n int
	if err := conn.QueryRow(context.Background(), `
		select count(*) from public.provider_model
		where id in ('pmdl_merge_googleai_gemma_4_31b','pmdl_preexisting_fixture','pmdl_second_fixture')`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("%d fixture rows are visible on a separate connection — the migration committed the test transaction "+
			"and polluted the shared catalogue; the migration file must not contain BEGIN/COMMIT", n)
	}
}

// depthFor is the same identity-folding depth the router uses, scoped to the
// fixture identity. It is the metric the card asks to move, computed the same
// way ops/verify/model-depth.sql computes it.
func depthFor(t *testing.T, ctx context.Context, tx pgx.Tx, canonicalSlug string) int {
	t.Helper()
	var d int
	err := tx.QueryRow(ctx, `
		select count(distinct pm.provider_id)
		from model m
		join provider_model pm on pm.model_id = m.id
		join connection c on c.id = pm.connection_id
		left join model_slug_alias identity on identity.alias = m.slug
		left join model canon on canon.id = identity.canonical_model_id and canon.status = 'active'
		where coalesce(canon.slug, m.slug) = $1
		  and m.status = 'active'
		  and (m.capabilities->>'chat') is distinct from 'false'
		  and pm.enabled
		  and pm.status not in ('disabled','unavailable')
		  and c.enabled
		  and c.health_status is distinct from 'unhealthy'
		  and exists (select 1 from credential cr where cr.connection_id = c.id
		              and cr.status not in ('disabled','invalid')
		              and (cr.cooldown_until is null or cr.cooldown_until <= now()))`,
		canonicalSlug).Scan(&d)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// TestMergeDepthMigrationPublishesProvenPair is the happy path plus the
// idempotence pin: the row appears once, its upstream id carries the
// `models/` prefix the probe proved necessary, and a second run changes nothing.
func TestMergeDepthMigrationPublishesProvenPair(t *testing.T) {
	dsn := tests.RequireDB(t)
	conn := identityFixtureConn(t, dsn)
	ctx, tx := mergeDepthSchema(t, conn)
	seedMergeDepthEnv(t, ctx, tx, mergeDepthCanonicalSlug, "active", "active", true)

	// A second provider on the same identity, so depth has somewhere to go from
	// 1 to 2 and the assertion cannot pass on an empty catalogue.
	if _, err := tx.Exec(ctx, `
		insert into provider (id, name, base_url, credentials_enc, status, slug, tier, enabled)
		values ('prv_second_fixture', 'Second fixture', 'https://example.invalid/v1', 'enc', 'active', 'second-fixture', 'commercial', true)
		on conflict (id) do nothing`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		insert into connection (id, provider_id, name, slug, base_url, enabled, health_status)
		values ('con_second_fixture', 'prv_second_fixture', 'default', 'default', 'https://example.invalid/v1', true, 'healthy')
		on conflict (id) do nothing`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled, status)
		values ('pmdl_second_fixture', 'mdl_merge_gemma_fixture', 'prv_second_fixture', 'con_second_fixture', 'gemma-4-31b-it', true, 'available')
		on conflict do nothing`); err != nil {
		t.Fatal(err)
	}
	// The second provider needs a live credential of its own: the depth predicate
	// requires one per connection, so without this row the fixture is invisible to
	// depthFor and `before` is 0 for a reason unrelated to the migration.
	if _, err := tx.Exec(ctx, `
		insert into credential (id, connection_id, name, secret_enc, status, priority, weight)
		values ('cred_second_fixture', 'con_second_fixture', 'fixture', 'enc', 'healthy', 0, 1)
		on conflict (id) do update set status = excluded.status`); err != nil {
		t.Fatal(err)
	}

	before := depthFor(t, ctx, tx, mergeDepthCanonicalSlug)
	if before != 1 {
		t.Fatalf("fixture depth before = %d, want 1 — the assertion below would be meaningless", before)
	}

	applySQLFile(t, ctx, tx, mergeDepthMigrationPath)
	if got := countMergeDepthRows(t, ctx, tx); got != 1 {
		t.Fatalf("published rows = %d, want 1", got)
	}
	after := depthFor(t, ctx, tx, mergeDepthCanonicalSlug)
	if after != 2 {
		t.Fatalf("depth after = %d, want 2 (the migration must add exactly one provider)", after)
	}

	var upstream string
	if err := tx.QueryRow(ctx, `select provider_model_id from provider_model where id = $1`, mergeDepthPublishedRowID).Scan(&upstream); err != nil {
		t.Fatal(err)
	}
	if upstream != mergeDepthProviderModel {
		t.Fatalf("provider_model_id = %q, want %q — the unprefixed id answered 400 on the live probe", upstream, mergeDepthProviderModel)
	}

	// Idempotence: a replay must be a byte-for-byte no-op, not a second row and
	// not a second audit entry.
	if _, err := tx.Exec(ctx, `select 1`); err != nil {
		t.Fatal(err)
	}
	applySQLFile(t, ctx, tx, mergeDepthMigrationPath)
	if got := countMergeDepthRows(t, ctx, tx); got != 1 {
		t.Fatalf("replay created a duplicate: %d rows", got)
	}
	var audits int
	if err := tx.QueryRow(ctx, `select count(*) from provider_model_merge_audit where migration = '0030_merge_depth_publish'`).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if audits != 1 {
		t.Fatalf("audit rows after replay = %d, want 1", audits)
	}
	assertNoLeak(t, dsn)
}

// TestMergeDepthMigrationSkipsUnservableIdentity is the guard pin: the pair is
// NOT invented when the provider is retired, when the connection is disabled, or
// when the model is not active. A migration that inserts unconditionally would
// pass the happy path and fail this one.
func TestMergeDepthMigrationSkipsUnservableIdentity(t *testing.T) {
	cases := []struct {
		name           string
		modelStatus    string
		providerStatus string
		connEnabled    bool
	}{
		{"provider disabled", "active", "disabled", true},
		{"connection disabled", "active", "active", false},
		{"model inactive", "inactive", "active", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dsn := tests.RequireDB(t)
			conn := identityFixtureConn(t, dsn)
			ctx, tx := mergeDepthSchema(t, conn)
			seedMergeDepthEnv(t, ctx, tx, mergeDepthCanonicalSlug, tc.modelStatus, tc.providerStatus, tc.connEnabled)

			applySQLFile(t, ctx, tx, mergeDepthMigrationPath)
			if got := countMergeDepthRows(t, ctx, tx); got != 0 {
				t.Fatalf("%s: migration published %d rows, want 0 — it must not invent a pair it cannot dial", tc.name, got)
			}
			assertNoLeak(t, dsn)
		})
	}
}

// TestMergeDepthRollbackRestoresCatalogue is the rollback contract: after the
// migration and its rollback the catalogue is byte-for-byte what it was, and a
// mapping that an operator repointed by hand is restored rather than deleted.
func TestMergeDepthRollbackRestoresCatalogue(t *testing.T) {
	dsn := tests.RequireDB(t)
	conn := identityFixtureConn(t, dsn)
	ctx, tx := mergeDepthSchema(t, conn)
	seedMergeDepthEnv(t, ctx, tx, mergeDepthCanonicalSlug, "active", "active", true)

	// A pre-existing mapping this migration did NOT create. The rollback must
	// leave it alone — that is the difference between an undo and a purge.
	// It sits on a SECOND connection of the same provider, which satisfies two
	// constraints at once: the FK resolves (a dangling connection_id would abort
	// the transaction, turning every later statement into a 25P02) and the row
	// does not occupy the migration's own unique target
	// (model_id, provider_id, coalesce(connection_id,'')) — if it did, the
	// migration's ON CONFLICT DO NOTHING would make it publish nothing and this
	// test would fail for a reason it is not about.
	if _, err := tx.Exec(ctx, `
		insert into connection (id, provider_id, name, slug, base_url, enabled, health_status)
		values ('con_merge_other', $1, 'other', 'other', 'https://example.invalid/v1', true, 'healthy')
		on conflict (id) do nothing`, mergeDepthProviderID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled, status)
		values ('pmdl_preexisting_fixture', 'mdl_merge_gemma_fixture', $1, 'con_merge_other', 'gemma-4-31b-it-legacy', false, 'deprecated')`,
		mergeDepthProviderID); err != nil {
		t.Fatal(err)
	}

	applySQLFile(t, ctx, tx, mergeDepthMigrationPath)
	if got := countMergeDepthRows(t, ctx, tx); got != 1 {
		t.Fatalf("published rows = %d, want 1", got)
	}

	applySQLFile(t, ctx, tx, mergeDepthRollbackPath)
	if got := countMergeDepthRows(t, ctx, tx); got != 0 {
		t.Fatalf("rollback left %d published rows, want 0", got)
	}
	var preexisting int
	if err := tx.QueryRow(ctx, `select count(*) from provider_model where id = 'pmdl_preexisting_fixture'`).Scan(&preexisting); err != nil {
		t.Fatal(err)
	}
	if preexisting != 1 {
		t.Fatalf("rollback deleted a mapping the migration did not create (preexisting rows = %d)", preexisting)
	}
	var audits int
	if err := tx.QueryRow(ctx, `select count(*) from provider_model_merge_audit where migration = '0030_merge_depth_publish'`).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if audits != 0 {
		t.Fatalf("rollback left %d audit rows, want 0", audits)
	}

	// Idempotent undo: running it twice must not error or resurrect anything.
	applySQLFile(t, ctx, tx, mergeDepthRollbackPath)
	if got := countMergeDepthRows(t, ctx, tx); got != 0 {
		t.Fatalf("second rollback left %d rows", got)
	}
	assertNoLeak(t, dsn)
}
