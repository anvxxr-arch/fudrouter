package tests

// Fixtures for the allowlist-tier tests (store/virtual_allowlist_test.go).
//
// These live here rather than in the test file because two packages need them
// (store and proxy both assert tier behaviour) and because every one of them
// has to CLEAN UP: the suite runs against a shared scratch database, and a
// global `model_alias` row has no owner to cascade from, so a leaked fixture
// would change what `fudrouter/auto` resolves to for every later test in the
// run.

import (
	"context"
	"errors"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/ids"
	"github.com/jackc/pgx/v5"
)

// SeedRoutableModel inserts a chat-capable model AND its provider_model
// mapping, so the model can actually produce a candidate. Returns the model id.
//
// Distinct from SeedModel (no mapping, unusable for routing) and from
// seedIdentityModel in store's own test file (unexported). This one always
// claims `{"chat":true}` so a virtual's chat requirement cannot filter it out
// for the wrong reason.
func SeedRoutableModel(t *testing.T, dsn string, env *Env, slug string) string {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(context.Background()) })

	modelID := ids.New("mdl")
	if _, err := conn.Exec(ctx, `
		insert into model (id, provider_id, name, slug, context, input_price, output_price, status, capabilities)
		values ($1,$2,$3,$4,8192,'150000.000000','600000.000000','active','{"chat":true}'::jsonb)`,
		modelID, env.ProviderID, slug, slug); err != nil {
		t.Fatalf("seed routable model %s: %v", slug, err)
	}
	t.Cleanup(func() {
		// Delete the usage rows this fixture's model attracted FIRST: request_log
		// references model(id) with no cascade, so a proxied request leaves a row
		// that blocks the model delete. Scoped by model_id, which is unique to
		// this fixture, so it can never touch another test's ledger rows.
		if _, err := conn.Exec(context.Background(),
			`delete from request_log where model_id = $1`, modelID); err != nil {
			t.Errorf("request_log teardown for %s failed: %v", modelID, err)
		}
		if _, err := conn.Exec(context.Background(), `delete from model where id = $1`, modelID); err != nil {
			t.Errorf("routable model teardown failed (leaks row %s): %v", modelID, err)
		}
	})
	if _, err := conn.Exec(ctx, `
		insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled, status)
		values ($1,$2,$3,$4,$5,true,'available')`,
		ids.New("pmdl"), modelID, env.ProviderID, env.ConnectionID, slug); err != nil {
		t.Fatalf("seed provider_model for %s: %v", slug, err)
	}
	return modelID
}

// SeedGlobalVirtualAllowlist attaches `modelIDs` to the GLOBAL alias named
// `virtual` (a `fudrouter/*` tier name), replacing whatever targets it had, and
// returns a func that removes exactly the rows it added — so a test can prove
// the empty-allowlist fallback by emptying it mid-run.
//
// The alias row itself is created when it is missing. Migrations 0007 and 0032
// seed the platform rows, but a scratch database created before those backfills
// (or one where a test's teardown removed them) would otherwise make every
// allowlist test fail for a reason that has nothing to do with the contract
// under test. A row created here is deleted again on cleanup, so the fixture
// leaves the catalogue exactly as it found it.
func SeedGlobalVirtualAllowlist(t *testing.T, dsn, virtual string, modelIDs []string) (clear func()) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(context.Background()) })

	var aliasID string
	createdRow := false
	err = conn.QueryRow(ctx,
		`select id from model_alias where name = $1 and account_id is null`, virtual).Scan(&aliasID)
	if errors.Is(err, pgx.ErrNoRows) {
		// A scratch database built before 0007/0032 ran, or one whose teardown
		// removed the row: create it so the test exercises the ALLOWLIST, not
		// the presence of a seed row. Removed again on cleanup.
		aliasID = "als_test_" + RandChars(10)
		if _, err := conn.Exec(ctx,
			`insert into model_alias (id, account_id, name, enabled) values ($1, NULL, $2, true)`,
			aliasID, virtual); err != nil {
			t.Fatalf("seed global alias %s: %v", virtual, err)
		}
		createdRow = true
	} else if err != nil {
		t.Fatalf("look up global alias %s: %v", virtual, err)
	}

	// A re-run must start from a clean allowlist: a previous run's rows are not
	// ours to keep, and leaving them would make "empty allowlist" untestable.
	if _, err := conn.Exec(ctx, `delete from model_alias_target where alias_id = $1`, aliasID); err != nil {
		t.Fatalf("clear allowlist for %s: %v", virtual, err)
	}
	for i, modelID := range modelIDs {
		if _, err := conn.Exec(ctx,
			`insert into model_alias_target (alias_id, model_id, position) values ($1,$2,$3)`,
			aliasID, modelID, i); err != nil {
			t.Fatalf("seed allowlist target %d for %s: %v", i, virtual, err)
		}
	}
	clear = func() {
		if _, err := conn.Exec(context.Background(),
			`delete from model_alias_target where alias_id = $1`, aliasID); err != nil {
			t.Errorf("clear allowlist for %s failed (leaks rows): %v", virtual, err)
		}
	}
	t.Cleanup(func() {
		clear()
		if createdRow {
			if _, err := conn.Exec(context.Background(),
				`delete from model_alias where id = $1`, aliasID); err != nil {
				t.Errorf("delete fixture alias %s: %v", aliasID, err)
			}
		}
	})
	return clear
}

// SeedSlugAlias records `alias` → `canonicalID` in model_slug_alias, the
// identity map 0026/0028 introduced. Used to prove the allowlist resolves to
// canonical rows rather than to the spelling the operator typed.
func SeedSlugAlias(t *testing.T, dsn, alias, canonicalID string) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(context.Background()) })
	if _, err := conn.Exec(ctx,
		`insert into model_slug_alias (alias, canonical_model_id) values ($1,$2)
		 on conflict (alias) do update set canonical_model_id = excluded.canonical_model_id`,
		alias, canonicalID); err != nil {
		t.Fatalf("seed slug alias %s: %v", alias, err)
	}
	t.Cleanup(func() {
		if _, err := conn.Exec(context.Background(),
			`delete from model_slug_alias where alias = $1`, alias); err != nil {
			t.Errorf("slug alias teardown failed (leaks row %s): %v", alias, err)
		}
	})
}

// SeedLiveAttempt records one successful attempt against `modelID`, which is
// what puts the model in `fudrouter/auto`'s live set. It creates the parent
// request_log row the FK needs and removes both on cleanup.
//
// status is the HTTP status to record: 200 for a live model, 500 for a model
// that was tried and failed (which must NOT enter the live set).
func SeedLiveAttempt(t *testing.T, dsn string, env *Env, modelID string, status int) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(context.Background()) })

	var providerModelID string
	if err := conn.QueryRow(ctx,
		`select id from provider_model where model_id = $1 limit 1`, modelID).Scan(&providerModelID); err != nil {
		t.Fatalf("model %s has no provider_model mapping to attempt: %v", modelID, err)
	}

	requestID := ids.New("rql")
	if _, err := conn.Exec(ctx, `
		insert into request_log (id, user_id, api_key_id, model_id, tokens_in, tokens_out,
		                         cost, currency, latency_ms, status)
		values ($1,$2,$3,$4,1,1,1,'USD',10,'success')`,
		requestID, env.UserID, env.APIKeyID, modelID); err != nil {
		t.Fatalf("seed request_log for live attempt: %v", err)
	}
	t.Cleanup(func() {
		// Cascades to request_attempt.
		if _, err := conn.Exec(context.Background(), `delete from request_log where id = $1`, requestID); err != nil {
			t.Errorf("live attempt teardown failed (leaks row %s): %v", requestID, err)
		}
	})
	if _, err := conn.Exec(ctx, `
		insert into request_attempt (id, request_id, attempt, provider_id, connection_id,
		                             provider_model_id, http_status, latency_ms, started_at)
		values ($1,$2,1,$3,$4,$5,$6,10,now())`,
		ids.New("rat"), requestID, env.ProviderID, env.ConnectionID, providerModelID, status); err != nil {
		t.Fatalf("seed request_attempt: %v", err)
	}
}

// DropLiveAttemptsBefore deletes every attempt row older than `hours` for the
// models a test seeded, so the live-set test cannot accidentally pass on
// another test's traffic. Scoped by model ids on purpose — the suite shares one
// database and must never truncate the ledger.
func DropLiveAttempts(t *testing.T, dsn string, modelIDs ...string) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	if _, err := conn.Exec(ctx, `
		delete from request_attempt a
		using provider_model pm
		where pm.id = a.provider_model_id
		  and pm.model_id = any($1)`, modelIDs); err != nil {
		t.Fatalf("drop live attempts: %v", err)
	}
}
