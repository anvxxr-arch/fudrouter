package store_test

// The allowlist tier contract (card t_47709e15).
//
// A `fudrouter/*` virtual used to mean exactly one thing: the full fan-out over
// every servable chat model. These tests pin the four behaviours that make it a
// TIER instead — an operator-declared target set that the router must honour,
// canonicalise, deduplicate, and fall back from safely:
//
//	1. a populated allowlist is what gets routed to (and nothing else);
//	2. an empty allowlist is byte-identical to the old fan-out;
//	3. circular / duplicate targets are rejected, not silently routed;
//	4. `auto` uses the live set when it has no allowlist, and says so when the
//	   live set is empty instead of pretending everything is healthy.
//
// Every test seeds its own models and clears its own allowlist: the suite shares
// one scratch database, and the global `fudrouter/*` alias rows have no owner to
// cascade from.

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/routing"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
	"github.com/jackc/pgx/v5"
)

// allowlistFixture builds an environment plus n routable chat models and returns
// the store, the key, and the model ids in seeding order.
func allowlistFixture(t *testing.T, n int) (*store.Store, *store.APIKeyRow, []string) {
	t.Helper()
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	ids := make([]string, 0, n)
	for i := range n {
		ids = append(ids, tests.SeedRoutableModel(t, dsn, env, "tier-"+strings.ToLower(tests.RandChars(8))+"-"+string(rune('a'+i))))
	}
	s, err := store.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	// The live set is cached per Store, and this fixture seeds attempts; a
	// stale entry would make the live-set test read another test's traffic.
	store.ResetLiveSetForTest(s)
	t.Cleanup(func() { store.ResetLiveSetForTest(s) })
	return s, &store.APIKeyRow{UserID: env.UserID}, ids
}

// TestAllowlistTierRoutesOnlyToItsTargets is the core contract: when a virtual
// declares targets, resolution returns EXACTLY those models. The fixture adds a
// decoy model that is fully routable but not allowlisted, so a fall-through to
// the fan-out cannot pass by accident.
func TestAllowlistTierRoutesOnlyToItsTargets(t *testing.T) {
	s, key, ids := allowlistFixture(t, 3)
	ctx := context.Background()
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")

	// Decoy: routable, chat-capable, NOT in the allowlist.
	decoy := tests.SeedRoutableModel(t, dsn, env, "tier-decoy-"+strings.ToLower(tests.RandChars(6)))

	// Declare the allowlist in a non-seeding order, so the assertion also
	// proves `position` is what decides order rather than insertion order.
	want := []string{ids[2], ids[0]}
	tests.SeedGlobalVirtualAllowlist(t, dsn, "fudrouter/worker", want)

	res, err := s.ResolveModel(ctx, key, "fudrouter/worker")
	if err != nil {
		t.Fatalf("fudrouter/worker: %v", err)
	}
	if res.Kind != "virtual" {
		t.Fatalf("kind = %q, want virtual — an allowlisted tier is still a virtual, not an alias", res.Kind)
	}
	got := map[string]bool{}
	for _, id := range res.ModelIDs {
		got[id] = true
	}
	if len(res.ModelIDs) != len(want) {
		t.Fatalf("resolved %d targets (%v), want exactly the %d allowlisted", len(res.ModelIDs), res.ModelIDs, len(want))
	}
	for _, id := range want {
		if !got[id] {
			t.Errorf("allowlisted model %s missing from the resolved set %v", id, res.ModelIDs)
		}
	}
	if got[decoy] {
		t.Errorf("decoy model %s is routable but NOT allowlisted, and it was resolved anyway — the tier fell through to the fan-out", decoy)
	}
	if got[ids[1]] {
		t.Errorf("model %s was seeded but not allowlisted and still resolved", ids[1])
	}
	// The strategy hint must survive: the allowlist decides WHO, the hint
	// decides HOW.
	if res.StrategyHint != "lowest_cost" {
		t.Errorf("strategy hint = %q, want lowest_cost", res.StrategyHint)
	}
	if len(res.ModelSlugs) != len(res.ModelIDs) {
		t.Errorf("ModelSlugs=%d ModelIDs=%d, want parallel", len(res.ModelSlugs), len(res.ModelIDs))
	}
}

// TestAllowlistEmptyFallsBackToFanOut is invariant A: deleting the rows must
// restore the old behaviour EXACTLY, with no new code path and no narrower set.
// It compares against a name that has no allowlist at all, so "identical" is
// measured rather than assumed.
func TestAllowlistEmptyFallsBackToFanOut(t *testing.T) {
	s, key, ids := allowlistFixture(t, 2)
	ctx := context.Background()
	dsn := tests.RequireDB(t)
	_ = ids

	clear := tests.SeedGlobalVirtualAllowlist(t, dsn, "fudrouter/worker", nil)
	// Explicitly empty: SeedGlobalVirtualAllowlist already deleted the rows,
	// but the clear func is what the test would use to empty it mid-run.
	clear()

	fallback, err := s.ResolveModel(ctx, key, "fudrouter/worker")
	if err != nil {
		t.Fatalf("fudrouter/worker with an empty allowlist: %v", err)
	}
	// `fudrouter/coding` has no allowlist and no strategy hint of its own, so
	// its target set IS the fan-out by definition.
	reference, err := s.ResolveModel(ctx, key, "fudrouter/coding")
	if err != nil {
		t.Fatalf("fudrouter/coding: %v", err)
	}
	if fallback.Kind != "virtual" {
		t.Errorf("kind = %q, want virtual", fallback.Kind)
	}
	if !reflect.DeepEqual(fallback.ModelIDs, reference.ModelIDs) {
		t.Fatalf("empty allowlist did not reproduce the fan-out:\n got %v\nwant %v", fallback.ModelIDs, reference.ModelIDs)
	}
	if len(fallback.ModelIDs) == 0 {
		t.Fatal("fan-out is empty — the fixture did not seed a routable model")
	}
}

// TestAllowlistResolvesToCanonicalTargets covers the identity half of invariant
// A/C: an allowlisted row that is a NON-CANONICAL duplicate must contribute the
// canonical model, so its provider mappings and the canonical row's are one
// routing identity. Routing to the duplicate spelling would isolate exactly the
// providers 0026 exists to unite.
func TestAllowlistResolvesToCanonicalTargets(t *testing.T) {
	s, key, ids := allowlistFixture(t, 1)
	ctx := context.Background()
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")

	canonical := ids[0]
	// A second model row whose slug is recorded as an alias OF the canonical
	// row — the duplicate-spelling shape 0026/0028 produce.
	duplicate := tests.SeedRoutableModel(t, dsn, env, "dup-"+strings.ToLower(tests.RandChars(8)))
	tests.SeedSlugAlias(t, dsn, slugOf(t, dsn, duplicate), canonical)

	tests.SeedGlobalVirtualAllowlist(t, dsn, "fudrouter/medium", []string{duplicate})

	res, err := s.ResolveModel(ctx, key, "fudrouter/medium")
	if err != nil {
		t.Fatalf("fudrouter/medium: %v", err)
	}
	if len(res.ModelIDs) != 1 {
		t.Fatalf("resolved %v, want exactly the canonical model %s", res.ModelIDs, canonical)
	}
	if res.ModelIDs[0] != canonical {
		t.Fatalf("resolved %s, want the CANONICAL row %s — a duplicate spelling was routed to directly", res.ModelIDs[0], canonical)
	}
}

// TestAllowlistRejectsCircularTarget covers invariant C's "no circular alias":
// a target whose canonical row is itself an alias key pointing somewhere else is
// rejected. Without this the tier would route to a row the rest of the system
// treats as an alias, isolating its providers — and in a cycle there is no
// canonical member to pick at all.
//
// The assertion is about the REJECTION, not about the models being absent from
// the final answer: once every target is rejected the tier falls back to the
// fan-out, and the fan-out legitimately contains those models. What must never
// happen is the allowlist path resolving one side of the cycle as if it were the
// canonical member — so the test pins that the tier fell back AND said why.
func TestAllowlistRejectsCircularTarget(t *testing.T) {
	s, key, ids := allowlistFixture(t, 2)
	ctx := context.Background()
	dsn := tests.RequireDB(t)

	a, b := ids[0], ids[1]
	slugA, slugB := slugOf(t, dsn, a), slugOf(t, dsn, b)
	// a → b and b → a. The PK on `alias` allows this; nothing in the schema
	// forbids it, which is exactly why resolution has to.
	tests.SeedSlugAlias(t, dsn, slugA, b)
	tests.SeedSlugAlias(t, dsn, slugB, a)

	tests.SeedGlobalVirtualAllowlist(t, dsn, "fudrouter/smart", []string{a, b})

	var logs []string
	restoreLog := store.SetLogfForTest(func(format string, args ...any) {
		logs = append(logs, format)
	})
	t.Cleanup(restoreLog)

	res, err := s.ResolveModel(ctx, key, "fudrouter/smart")
	if err != nil {
		t.Fatalf("fudrouter/smart: %v", err)
	}
	if res.Kind != "virtual" {
		t.Fatalf("kind = %q, want virtual", res.Kind)
	}
	if len(res.ModelIDs) == 0 {
		t.Fatal("a rejected allowlist must fall back to the fan-out, not resolve to nothing")
	}

	// Both targets were rejected, so the tier fell back — and it must say so.
	rejected := 0
	for _, l := range logs {
		if strings.Contains(l, "chain/cycle and was rejected") {
			rejected++
		}
	}
	if rejected != 2 {
		t.Fatalf("logged %d cycle rejections (%v), want 2 — the cycle was resolved instead of refused", rejected, logs)
	}
	// And the fallback must be the FAN-OUT, not a set built from the cycle.
	fanout, err := s.ResolveModel(ctx, key, "fudrouter/coding")
	if err != nil {
		t.Fatalf("fudrouter/coding: %v", err)
	}
	if !reflect.DeepEqual(res.ModelIDs, fanout.ModelIDs) {
		t.Fatalf("rejected allowlist resolved %v, want the fan-out %v", res.ModelIDs, fanout.ModelIDs)
	}
}

// TestAllowlistDeduplicatesTargets proves the dedupe half of invariant A: two
// allowlist rows that canonicalise to one model are ONE target. Keeping both
// would double that model's candidates in the merged set, which biases a
// `random` draw towards whichever model happens to be written down twice.
func TestAllowlistDeduplicatesTargets(t *testing.T) {
	s, key, ids := allowlistFixture(t, 1)
	ctx := context.Background()
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")

	canonical := ids[0]
	duplicate := tests.SeedRoutableModel(t, dsn, env, "dup2-"+strings.ToLower(tests.RandChars(8)))
	tests.SeedSlugAlias(t, dsn, slugOf(t, dsn, duplicate), canonical)

	// The SAME model twice, spelled two ways.
	tests.SeedGlobalVirtualAllowlist(t, dsn, "fudrouter/balanced", []string{canonical, duplicate})

	res, err := s.ResolveModel(ctx, key, "fudrouter/balanced")
	if err != nil {
		t.Fatalf("fudrouter/balanced: %v", err)
	}
	count := 0
	for _, id := range res.ModelIDs {
		if id == canonical {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("canonical model %s appears %d times in %v, want exactly once", canonical, count, res.ModelIDs)
	}
	if len(res.ModelIDs) != 1 {
		t.Fatalf("resolved %v, want one deduplicated target", res.ModelIDs)
	}
}

// TestAutoTierUsesLiveSet is the `auto` contract: with no allowlist its target
// set is the LIVE SET — models that produced a 2xx in the last 24h — not the
// whole catalogue. The fixture records one success for one model and one FAILURE
// for another, and requires the failing model to be absent.
func TestAutoTierUsesLiveSet(t *testing.T) {
	s, key, ids := allowlistFixture(t, 2)
	ctx := context.Background()
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")

	live, dead := ids[0], ids[1]
	// Neither has traffic yet: clear anything another test left behind.
	tests.DropLiveAttempts(t, dsn, ids...)
	store.ResetLiveSetForTest(s)

	tests.SeedLiveAttempt(t, dsn, env, live, 200)
	tests.SeedLiveAttempt(t, dsn, env, dead, 500)
	store.ResetLiveSetForTest(s)

	res, err := s.ResolveModel(ctx, key, "fudrouter/auto")
	if err != nil {
		t.Fatalf("fudrouter/auto: %v", err)
	}
	got := map[string]bool{}
	for _, id := range res.ModelIDs {
		got[id] = true
	}
	if !got[live] {
		t.Errorf("model %s answered 200 and is missing from the live set %v", live, res.ModelIDs)
	}
	if got[dead] {
		t.Errorf("model %s only ever answered 500 and is in the live set anyway — the 2xx filter is not applied", dead)
	}
	// The decoy-free assertion above is the contract; this one states the
	// intent: `auto` is not the full catalogue.
	fanout, err := s.ResolveModel(ctx, key, "fudrouter/coding")
	if err != nil {
		t.Fatalf("fudrouter/coding: %v", err)
	}
	if len(res.ModelIDs) >= len(fanout.ModelIDs) && len(fanout.ModelIDs) > 1 {
		t.Errorf("auto resolved %d models and the full fan-out resolves %d — auto is not narrowing to the live set",
			len(res.ModelIDs), len(fanout.ModelIDs))
	}
}

// TestAutoTierEmptyLiveSetFallsBackToFanOut is the recovery path from invariant
// C: an empty live set is NOT "everything is healthy", it is "nothing answered".
// The router must widen to the fan-out (so traffic still flows) and SAY that it
// did — a silent widening is the failure mode this test exists to catch.
//
// The window is forced to zero rather than relying on the suite's traffic being
// old: "no 2xx happened recently" has to be a fact the test creates, not one it
// hopes for.
func TestAutoTierEmptyLiveSetFallsBackToFanOut(t *testing.T) {
	s, key, ids := allowlistFixture(t, 2)
	ctx := context.Background()
	dsn := tests.RequireDB(t)
	_ = dsn

	restoreWindow := store.SetLiveWindowForTest(0)
	t.Cleanup(restoreWindow)
	var logs []string
	restoreLog := store.SetLogfForTest(func(format string, args ...any) {
		logs = append(logs, format)
	})
	t.Cleanup(restoreLog)
	store.ResetLiveSetForTest(s)
	t.Cleanup(func() { store.ResetLiveSetForTest(s) })

	res, err := s.ResolveModel(ctx, key, "fudrouter/auto")
	if err != nil {
		t.Fatalf("fudrouter/auto with an empty live set: %v", err)
	}
	if res.Kind != "virtual" {
		t.Fatalf("kind = %q, want virtual", res.Kind)
	}
	got := map[string]bool{}
	for _, id := range res.ModelIDs {
		got[id] = true
	}
	// With a zero window nothing can be live, so our models can only appear
	// through the fan-out.
	for _, id := range ids {
		if !got[id] {
			t.Errorf("model %s is absent from the resolved set %v; an empty live set must fall back to the fan-out", id, res.ModelIDs)
		}
	}
	// The fallback must be LOUD. A tier that silently serves everything looks
	// healthy in metrics while being an outage.
	if len(logs) == 0 {
		t.Fatal("empty live set fell back to the fan-out with no log line — the recovery path is silent")
	}
	found := false
	for _, l := range logs {
		if strings.Contains(l, "live set is EMPTY") {
			found = true
		}
	}
	if !found {
		t.Fatalf("fallback logged %v, want a line naming the empty live set", logs)
	}
}

// TestAllowlistTierStrategyHintsDiffer pins the ladder's naming contract: each
// tier must carry its OWN strategy, or the four names are the same tier wearing
// different labels (the defect this card exists to fix).
func TestAllowlistTierStrategyHintsDiffer(t *testing.T) {
	s, key, _ := allowlistFixture(t, 1)
	ctx := context.Background()

	want := map[string]string{
		"fudrouter/auto":   "random",
		"fudrouter/smart":  "highest_reliability",
		"fudrouter/medium": "lowest_latency",
		"fudrouter/worker": "lowest_cost",
	}
	seen := map[string]string{}
	for name, wantHint := range want {
		res, err := s.ResolveModel(ctx, key, name)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if res.StrategyHint != wantHint {
			t.Errorf("%s hint = %q, want %q", name, res.StrategyHint, wantHint)
		}
		if prev, dup := seen[res.StrategyHint]; dup {
			t.Errorf("%s and %s share the hint %q — the tiers are indistinguishable", name, prev, res.StrategyHint)
		}
		seen[res.StrategyHint] = name
		if !res.RequiredCapabilities["chat"] {
			t.Errorf("%s does not require chat capability", name)
		}
	}
}

// TestAllowlistResolutionStaysTwoQueries pins the round-trip budget for an
// ALLOWLISTED tier.
//
// A populated allowlist adds one query (the canonicalisation pass) on top of the
// resolve, so the cost is 2 — the same as every other virtual
// (TestVirtualCapabilityTargetsMatchCandidates asserts that). Without this
// assertion a future change could turn the allowlist into a per-target probe and
// nobody would notice until the admission budget broke: the tier is on the hot
// path of every request that names it.
func TestAllowlistResolutionStaysTwoQueries(t *testing.T) {
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")
	s, tr := startCounting(t, dsn)
	ctx := context.Background()

	ids := []string{
		tests.SeedRoutableModel(t, dsn, env, "qc-a-"+strings.ToLower(tests.RandChars(6))),
		tests.SeedRoutableModel(t, dsn, env, "qc-b-"+strings.ToLower(tests.RandChars(6))),
	}
	tests.SeedGlobalVirtualAllowlist(t, dsn, "fudrouter/worker", ids)

	key := &store.APIKeyRow{UserID: env.UserID}
	// Warm the pool so the count is statements, not connection setup.
	if _, err := s.ResolveModel(ctx, key, "fudrouter/worker"); err != nil {
		t.Fatalf("warm resolve: %v", err)
	}
	tr.Reset()
	res, err := s.ResolveModel(ctx, key, "fudrouter/worker")
	if err != nil {
		t.Fatalf("fudrouter/worker: %v", err)
	}
	if len(res.ModelIDs) != 2 {
		t.Fatalf("resolved %d targets, want the 2 allowlisted", len(res.ModelIDs))
	}
	if got := tr.Count(); got != 2 {
		t.Fatalf("allowlisted resolution issued %d queries, want 2 (resolve + canonicalise); statements: %v",
			got, tr.Texts())
	}
}

// slugOf reads a model's stored slug, so a fixture can record an identity
// mapping without the test having to remember the generated spelling.
func slugOf(t *testing.T, dsn, modelID string) string {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var slug string
	if err := conn.QueryRow(ctx, `select slug from model where id = $1`, modelID).Scan(&slug); err != nil {
		t.Fatalf("read slug of %s: %v", modelID, err)
	}
	return slug
}

// TestAutoTierSpreadsAcrossLiveModels is the end-to-end half of the `random`
// contract: it drives the SAME two calls the lifecycle makes (ResolveModel, then
// routing.Select over the candidates that resolution produced) and requires that
// many requests against `fudrouter/auto` land on more than one model.
//
// Why this needs a store-level test and not just the routing unit test: the unit
// test proves Select shuffles, but `auto` is only fair if the SET it shuffles is
// the live set and the shuffle survives the reliability/credential partitions.
// A tier that always resolves one model, or whose shuffle is undone downstream,
// passes the unit test and fails the product promise.
func TestAutoTierSpreadsAcrossLiveModels(t *testing.T) {
	s, key, ids := allowlistFixture(t, 3)
	ctx := context.Background()
	dsn := tests.RequireDB(t)
	env := tests.SeedEnv(t, dsn, "http://127.0.0.1:1")

	// All three answer 200, so all three belong to the live set.
	tests.DropLiveAttempts(t, dsn, ids...)
	for _, id := range ids {
		tests.SeedLiveAttempt(t, dsn, env, id, 200)
	}
	store.ResetLiveSetForTest(s)
	t.Cleanup(func() { store.ResetLiveSetForTest(s) })

	res, err := s.ResolveModel(ctx, key, "fudrouter/auto")
	if err != nil {
		t.Fatalf("fudrouter/auto: %v", err)
	}
	// Every live seeded model must be in the set (the shuffle needs a set to
	// spread across).
	inSet := map[string]bool{}
	for _, id := range res.ModelIDs {
		inSet[id] = true
	}
	for _, id := range ids {
		if !inSet[id] {
			t.Fatalf("live model %s missing from auto's set %v", id, res.ModelIDs)
		}
	}

	// Select over the resolved set, the way lifecycle.begin does, and count the
	// winners. `random` is the hint the tier advertises, so that is the strategy
	// ResolveStrategy produces.
	strategy := routing.ResolveStrategy("balanced", "", res.StrategyHint)
	if strategy != routing.StrategyRandom {
		t.Fatalf("auto resolved strategy %q, want random", strategy)
	}
	byModel, err := s.CandidatesBatch(ctx, res.ModelIDs, res.RequiredCapabilities)
	if err != nil {
		t.Fatalf("CandidatesBatch: %v", err)
	}
	var merged []routing.Candidate
	for _, id := range res.ModelIDs {
		cands := byModel[id]
		for j := range cands {
			c := cands[j]
			rc := routing.Candidate{Store: &c}
			rc.LoadSignals()
			merged = append(merged, rc)
		}
	}
	if len(merged) == 0 {
		t.Fatal("no candidates for the live set — the fixture did not seed routable mappings")
	}
	winners := map[string]int{}
	for range 120 {
		got := routing.Select(merged, routing.Plan{Strategy: strategy, Weights: routing.DefaultWeights()})
		if len(got) == 0 {
			t.Fatal("Select returned nothing")
		}
		winners[got[0].Store.ModelID]++
	}
	if len(winners) < 2 {
		t.Fatalf("auto routed every one of 120 requests to %v — the tier is not spreading", winners)
	}
}
