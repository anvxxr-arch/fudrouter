package store

// Allowlist tiers: what a `fudrouter/*` virtual is allowed to choose FROM.
//
// Before this file a virtual name meant exactly one thing — "every chat-capable
// model that is servable right now" (activeModelIDs). That is a fan-out, not a
// tier: `fudrouter/auto`, `fudrouter/balanced` and `fudrouter/reliable` resolved
// to the IDENTICAL candidate set and differed only in how they ranked it, so the
// names were a ranking menu rather than a product ladder. `model_alias_target`
// has existed since 0006 and could always have expressed "these six models, not
// the whole catalogue", but the virtual branch never read it — only the
// account-alias arm did.
//
// The split this file implements (PRD §36):
//
//	allowlist (model_alias_target rows)  = WHO may be chosen
//	strategy (routing/select.go)         = HOW one of them is chosen
//	ModelPref (routing policy)           = tie-break ranking, unchanged
//
// Resolution order for a virtual name, first match wins:
//
//  1. the alias's `model_alias_target` rows, canonicalised — the allowlist;
//  2. `fudrouter/auto` with no allowlist: the LIVE SET (a 2xx in the last 24h);
//  3. the old full fan-out (`activeModelIDs`).
//
// Three properties are load-bearing, each pinned by a test in
// virtual_allowlist_test.go:
//
//   - BACKWARD COMPATIBLE (invariant A). A virtual with no targets resolves
//     exactly as it does today, so opting into a tier is inserting rows and
//     opting out is deleting them — no deploy, no flag, no new code path. Every
//     name except `auto` still lands on step 3 when it has no allowlist, and
//     `auto` lands there too whenever nothing is live.
//
//   - CANONICAL (invariants A/C). A target id is resolved to its canonical
//     model row through `model_slug_alias` before it joins the set, exactly
//     like the literal-slug branch of ResolveModel. Without that, a target that
//     happens to be a non-canonical duplicate would drag only its OWN provider
//     mappings into the tier and strand the providers recorded against the
//     canonical row — the depth-1 defect 0026 exists to prevent, reintroduced
//     through a different door. A target whose identity mapping is not a single
//     hop (a CHAIN a→b→c, or a CYCLE a→b→a) is rejected rather than guessed at:
//     routing to a row the rest of the system calls an alias isolates its
//     providers, and picking a winner inside a cycle is arbitrary.
//
//   - HONEST ABOUT STALENESS (invariant C: live ≠ reliable ≠ available). The
//     allowlist may name a model that is currently failing. That model is NOT
//     silently removed, because the request path already filters availability:
//     CandidatesBatch drops disabled/unhealthy mappings and Select demotes
//     collapsed targets. Deleting rows behind an operator's back would make a
//     tier's membership unknowable from the outside, which is worse than
//     routing to a target that will lose the ranking.
//
// The live set is the ONE place a model is excluded for measured behaviour, and
// it is `auto`'s DEFINITION rather than a hidden filter: `auto` promises "a model
// that is answering right now", so "answering" has to be an input. An empty live
// set is a RECOVERY state — the query widens to the full fan-out and logs it,
// never silently assuming every model is healthy.

import (
	"context"
	"log"
	"sync"
	"time"
)

const (
	// autoVirtual is the one name whose empty-allowlist default set is the live
	// set instead of the full fan-out.
	autoVirtual = "fudrouter/auto"

	// liveWindowHours is the definition of "live": one 2xx inside this window.
	//
	// 24h and not 15 minutes because the failure mode this avoids is a model
	// that is UP but rarely used — a short window would drop a perfectly
	// healthy long-tail model the moment nobody happened to call it, turning
	// "auto" into "the three models with the most traffic". A day is long
	// enough that a healthy model is almost always in it, short enough that a
	// retired upstream stops counting.
	liveWindowHours = 24

	// liveSetTTL bounds how stale the live set may be. The window it reads is
	// 24 hours wide, so 60s is 0.07% of it: the set cannot change meaningfully
	// inside one TTL. The scan itself is cheap — the partial index from
	// migration 0031 answers it in 3.6ms on a 262k-row ledger against 69ms
	// without it — but per-request is still the wrong shape for a value that
	// only changes when traffic does.
	liveSetTTL = 60 * time.Second
)

// logf is the store's only log sink. A package-level seam rather than a logger
// field because the store has no logger and should not grow one: the callers
// that reach it are exactly the cases where a silent fallback would hide an
// outage or a misconfiguration. Tests replace it through export_test.go.
var logf = log.Printf

// liveWindowHoursForQuery is the window the live-set SQL is handed. It equals
// liveWindowHours in production and exists as a VARIABLE only so a test can set
// it to zero: proving the empty-live-set recovery path by waiting for real
// traffic to age out is not a test, and asserting "the live set happened to be
// empty" depends on every other test in the suite. Set through export_test.go.
var liveWindowHoursForQuery = liveWindowHours

// liveSetCache caches the live set per capability requirement. A zero exp means
// "never computed".
//
// The slices it hands back are the CACHED ONES, not copies — the same contract as
// the admission cache (admission.go). Nothing on the request path writes to a
// resolution's ModelIDs/ModelSlugs: CandidatesBatch only reads them, and
// lifecycle copies ModelSlugs before putting them on the plan.
type liveSetCache struct {
	mu      sync.Mutex
	ids     []string
	slugs   []string
	exp     time.Time
	capsKey string
}

func (c *liveSetCache) get(key string) ([]string, []string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.exp.After(time.Now()) || c.capsKey != key {
		return nil, nil, false
	}
	return c.ids, c.slugs, true
}

func (c *liveSetCache) put(key string, ids, slugs []string) {
	c.mu.Lock()
	c.ids, c.slugs, c.capsKey = ids, slugs, key
	c.exp = time.Now().Add(liveSetTTL)
	c.mu.Unlock()
}

// reset drops the cache. Tests call it through export_test.go: a test that seeds
// attempt rows must not read a set cached before the seed.
//
// It clears the FIELDS, not the struct: `*c = liveSetCache{}` would overwrite the
// mutex this function is holding, and a zeroed sync.Mutex is unlocked — so the
// deferred Unlock would then unlock an unlocked mutex and panic the process
// ("sync: unlock of unlocked mutex"). That is not theoretical; it is what this
// function did on its first run.
func (c *liveSetCache) reset() {
	c.mu.Lock()
	c.ids, c.slugs, c.capsKey = nil, nil, ""
	c.exp = time.Time{}
	c.mu.Unlock()
}

// resolveVirtual assembles a virtual name's candidate set.
//
// allowlist are the `model_alias_target.model_id` values the resolve query
// already read for this alias, in `position` order. Empty means "no allowlist
// declared" — the backward-compatible path.
//
// liveSet marks the tier whose empty-allowlist default set is the live set
// instead of the full fan-out (`fudrouter/auto`).
func (s *Store) resolveVirtual(ctx context.Context, name, strategy string, caps map[string]bool, liveSet bool, allowlist []string) (*ModelResolution, error) {
	res := &ModelResolution{
		Requested:            name,
		Kind:                 "virtual",
		StrategyHint:         strategy,
		RequiredCapabilities: caps,
	}

	// 1: the operator's allowlist. It wins outright — a declared list is a
	// decision the router must not second-guess, and that includes `auto`: its
	// live set narrows the DEFAULT set, not a list somebody wrote down.
	if len(allowlist) > 0 {
		ids, slugs, err := s.canonicalTargets(ctx, name, allowlist)
		if err != nil {
			return nil, err
		}
		if len(ids) > 0 {
			res.ModelIDs, res.ModelSlugs = ids, slugs
			return res, nil
		}
		// The allowlist exists but every row is retired, missing, chained or
		// duplicated. Falling through beats answering 404 for the whole name:
		// a tier that cannot serve is worse than one that serves too widely,
		// and the log line is what makes the misconfiguration visible.
		logf("fudrouter: virtual %s: allowlist of %d target(s) resolved to 0 routable canonical models; falling back to the default set", name, len(allowlist))
	}

	// 2: `auto`'s default set is the live set. modelSetIDs falls back to the
	// full fan-out INSIDE the same statement when nothing is live, and logs
	// that it did (see liveSetTail), so the recovery path costs no extra round
	// trip and cannot pass silently.
	if liveSet {
		ids, slugs, err := s.modelSetIDs(ctx, caps, true)
		if err != nil {
			// A failed live-set read must not fail the request: the fan-out is
			// a strictly WIDER set, so degrading to it cannot refuse traffic
			// the live set would have served.
			logf("fudrouter: virtual %s: live-set read failed (%v); falling back to the full active fan-out", name, err)
			ids, slugs, err = s.activeModelIDs(ctx, caps)
		}
		if err != nil {
			return nil, err
		}
		res.ModelIDs, res.ModelSlugs = ids, slugs
		return res, nil
	}

	// 3: the old full fan-out.
	ids, slugs, err := s.activeModelIDs(ctx, caps)
	if err != nil {
		return nil, err
	}
	res.ModelIDs, res.ModelSlugs = ids, slugs
	return res, nil
}

// canonicalTargets resolves each allowlisted model id to its canonical row,
// deduplicated, in the allowlist's declared `position` order.
//
// Deduplication is the point of `distinct on`: two allowlist rows pointing at two
// spellings of the same model are ONE target, and keeping both would double that
// model's candidates in the merged set and skew a `random` draw towards whichever
// model happens to be recorded twice. The outer `order by pos` restores the
// operator's declared order after the dedupe, so the set is deterministic and
// testable rather than planner-ordered.
//
// `chained` marks a target whose canonical row is ITSELF an alias key pointing
// somewhere else — the shape a multi-hop chain (a→b→c) or a cycle (a→b→a) takes
// in this schema, where the primary key is `alias` alone and both are therefore
// representable. Both are rejected: a chain means the mapping is not idempotent,
// and a cycle has no canonical member to route to.
//
// Rows that are not `active` do not come back, because CandidatesBatch requires
// `model.status = 'active'`; an id that can never produce a candidate would only
// inflate the set. The count difference is logged once, so a shrinking tier is
// visible rather than silent. This is NOT the availability filter — a model that
// is merely failing stays, and admission decides whether it can serve.
func (s *Store) canonicalTargets(ctx context.Context, virtual string, allowlist []string) ([]string, []string, error) {
	rows, err := s.pool.Query(ctx, `
		select canonical_id, canonical_slug, chained
		from (
		    select distinct on (coalesce(canonical.id, m.id))
		           coalesce(canonical.id, m.id) as canonical_id,
		           coalesce(canonical.slug, m.slug) as canonical_slug,
		           exists (
		               select 1 from model_slug_alias hop
		               where hop.alias = coalesce(canonical.slug, m.slug)
		                 and hop.canonical_model_id <> coalesce(canonical.id, m.id)
		           ) as chained,
		           t.pos
		    from unnest($1::text[]) with ordinality as t(model_id, pos)
		    join model m on m.id = t.model_id
		    left join model_slug_alias identity on identity.alias = m.slug
		    left join model canonical on canonical.id = identity.canonical_model_id
		      and canonical.status = 'active'
		    where m.status = 'active'
		    order by coalesce(canonical.id, m.id), t.pos
		) resolved
		order by pos`, allowlist)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	var ids, slugs []string
	var rejected int
	for rows.Next() {
		var id, slug string
		var chained bool
		if err := rows.Scan(&id, &slug, &chained); err != nil {
			return nil, nil, err
		}
		if chained {
			rejected++
			logf("fudrouter: virtual %s: allowlist target %s resolves through a chain/cycle and was rejected", virtual, slug)
			continue
		}
		ids = append(ids, id)
		slugs = append(slugs, slug)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	if dropped := len(allowlist) - len(ids) - rejected; dropped > 0 {
		logf("fudrouter: virtual %s: %d of %d allowlist target(s) are inactive, missing or duplicated and were dropped", virtual, dropped, len(allowlist))
	}
	return ids, slugs, nil
}

// capsKey renders a capability requirement as a stable cache key. Only `true`
// entries matter: RequiredCapabilities is the set of capabilities the request
// insists on, so an explicit `false` never appears in it.
func capsKey(caps map[string]bool) string {
	keys := make([]string, 0, len(caps))
	for k, v := range caps {
		if v {
			keys = append(keys, k)
		}
	}
	// Insertion sort: the set is tiny, and this keeps the key deterministic
	// without pulling `sort` into a file that has no other use for it. Map
	// iteration order is randomised, and a key that changed between two
	// identical calls would miss the cache every time.
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	var b []byte
	for _, k := range keys {
		b = append(b, k...)
		b = append(b, ';')
	}
	return string(b)
}
