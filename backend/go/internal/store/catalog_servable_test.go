package store_test

import (
	"context"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/ids"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
	"github.com/jackc/pgx/v5"
)

// A model whose only upstream has NO usable credential is advertised in
// /v1/models today, because ActiveModels joins provider_model + provider but
// never looks at connection or credential. Routing (Candidates) does look, so
// the catalogue promises a model the hot path refuses — 249 of 346 published
// models on the deployed box.
//
// The catalogue must describe what the router can actually serve: a model with
// no live credential is not published.
func TestActiveModelsHidesModelsWithNoLiveCredential(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	ctx := context.Background()

	st, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	// The seeded env has a live credential, so it must stay published.
	models, err := st.ActiveModels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var foundSeeded bool
	for _, m := range models {
		if m.Slug == env.Slug {
			foundSeeded = true
		}
	}
	if !foundSeeded {
		t.Fatalf("seeded model %q vanished from the catalogue — the filter is too aggressive", env.Slug)
	}

	// Now park the only credential: auth_failed puts it in cooldown, which is
	// exactly the state that makes the model unroutable while its rows stay
	// 'active'. The catalogue must drop it.
	parkConn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	// LIFO: the credential restore below runs before this close.
	t.Cleanup(func() { parkConn.Close(context.Background()) })

	var credID string
	if err := parkConn.QueryRow(ctx, `
		select cr.id from credential cr
		join connection c on c.id = cr.connection_id
		join provider_model pm on pm.connection_id = c.id
		where pm.model_id = $1
		order by cr.priority asc, cr.id
		limit 1`, env.ModelID).Scan(&credID); err != nil {
		t.Fatalf("locate the seeded credential: %v", err)
	}
	// Park the credential the way the router itself does: parkCredential sets
	// BOTH status and cooldown_until, and it is the cooldown that the candidate
	// query filters on (`cr.cooldown_until <= now()`). Setting only the status
	// would leave the row routable — 'auth_failed' is not in the query's
	// ('disabled','invalid') exclusion list, by design: the status is a record,
	// the cooldown is the enforcement.
	//
	// The S0 legacy blob on the provider row must be cleared too: Candidates
	// keeps a candidate whose credential list is empty when the provider still
	// carries `credentials_enc` (the pre-0019 single-key shape), so without this
	// the model stays routable through a path the catalogue cannot see.
	if _, err := parkConn.Exec(ctx, `
		update provider set credentials_enc = '' where id = $1`, env.ProviderID); err != nil {
		t.Fatalf("clear the legacy blob: %v", err)
	}
	t.Cleanup(func() {
		_, _ = parkConn.Exec(context.Background(), `
			update credential set status = 'healthy', cooldown_until = null
			where id = $1`, credID)
	})
	tag, err := parkConn.Exec(ctx, `
		update credential set status = 'auth_failed',
		  cooldown_until = now() + interval '1 hour'
		where id = $1`, credID)
	if err != nil {
		t.Fatalf("park the credential: %v", err)
	}
	if tag.RowsAffected() != 1 {
		t.Fatalf("parking the credential affected %d rows, want 1", tag.RowsAffected())
	}

	// Routing must agree it is unroutable, so the test proves the catalogue
	// follows the hot path rather than inventing its own rule.
	cands, err := st.Candidates(ctx, env.ModelID, nil)
	if err == nil && len(cands) > 0 {
		t.Fatalf("precondition failed: model still routable with %d candidates", len(cands))
	}

	models, err = st.ActiveModels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range models {
		if m.Slug == env.Slug {
			t.Error("model with no usable credential is still advertised in /v1/models")
		}
	}
	if _, err := st.PublishedModel(ctx, env.Slug); err == nil {
		t.Error("PublishedModel still returns a model with no usable credential")
	}
}

// A model with NO connection at all is the other half of the gap: the row is
// active, the provider is commercial and enabled, but nothing dials anywhere.
func TestActiveModelsHidesModelsWithNoConnection(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	ctx := context.Background()

	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	// LIFO: the row delete below runs before this close, matching the seeder's
	// own ordering (see tests/helpers.go).
	t.Cleanup(func() { conn.Close(context.Background()) })

	// A model hung off the provider with no provider_model row: no connection,
	// no credential, nothing routable.
	id := ids.New("mdl")
	if _, err := conn.Exec(ctx, `
		insert into model (id, provider_id, name, slug, context, input_price, output_price, currency, status, created_at)
		values ($1,$2,'NoConnection',$3,128000,'150000.000000','600000.000000','USD','active', now())`,
		id, env.ProviderID, "no-connection-model"); err != nil {
		t.Fatalf("seed: %v", err)
	}
	t.Cleanup(func() {
		if _, err := conn.Exec(context.Background(), `delete from model where id = $1`, id); err != nil {
			t.Errorf("teardown leaked a row: %v", err)
		}
	})

	st, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	models, err := st.ActiveModels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range models {
		if m.Slug == "no-connection-model" {
			t.Error("a model with no connection is advertised in /v1/models")
		}
	}
	if _, err := st.PublishedModel(ctx, "no-connection-model"); err == nil {
		t.Error("PublishedModel returns a model with no connection")
	}
}

// A model whose `capabilities` claim is ABSENT must stay advertised.
//
// Migration 0012 backfilled `capabilities->>'chat'` on every row that existed
// when it ran. Rows onboarded afterwards carry no claim at all, and every one
// of them is a chat model (claude-fable-5-1, gpt-6-sol, qwen3-coder-next, …).
// A strict `= 'true'` gate hides those 12 working models from the catalogue —
// the mirror image of the bug this gate fixes, where the catalogue promised
// more than the router could serve.
//
// The request path tolerates the missing claim: CapabilitySatisfied eliminates
// a candidate only on an explicit `false`. The catalogue must use the same
// rule, or the two views drift and /v1/models under-reports what routing will
// happily serve.
func TestActiveModelsKeepsModelsWithNoChatClaim(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(context.Background()) })
	// A second model on the SAME provider network, so it inherits the seeded
	// connection + credential and is fully routable. Its capabilities column is
	// left at the '{}' default — the exact shape of a post-0012 onboarding.
	id := ids.New("mdl")
	if _, err := conn.Exec(ctx, `
		insert into model (id, provider_id, name, slug, context, input_price, output_price, currency, status, created_at)
		values ($1,$2,'NoChatClaim',$3,128000,'150000.000000','600000.000000','USD','active', now())`,
		id, env.ProviderID, "no-chat-claim-model"); err != nil {
		t.Fatalf("seed: %v", err)
	}
	t.Cleanup(func() {
		if _, err := conn.Exec(context.Background(), `delete from model where id = $1`, id); err != nil {
			t.Errorf("teardown leaked a row: %v", err)
		}
	})
	// Without the provider_model row ActiveModels excludes it for the same
	// reason it excludes a model with no connection, and the test would pass
	// for the wrong reason. SeedSecondModel's shape: model + provider_model.
	pmID := ids.New("pmdl")
	if _, err := conn.Exec(ctx, `
		insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled, status)
		values ($1,$2,$3,$4,$5,true,'available')`,
		pmID, id, env.ProviderID, env.ConnectionID, "no-chat-claim-model"); err != nil {
		t.Fatalf("seed provider_model: %v", err)
	}
	t.Cleanup(func() {
		if _, err := conn.Exec(context.Background(), `delete from provider_model where id = $1`, pmID); err != nil {
			t.Errorf("teardown leaked a row: %v", err)
		}
	})
	st, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	models, err := st.ActiveModels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, m := range models {
		if m.Slug == "no-chat-claim-model" {
			found = true
		}
	}
	if !found {
		t.Error("a routable model with no capabilities claim is hidden from /v1/models")
	}
	if _, err := st.PublishedModel(ctx, "no-chat-claim-model"); err != nil {
		t.Errorf("PublishedModel drops a routable model with no capabilities claim: %v", err)
	}
}

// The other half of the gate: an EXPLICIT `chat: false` must still be hidden,
// or the catalogue goes back to advertising embedding/image/video models the
// chat endpoint answers with a 400.
func TestActiveModelsHidesExplicitNonChatModels(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(context.Background()) })
	// Same routable network as above, but the row declares itself non-chat.
	id := ids.New("mdl")
	if _, err := conn.Exec(ctx, `
		insert into model (id, provider_id, name, slug, context, input_price, output_price, currency, status, capabilities, created_at)
		values ($1,$2,'Embedding',$3,8192,'150000.000000','600000.000000','USD','active','{"chat":false,"embedding":true}'::jsonb, now())`,
		id, env.ProviderID, "explicit-non-chat-model"); err != nil {
		t.Fatalf("seed: %v", err)
	}
	t.Cleanup(func() {
		if _, err := conn.Exec(context.Background(), `delete from model where id = $1`, id); err != nil {
			t.Errorf("teardown leaked a row: %v", err)
		}
	})
	pmID := ids.New("pmdl")
	if _, err := conn.Exec(ctx, `
		insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled, status)
		values ($1,$2,$3,$4,$5,true,'available')`,
		pmID, id, env.ProviderID, env.ConnectionID, "explicit-non-chat-model"); err != nil {
		t.Fatalf("seed provider_model: %v", err)
	}
	t.Cleanup(func() {
		if _, err := conn.Exec(context.Background(), `delete from provider_model where id = $1`, pmID); err != nil {
			t.Errorf("teardown leaked a row: %v", err)
		}
	})
	st, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	models, err := st.ActiveModels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range models {
		if m.Slug == "explicit-non-chat-model" {
			t.Error("a model declaring chat=false is advertised in /v1/models")
		}
	}
	if _, err := st.PublishedModel(ctx, "explicit-non-chat-model"); err == nil {
		t.Error("PublishedModel returns a model declaring chat=false")
	}
}
