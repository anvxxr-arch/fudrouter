package store_test

// A recorded alias is not a routing identity unless live duplicates contribute
// their providers. The loaded catalogue still had 152 of 159 routable rows at
// depth 1 after 0026: its fallback required deleting a duplicate before the alias
// could fire. These fixtures keep every row and verify actual candidate union,
// not a depth statistic computed from a table the request path never reads.

import (
	"context"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/ids"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
	"github.com/jackc/pgx/v5"
)

func TestVirtualCatalogueCoverage(t *testing.T) {
	dsn := tests.RequireDB(t)
	s, tr := startCounting(t, dsn)
	ctx := context.Background()
	key := &store.APIKeyRow{}
	res, err := s.ResolveModel(ctx, key, "fudrouter/auto")
	if err != nil {
		t.Fatal(err)
	}
	// On the loaded catalogue this measures real targets without adding rows;
	// an empty CI database still exercises the gate rather than skipping it.
	if len(res.ModelIDs) == 0 {
		tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
		res, err = s.ResolveModel(ctx, key, "fudrouter/auto")
		if err != nil {
			t.Fatal(err)
		}
	}
	tr.Reset()
	batch, err := s.CandidatesBatch(ctx, res.ModelIDs, res.RequiredCapabilities)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.ModelIDs) == 0 || len(batch) != len(res.ModelIDs) || tr.Count() != 1 {
		t.Fatalf("auto covered %d/%d targets in %d queries, want a nonempty 100%% in 1", len(batch), len(res.ModelIDs), tr.Count())
	}
	t.Logf("fudrouter/auto: %d/%d targets routable (100%%), %d candidate query", len(batch), len(res.ModelIDs), tr.Count())
}

func TestCanonicalIdentityUnitesLiveProviderMappings(t *testing.T) {
	dsn := tests.RequireDB(t)
	first := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	second := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	ctx := context.Background()
	conn := identityFixtureConn(t, dsn)

	// Only this test's seeded slug is normalised; the backfill must prefer its
	// lower-case spelling without renaming any catalogue row itself.
	first.Slug = strings.ToLower(first.Slug)
	if _, err := conn.Exec(ctx, `update model set slug = $2 where id = $1`, first.ModelID, first.Slug); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `update provider_model set provider_model_id = $2 where id = $1`, first.ProviderModelID, first.Slug); err != nil {
		t.Fatal(err)
	}
	oldSlug := strings.TrimPrefix(second.ProviderID, "prv_") + "/" + first.Slug
	upstream := strings.ToUpper(first.Slug)
	duplicate, mapping := seedIdentityModel(t, conn, second, oldSlug, upstream, "{}", "{}", true)
	caseSlug := strings.ToUpper(first.Slug)
	caseID, _ := seedIdentityModel(t, conn, second, caseSlug, "", "{}", "{}", false)
	unknownSlug := "unknown-vendor/" + first.Slug
	unknownID, _ := seedIdentityModel(t, conn, second, unknownSlug, "different-upstream", "{}", "{}", true)
	runSlugAliasMigration(t, conn)

	bindings := slugAliasBindings(t, conn)
	for _, name := range []string{oldSlug, caseSlug} {
		if bindings[name] != first.ModelID {
			t.Fatalf("backfill %s -> %s, want %s", name, bindings[name], first.ModelID)
		}
	}
	if _, exists := bindings[unknownSlug]; exists {
		t.Fatal("backfill conflated an unknown vendor namespace with an existing leaf")
	}

	s, tr := startCounting(t, dsn)
	key := &store.APIKeyRow{UserID: first.UserID}
	for _, name := range []string{first.Slug, oldSlug, caseSlug} {
		tr.Reset()
		res, err := s.ResolveModel(ctx, key, name)
		if err != nil {
			t.Fatalf("ResolveModel(%s): %v", name, err)
		}
		if res.Kind != "model" || !reflect.DeepEqual(res.ModelIDs, []string{first.ModelID}) || res.Requested != name {
			t.Fatalf("%s resolved as %+v, want the canonical identity without losing the input", name, res)
		}
		if tr.Count() != 1 {
			t.Fatalf("old/canonical resolution issued %d queries, want 1", tr.Count())
		}
	}

	// Both entry points must expose the same provider set, including direct
	// callers that still hold a duplicate id (account aliases and combos).
	var single []store.Candidate
	for _, modelID := range []string{first.ModelID, duplicate} {
		tr.Reset()
		cs, err := s.Candidates(ctx, modelID, map[string]bool{"chat": true})
		if err != nil || len(cs) != 2 {
			t.Fatalf("Candidates(%s): %d candidates, err %v; want both providers", modelID, len(cs), err)
		}
		if tr.Count() != 1 {
			t.Fatalf("identity candidate fetch issued %d queries, want 1", tr.Count())
		}
		providers := map[string]bool{}
		for _, c := range cs {
			providers[c.ProviderID] = true
			if c.ProviderID == second.ProviderID && (c.UpstreamModel != upstream || c.ProviderModelID != mapping || c.ModelID != duplicate) {
				t.Fatalf("identity changed upstream=%s mapping=%s billing model=%s", c.UpstreamModel, c.ProviderModelID, c.ModelID)
			}
			price, err := s.ResolvePricing(ctx, c.ModelID, c.ProviderModelID, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			if c.ProviderID == second.ProviderID && price.InputStr != "250000.000000" {
				t.Fatalf("duplicate provider lost its original price: %s", price.InputStr)
			}
		}
		if len(providers) != 2 || !providers[first.ProviderID] || !providers[second.ProviderID] {
			t.Fatalf("canonical depth = %d, want 2 distinct providers", len(providers))
		}
		single = cs
	}
	tr.Reset()
	batch, err := s.CandidatesBatch(ctx, []string{first.ModelID}, map[string]bool{"chat": true})
	if err != nil || !reflect.DeepEqual(fingerprint(batch[first.ModelID]), fingerprint(single)) {
		t.Fatalf("batch and single identity fan-out differ: %v", err)
	}
	if tr.Count() != 1 {
		t.Fatalf("identity batch issued %d queries, want 1", tr.Count())
	}

	res, err := s.ResolveModel(ctx, key, "fudrouter/auto")
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, id := range res.ModelIDs {
		counts[id]++
	}
	if counts[first.ModelID] != 1 || counts[duplicate] != 0 || counts[caseID] != 0 {
		t.Fatalf("virtual split or repeated one identity: canonical=%d prefixed=%d case=%d", counts[first.ModelID], counts[duplicate], counts[caseID])
	}
	literal, err := s.ResolveModel(ctx, key, unknownSlug)
	if err != nil || !reflect.DeepEqual(literal.ModelIDs, []string{unknownID}) {
		t.Fatalf("unknown vendor's literal changed: %+v, %v", literal, err)
	}

	// A customer's ordered alias still outranks the global identity binding.
	tests.SeedAlias(t, dsn, first, oldSlug, []string{second.ModelID})
	scoped, err := s.ResolveModel(ctx, key, oldSlug)
	if err != nil || scoped.Kind != "alias" || !reflect.DeepEqual(scoped.ModelIDs, []string{second.ModelID}) {
		t.Fatalf("account alias lost precedence: %+v, %v", scoped, err)
	}
	for id, want := range map[string]string{first.ModelID: first.Slug, duplicate: oldSlug, caseID: caseSlug} {
		var got string
		if err := conn.QueryRow(ctx, `select slug from model where id = $1`, id).Scan(&got); err != nil || got != want {
			t.Fatalf("migration renamed/deleted %s: %q, %v", id, got, err)
		}
	}
}

func TestVirtualCapabilityTargetsMatchCandidates(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	conn := identityFixtureConn(t, dsn)
	ctx := context.Background()
	fixtures := []struct {
		caps, override  string
		chat, reasoning bool
	}{
		{"{}", "{}", true, true},
		{`{"chat":false}`, "{}", false, false},
		{`{"chat":true}`, `{"chat":false}`, false, false},
		{`{"chat":false}`, `{"chat":true}`, true, true},
		{`{"chat":true,"reasoning":false}`, "{}", true, false},
		{`{"chat":true,"reasoning":true}`, `{"reasoning":false}`, true, false},
	}
	modelIDs := make([]string, len(fixtures))
	for i, f := range fixtures {
		slug := "capability-" + strings.ToLower(tests.RandChars(10))
		modelIDs[i], _ = seedIdentityModel(t, conn, env, slug, slug, f.caps, f.override, true)
	}
	s, tr := startCounting(t, dsn)
	key := &store.APIKeyRow{UserID: env.UserID}
	for _, name := range []string{"fudrouter/auto", "fudrouter/fast", "fudrouter/cheap", "fudrouter/balanced", "fudrouter/reliable", "fudrouter/reasoning", "fudrouter/coding"} {
		t.Run(name, func(t *testing.T) {
			tr.Reset()
			res, err := s.ResolveModel(ctx, key, name)
			if err != nil {
				t.Fatal(err)
			}
			if tr.Count() != 2 {
				t.Fatalf("virtual resolution issued %d queries, want 2", tr.Count())
			}
			advertised := map[string]bool{}
			for _, id := range res.ModelIDs {
				advertised[id] = true
			}
			for i, f := range fixtures {
				want := f.chat && (name != "fudrouter/reasoning" || f.reasoning)
				if advertised[modelIDs[i]] != want {
					t.Errorf("fixture %d: advertised=%t, want %t (caps=%s override=%s)", i, advertised[modelIDs[i]], want, f.caps, f.override)
				}
			}
			tr.Reset()
			batch, err := s.CandidatesBatch(ctx, res.ModelIDs, res.RequiredCapabilities)
			if err != nil {
				t.Fatal(err)
			}
			if tr.Count() != 1 || len(batch) != len(res.ModelIDs) {
				t.Fatalf("%d/%d targets covered in %d queries, want 100%% in 1", len(batch), len(res.ModelIDs), tr.Count())
			}
		})
	}
}

// DDL idempotence must also cover initial creation, not only IF NOT EXISTS on a
// table already supplied by the catalogue dump. The private schema rolls back;
// the model FK still references the real, seeded public model as in production.
func TestModelIdentityMigrationsCreateAndReplay(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	conn := identityFixtureConn(t, dsn)
	ctx := context.Background()
	oldSlug := strings.TrimPrefix(env.ProviderID, "prv_") + "/" + env.Slug
	seedIdentityModel(t, conn, env, oldSlug, "", "{}", "{}", false)
	unknownSlug := "not-a-provider/" + env.Slug
	seedIdentityModel(t, conn, env, unknownSlug, "", "{}", "{}", false)

	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	schema := "identity_test_" + strings.ToLower(tests.RandChars(10))
	if _, err := tx.Exec(ctx, `create schema `+schema); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `set local search_path = `+schema+`, public`); err != nil {
		t.Fatal(err)
	}
	var snapshot map[string]string
	for _, path := range []string{"../../migrations/0026_model_slug_alias.sql", slugAliasMigrationPath, "../../migrations/0026_model_slug_alias.sql", slugAliasMigrationPath} {
		sql, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, string(sql)); err != nil {
			t.Fatalf("fresh-schema replay of %s: %v", path, err)
		}
		bindings := slugAliasBindings(t, conn)
		if bindings[oldSlug] != env.ModelID {
			t.Fatalf("%s did not backfill the seeded old name", path)
		}
		if _, present := bindings[unknownSlug]; present {
			t.Fatalf("%s merged an unknown namespace", path)
		}
		if snapshot == nil {
			snapshot = bindings
		} else if !reflect.DeepEqual(snapshot, bindings) {
			t.Fatalf("%s changed bindings on replay", path)
		}
	}
	var created int
	if err := tx.QueryRow(ctx, `select count(*) from information_schema.tables where table_schema = $1 and table_name = 'model_slug_alias'`, schema).Scan(&created); err != nil || created != 1 {
		t.Fatalf("fresh migration did not create its identity table: %d, %v", created, err)
	}
}

func identityFixtureConn(t *testing.T, dsn string) *pgx.Conn {
	t.Helper()
	conn, err := pgx.Connect(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(context.Background()) })
	return conn
}

func seedIdentityModel(t *testing.T, conn *pgx.Conn, env *tests.Env, slug, upstream, caps, override string, mapped bool) (string, string) {
	t.Helper()
	ctx := context.Background()
	id := ids.New("mdl")
	if _, err := conn.Exec(ctx, `
		insert into model (id, provider_id, name, slug, context, input_price, output_price, status, capabilities)
		values ($1,$2,'Identity fixture',$3,8192,'250000.000000','700000.000000','active',$4::jsonb)`, id, env.ProviderID, slug, caps); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := conn.Exec(context.Background(), `delete from model where id = $1`, id); err != nil {
			t.Errorf("identity fixture teardown: %v", err)
		}
	})
	mapping := ""
	if mapped {
		mapping = ids.New("pmdl")
		if _, err := conn.Exec(ctx, `
			insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, capabilities_override, enabled, status)
			values ($1,$2,$3,$4,$5,$6::jsonb,true,'available')`, mapping, id, env.ProviderID, env.ConnectionID, upstream, override); err != nil {
			t.Fatal(err)
		}
	}
	return id, mapping
}
