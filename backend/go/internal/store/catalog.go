package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
)

// ModelInfo is one published catalogue row — everything `/v1/models` and
// `/v1/models/{model}` return (endpoint-surface spec §3 rows 4–5, and
// compatibility promise #4 in schema spec §14: `id`, `object`, `owned_by` plus
// the additive `context` and `pricing`).
type ModelInfo struct {
	Slug        string
	Name        string
	Context     int // `model.context` = context window (spec §5)
	OwnedBy     string
	InputPrice  string // numeric(18,6) micro-units per 1M tokens, as stored
	OutputPrice string
	Currency    string
}

// displayFamilyCTE is the ONE definition of a model's display family: the set
// of catalogue rows that are the SAME model under a different spelling. Two
// spellings fold here, and only here:
//
//   - a recorded `model_slug_alias` identity (migration 0028's canonical
//     union: `Kimi-K2.6`, `kimi-k2.6`, `tokenharbor/kimi-k2.6` are one model);
//   - a trailing variant suffix — `:free`, `-free`, `-thinking`,
//     `-thinking:free`, `-fast` — and ONLY when the stripped remainder names an
//     existing active chat row.
//
// WHY the fold lives in presentation and not in resolution: folding at
// `ResolveModel` would serve the non-reasoning base to a client that explicitly
// asked for `-thinking`, and would merge free/paid pricing in the biller. Raw
// slugs therefore keep resolving, and keep billing, exactly as before; only the
// catalogue and the health probe see families.
//
// WHY a closure and not one hop: the real catalogue carries
// `tokenharbor/deepseek-v4.1-flash:free`, whose alias target is
// `deepseek-v4.1-flash:free` and whose suffix-stripped base is
// `tokenharbor/deepseek-v4.1-flash`. A single hop reaches a DIFFERENT
// intermediate row for each spelling and leaves three entries for one model.
// `family_walk` follows every edge to a fixpoint; `UNION` (not `UNION ALL`)
// makes a cyclic alias/variant pair terminate instead of recursing forever.
//
// WHY the family key is the plainest reachable slug: the key is both the
// grouping identity and the published display slug, so it must be the row an
// operator would name — no provider prefix first, then the lower-case spelling,
// then lexicographic order (the precedence migration 0028's `ranked` CTE used
// to pick a canonical id). A base is a prefix of every variant of it, so a
// plain slug always sorts ahead of its own variants.
//
// Chat-only throughout: an image, audio or embedding row must never become a
// family key, or it would inherit a chat row's variants and publish a model the
// chat surface cannot serve.
const displayFamilyCTE = `
	with recursive
	chat_model as (
		select m.id, m.slug, lower(m.slug) as lslug,
		       m.name, m.context, m.input_price, m.output_price, m.currency
		from model m
		where m.status = 'active'
		  and (m.capabilities->>'chat') is distinct from 'false'
	),
	variant_strip(suffix) as (values
		(':free'), ('-free'), ('-thinking'), ('-thinking:free'), ('-fast')
	),
	-- Both edge CTEs are MATERIALIZED on purpose: the recursive walk below
	-- re-reads them once per iteration, and left inlined the planner re-derived
	-- (and re-sorted) the whole edge set each time. Measured on a 6,700-row
	-- fixture: 393 ms inlined, 6 ms materialized.
	fold_edge as materialized (
		select lower(a.alias) as src, c.lslug as dst
		from model_slug_alias a
		join chat_model c on c.id = a.canonical_model_id
		union
		select m.lslug, b.lslug
		from chat_model m
		join variant_strip v
		  on lower(right(m.slug, length(v.suffix))) = lower(v.suffix)
		join chat_model b
		  on b.lslug = lower(left(m.slug, length(m.slug) - length(v.suffix)))
		where b.id <> m.id
	),
	-- The family is a CONNECTED COMPONENT, so the walk is undirected: a row
	-- that is only ever pointed AT (a prefixed sibling reached through someone
	-- else's alias) is still the same model and must be folded with its
	-- pointers. Following only forward edges left that sibling as its own
	-- family, which is the second entry this fold exists to remove.
	family_link as materialized (
		select src, dst from fold_edge
		union
		select dst, src from fold_edge
	),
	family_walk as (
		select c.lslug as start_slug, c.lslug as key_slug
		from chat_model c
		union
		select w.start_slug, e.dst
		from family_walk w
		join family_link e on e.src = w.key_slug
	),
	family_key as (
		select distinct on (start_slug) start_slug, key_slug as family_key
		from family_walk
		order by start_slug, (position('/' in key_slug) = 0) desc, key_slug
	)`

// displayWinnerCTE returns the servability gate and the family winner. It is
// appended to displayFamilyCTE by every catalogue read, so the list, the detail
// endpoint and the health probe cannot disagree about which family a slug
// belongs to or which row represents it.
//
// The servable gate is PER FAMILY, not per row: a family is published when at
// least one of its members passes the predicate the hot path uses (enabled
// provider_model + enabled/healthy connection + a usable credential +
// providerServableSQL). That is what keeps a combo with a dead primary
// advertised: the primary's row is not servable, the fallback's row is.
//
// The winner's identity and price are its OWN row's values — no summing, no
// fanning.
func (s *Store) displayWinnerCTE() string {
	return `, servable_model as (
		select distinct m.id
		from model m
		join provider_model pm on pm.model_id = m.id and pm.enabled
		join provider p on p.id = pm.provider_id
		where m.status = 'active'
		  and (m.capabilities->>'chat') is distinct from 'false'
		  and pm.status not in ('disabled', 'unavailable')
		  and exists (
			select 1 from connection c
			where c.id = pm.connection_id
			  and c.enabled
			  and c.health_status is distinct from 'unhealthy'
			  and exists (
				select 1 from credential cr
				where cr.connection_id = c.id
				  and cr.status not in ('disabled', 'invalid')
				  and (cr.cooldown_until is null or cr.cooldown_until <= now())
			  )
		  )
		  and ` + s.providerServableSQL() + `
	),
	family_servable as (
		select distinct fk.family_key
		from family_key fk
		join chat_model m on m.lslug = fk.start_slug
		join servable_model sm on sm.id = m.id
	),
	winner as (
		select distinct on (fk.family_key)
		       fk.family_key, m.id, m.slug, m.name, m.context,
		       m.input_price, m.output_price, m.currency
		from family_key fk
		join chat_model m on m.lslug = fk.family_key
		order by fk.family_key,
		         (position('/' in m.slug) = 0) desc,
		         (m.slug = lower(m.slug)) desc,
		         m.slug, m.id
	)`
}

// displayCatalogueSQL is the SELECT shared by both catalogue endpoints: one row
// per display family, carrying the winner's own identity and price. The two
// callers differ only in their WHERE clause, and they share this text so the
// list and the detail view cannot drift (endpoint-surface §7 acceptance).
func (s *Store) displayCatalogueSQL() string {
	return displayFamilyCTE + s.displayWinnerCTE() + `
	select w.slug, w.name, coalesce(w.context, 0),
	       coalesce(pr.input_price::text, w.input_price::text),
	       coalesce(pr.output_price::text, w.output_price::text),
	       coalesce(pr.currency, w.currency, 'USD')
	from winner w
	left join lateral (
		select input_price, output_price, currency
		from pricing_rule r
		where r.model_id = w.id
		  and r.provider_model_id is null
		  and r.effective_from <= now()
		  and (r.effective_until is null or r.effective_until > now())
		order by r.version desc
		limit 1
	) pr on true`
}

// DisplayFamilyIDs returns every active chat model id in slug's display family:
// the requested row, every `model_slug_alias` sibling of its canonical
// identity, and every active chat row whose slug is a suffix-stripped variant
// of a family member — followed transitively in both directions.
//
// The health probe uses this to dial the WHOLE combo instead of one spelling.
// A family whose primary provider is down but whose fallback answers must
// report ok; probing a single row reported "down" for a model that still
// served. Resolution and billing are untouched: this is a read.
//
// Empty (no error) when slug names no active chat row — the probe turns that
// into `model_unresolved`, exactly like an unresolvable slug.
func (s *Store) DisplayFamilyIDs(ctx context.Context, slug string) ([]string, error) {
	rows, err := s.pool.Query(ctx, displayFamilyCTE+`
	select distinct m.id
	from chat_model m
	join family_key fk on fk.start_slug = m.lslug
	where fk.family_key = (
		select family_key from family_key where start_slug = lower($1)
	)
	order by m.id`, slug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// ActiveModels lists the published chat catalogue: ONE entry per same-model
// display family, folded across prefixed aliases and trailing variant
// suffixes.
//
// The gate is the same rule the control plane's publish gate implements
// (`packages/platform/publish.ts`, endpoint-surface spec §2.1): canonical model
// active AND provider servable. Two views of one catalogue must not drift.
//
// The connection + credential predicates mirror Candidates exactly, so a model
// the hot path cannot dial is not advertised: on the deployed box 249 of 346
// published models had no live credential, and every one of them failed at
// request time. The catalogue now describes what the router can serve.
//
// Chat-only: `capabilities->>'chat'` is not an explicit `false`. The catalogue
// is the chat surface (spec §2.1) — embedding, image, audio and video models
// are published rows the chat endpoint cannot serve, and advertising them cost
// users a 400 they had to discover by asking. The gate is the same one the
// request path uses (CapabilitySatisfied eliminates only on an explicit
// `false`), so the two views cannot drift.
//
// A missing claim stays advertised on purpose. Migration 0012 backfilled every
// row that existed when it ran; rows onboarded afterwards (claude-fable-5-1,
// gpt-6-sol, qwen3-coder-next, …) are chat models whose claim is simply absent.
// `= 'true'` would hide 12 working chat models from the catalogue, which is the
// same class of bug this gate exists to fix — the catalogue promising less than
// the router can serve.
func (s *Store) ActiveModels(ctx context.Context) ([]ModelInfo, error) {
	rows, err := s.pool.Query(ctx, s.displayCatalogueSQL()+`
	where w.family_key in (select family_key from family_servable)
	order by w.slug`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ModelInfo
	for rows.Next() {
		var m ModelInfo
		if err := rows.Scan(&m.Slug, &m.Name, &m.Context, &m.InputPrice, &m.OutputPrice, &m.Currency); err != nil {
			return nil, err
		}
		m.OwnedBy = "fudrouter"
		out = append(out, m)
	}
	return out, rows.Err()
}

// PublishedModel returns ONE catalogue row by slug — the `/v1/models/{model}`
// handler (endpoint-surface spec §6 P1). Unknown or unpublished → ErrNotFound,
// which the handler turns into a truthful 404. Public, exactly like
// `/v1/models`: the catalogue is not a protected resource (spec §2.1).
//
// Same chat-surface gate as ActiveModels, for the same reason: a model
// `/v1/models` does not list must not be reachable through `/v1/models/{slug}`,
// or the two views of one catalogue drift.
//
// The slug is resolved to its DISPLAY FAMILY first, so the detail endpoint
// answers with exactly the object the list publishes for that family. That is
// what lets a client that names a folded spelling (`…:free`, `-thinking`) get
// the published entry back instead of a 404 or a twin entry the list never
// showed. Resolution and billing still see the raw slug: this is presentation.
func (s *Store) PublishedModel(ctx context.Context, slug string) (*ModelInfo, error) {
	m := &ModelInfo{OwnedBy: "fudrouter"}
	var priceIn, priceOut, curCode *string
	err := s.pool.QueryRow(ctx, s.displayCatalogueSQL()+`
	where w.family_key in (select family_key from family_servable)
	  and w.family_key = (
		select family_key from family_key where start_slug = lower($1)
	  )
	limit 1`, slug,
	).Scan(&m.Slug, &m.Name, &m.Context, &priceIn, &priceOut, &curCode)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if priceIn != nil {
		m.InputPrice = *priceIn
	}
	if priceOut != nil {
		m.OutputPrice = *priceOut
	}
	if curCode != nil {
		m.Currency = *curCode
	}
	return m, nil
}

// providerServableSQL returns the one provider predicate, precomputed once at
// Store construction (see providerServableSQLFor). The dev-tier opt-in is a
// process-level bool read once, so the string cannot change for the Store's
// lifetime and every call site interpolates it without rebuilding it.
func (s *Store) providerServableSQL() string {
	return s.providerServable
}

// providerServableSQLFor builds the one provider predicate. It speaks BOTH
// status vocabularies because migration 0009 widened the CHECKs while 0010 still
// has to move the values: S0 rows carry `status='active'|'dev'` and post-0010 rows
// carry the PRD §52 set with `tier='commercial'|'dev'`. Either way a dev-tier
// provider needs the opt-in. The opt-in is a process-level bool (read once at
// Store construction), so it is interpolated as a `true`/`false` literal — no
// query-parameter juggling across the four call sites.
//
// Computed once per Store rather than per call: every catalogue query
// (ActiveModels, PublishedModel, Candidates) previously rebuilt this string on
// each execution, and the value cannot change — the flag is read once at
// construction.
func providerServableSQLFor(allowDevProviders bool) string {
	dev := "false"
	if allowDevProviders {
		dev = "true"
	}
	return `p.enabled
	and (p.tier = 'commercial' or ` + dev + `)
	and p.status not in ('disabled', 'maintenance', 'outage')
	and (p.status <> 'dev' or ` + dev + `)`
}

// ModelResolution is what a request's `model` string resolved to (spec §5):
// a literal canonical model, an alias's ordered target set, or a global
// virtual (`fudrouter/*`) whose targets are STRATEGY-resolved at request time,
// not pinned rows.
type ModelResolution struct {
	// Requested is the raw string the customer sent.
	Requested string
	// Kind is "model", "alias" or "virtual".
	Kind string
	// ModelIDs is the candidate model set: one id for a literal model, the
	// alias targets in `position` order, or ALL active models for a virtual.
	ModelIDs []string
	// ModelSlugs parallels ModelIDs (for logging and the response header).
	ModelSlugs []string
	// StrategyHint overrides the routing policy's strategy for this request
	// (virtuals: fudrouter/fast → lowest_latency, …). Empty = policy decides.
	StrategyHint string
	// RequiredCapabilities are capabilities the request insists on (a virtual
	// like `fudrouter/reasoning` implies `reasoning`). Values are compared
	// against effective capabilities; only an explicit `false` eliminates
	// (spec §5).
	RequiredCapabilities map[string]bool
}

// chatOnly is the capability every virtual requires: these names serve
// /v1/chat/completions, so an image, video, audio or embedding model must
// never resolve into one (spec §5). `model.capabilities.chat` is populated by
// migration 0012; CapabilitySatisfied eliminates a model only on an explicit
// `false`, which is why the claim has to exist on every row.
var chatOnly = map[string]bool{"chat": true}

// Global virtual model names (PRD §36, spec §5). The `model_alias` rows exist
// so the catalogue can describe them; the router resolves their target sets
// from the active strategy.
//
// Two different things live in this map, and conflating them is what made
// `fudrouter/auto` useless as a tier:
//
//   - `strategy` is HOW the router picks inside the target set. Every tier now
//     declares one (all seven `Strategy*` values it names are implemented in
//     routing/select.go — no new strategies are needed for the tiers).
//   - `caps` is the capability the name itself implies, so a tier can never
//     advertise a model the candidate path would discard.
//
// The target set is NOT here: it comes from the alias's `model_alias_target`
// rows when they exist (see resolveVirtual), so an operator can change WHICH
// models a tier may use without a deploy. An empty allowlist keeps the old
// behaviour — the full active fan-out — which is what every other virtual still
// relies on.
//
// The four tier names below (auto/smart/medium/worker) are the customer-facing
// tier ladder: `auto` is the widest live set with a fair random draw, the other
// three are the same ladder narrowed by an explicit allowlist and ranked by one
// measured signal each.
var virtualModels = map[string]struct {
	strategy string
	caps     map[string]bool
}{
	// Tier ladder (PRD §36). `auto` is `random` on purpose: its target set is
	// the LIVE set (see liveModelIDs), and "spread the load across everything
	// that is answering right now" is exactly what a shuffle expresses. The
	// other three rank the same set by ONE signal so their names mean
	// something measurable.
	"fudrouter/auto":   {strategy: "random", caps: chatOnly},
	"fudrouter/smart":  {strategy: "highest_reliability", caps: chatOnly},
	"fudrouter/medium": {strategy: "lowest_latency", caps: chatOnly},
	"fudrouter/worker": {strategy: "lowest_cost", caps: chatOnly},

	// The pre-existing names keep their hints. `fast` and `medium` share a
	// strategy but not an allowlist, which is the whole point of the split:
	// `fast` is the whole catalogue ranked by latency, `medium` is a curated
	// six ranked by latency.
	"fudrouter/fast":      {strategy: "lowest_latency", caps: chatOnly},
	"fudrouter/cheap":     {strategy: "lowest_cost", caps: chatOnly},
	"fudrouter/balanced":  {strategy: "balanced", caps: chatOnly},
	"fudrouter/reliable":  {strategy: "highest_reliability", caps: chatOnly},
	"fudrouter/reasoning": {caps: map[string]bool{"chat": true, "reasoning": true}},
	"fudrouter/coding":    {caps: chatOnly},
}

// ResolveModel maps a request's `model` string onto a model set.
//
// Alias resolution order (spec §5): account combo → account/global alias →
// global virtual → canonical identity/literal slug. First match wins. The project
// and workspace levels this used to walk were collapsed into the account by 0019.
func (s *Store) ResolveModel(ctx context.Context, k *APIKeyRow, name string) (*ModelResolution, error) {
	name = strings.TrimSpace(name)
	res := &ModelResolution{Requested: name}

	// 0–2: combo (account) → alias (account → global) → literal canonical
	// slug — all in ONE round trip.
	//
	// Two things drove this shape. The alias branch was originally two queries
	// (pick the winner, then read its targets) where the second existed only to
	// carry an id the first had just produced. The literal branch then added
	// another round trip AFTER the alias query came back empty, on the path a
	// canonical slug always takes: measured at 2 queries for one literal slug.
	//
	// UNION ALL rather than a join: the branches read different tables and a
	// left join would have to fan both out. The CTE below pins its own winner
	// with `limit 1` on the SAME scope ordering the alias branch always used, so
	// first-match-wins is unchanged; `b` numbers the branch grids and `pos` the
	// alias targets so the result can be reassembled in order.
	//
	// Combo rides the same statement as branch -1 (spec §5 precedence: an
	// account combo beats an alias and beats a literal slug — a customer who
	// names a combo expects THEIR sequence). A separate resolveCombo probe
	// before this statement cost every canonical-slug request one extra round
	// trip, which is exactly the regression admission_count_test.go pins. The
	// `not exists (combo …)` guards on the alias and literal arms keep
	// first-match-wins inside SQL: without them a name that is both combo and
	// alias would merge the two grids into one ModelIDs list, because the scan
	// loop appends every non-literal row it sees. `$2 <> ''` mirrors the
	// k.UserID != "" gate the separate probe had — legacy S0 keys carry a NULL
	// user_id (apikey.go scans through *string).
	rows, err := s.pool.Query(ctx, `
		with picked as (
			select a.id,
			       case when a.account_id is not null then 'account'
			            else 'global' end as kind
			from model_alias a
			where a.enabled and a.name = $1
			  and (a.account_id = $2 or a.account_id is null)
			order by (a.account_id is not null) desc
			limit 1
		)
		select b, kind, model_id, slug from (
			select -1 as b, 'combo' as kind, cm.model_id, m.slug, cm.position as pos
			from combo c
			join combo_model cm on cm.combo_id = c.id
			join model m on m.id = cm.model_id
			where c.account_id = $2 and c.name = $1 and c.enabled
			  and m.status = 'active'
			  and $2 <> ''
			union all
			select 0 as b, p.kind, coalesce(t.model_id, '') as model_id,
			       coalesce(m.slug, '') as slug, coalesce(t.position, 0) as pos
			from picked p
			left join model_alias_target t on t.alias_id = p.id
			left join model m on m.id = t.model_id
			where not exists (
				select 1 from combo c2
				join combo_model cm2 on cm2.combo_id = c2.id
				join model m2 on m2.id = cm2.model_id
				where c2.account_id = $2 and c2.name = $1 and c2.enabled
				  and m2.status = 'active' and $2 <> ''
			)
			union all
			-- Only reached when no combo and no alias matched: the exists()
			-- guards on the SAME predicates the earlier arms used, so a name
			-- that is also a model.slug still resolves as the combo or alias
			-- (spec §5 precedence is unchanged).
			-- A live old spelling must use the identity too: 0026's missing-row
			-- fallback left duplicate provider sets isolated (152/159 rows at depth 1).
			-- The source row stays put for catalogue compatibility and billing.
			select 1 as b, 'model' as kind, coalesce(canonical.id, m2.id) as model_id,
			       coalesce(canonical.slug, m2.slug) as slug, 0 as pos
			from model m2
			left join model_slug_alias identity on identity.alias = m2.slug
			left join model canonical on canonical.id = identity.canonical_model_id
			  and canonical.status = 'active'
			where m2.slug = $1 and m2.status = 'active'
			  and not exists (
				select 1 from model_alias a2
				where a2.enabled and a2.name = $1
				  and (a2.account_id = $2 or a2.account_id is null)
			  )
			  and not exists (
				select 1 from combo c3
				join combo_model cm3 on cm3.combo_id = c3.id
				join model m3 on m3.id = cm3.model_id
				where c3.account_id = $2 and c3.name = $1 and c3.enabled
				  and m3.status = 'active' and $2 <> ''
			  )
			union all
			-- An old name also survives if its row is later retired or removed.
			-- Keep the same combo/account guards as the live arm; the missing
			-- live-row guard prevents two resolutions for one input spelling.
			select 2 as b, 'model' as kind, m3b.id as model_id, m3b.slug as slug, 0 as pos
			from model_slug_alias sa
			join model m3b on m3b.id = sa.canonical_model_id
			where sa.alias = $1 and m3b.status = 'active'
			  and not exists (select 1 from model ms where ms.slug = $1 and ms.status = 'active')
			  and not exists (select 1 from model m4 where m4.id = sa.canonical_model_id and m4.slug = $1)
			  and not exists (
				select 1 from model_alias a4
				where a4.enabled and a4.name = $1
				  and (a4.account_id = $2 or a4.account_id is null)
			  )
			  and not exists (
				select 1 from combo c4
				join combo_model cm4 on cm4.combo_id = c4.id
				join model m5 on m5.id = cm4.model_id
				where c4.account_id = $2 and c4.name = $1 and c4.enabled
				  and m5.status = 'active' and $2 <> ''
			  )
		) x
		order by b, pos`, name, k.UserID)
	if err != nil {
		return nil, err
	}
	var (
		kind    string
		found   bool
		isCombo bool
	)
	for rows.Next() {
		var branch int
		var mv, sv string
		if err := rows.Scan(&branch, &kind, &mv, &sv); err != nil {
			rows.Close()
			return nil, err
		}
		found = true
		if branch == 1 || branch == 2 {
			// Identity remapping is still one model, not an ordered target alias.
			res.Kind = "model"
			res.ModelIDs = []string{mv}
			res.ModelSlugs = []string{sv}
			continue
		}
		if branch == -1 {
			// The combo branch is authoritative like the literal: its rows
			// are the whole answer (the SQL guards keep alias/literal arms
			// empty when a combo matched).
			isCombo = true
		}
		if mv != "" {
			res.ModelIDs = append(res.ModelIDs, mv)
			res.ModelSlugs = append(res.ModelSlugs, sv)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if res.Kind == "model" {
		return res, nil
	}
	if isCombo {
		res.Kind = "combo"
		return res, nil
	}

	// A global `fudrouter/*` name is a VIRTUAL even when it carries
	// `model_alias_target` rows. That is the allowlist tier: the rows say
	// WHO may be chosen, the virtual's `strategy` says how the router picks
	// among them — they are not a fixed ordered pick the way an account
	// alias's targets are.
	//
	// Why this has to be decided BEFORE the generic alias return: the alias
	// branch above hands back `Kind="alias"` with the raw target ids, which
	// (a) skips canonicalisation, so a target that is a non-canonical
	// duplicate row isolates its own providers from the rest of the family's
	// (the depth defect 0026 exists to prevent), and (b) makes lifecycle
	// copy the target order onto `Plan.ModelPref`, turning an allowlist into
	// a hard preference ranking. An ACCOUNT alias that happens to be named
	// `fudrouter/*` is still the customer's own override and keeps the plain
	// alias shape — `kind == "account"` is the tell.
	if v, ok := virtualModels[name]; ok && kind != "account" {
		return s.resolveVirtual(ctx, name, v.strategy, v.caps, name == autoVirtual, res.ModelIDs)
	}

	if found {
		if len(res.ModelIDs) > 0 {
			res.Kind = "alias"
			return res, nil
		}
		// A global row with no targets is a `[NAME]/*` virtual descriptor:
		// the row exists so the catalogue can describe the name, and its
		// candidate set is strategy-resolved below rather than pinned. Only a
		// non-virtual empty alias is unroutable — returning early here made
		// every `[NAME]/*` name a 404.
		if kind != "global" {
			return nil, ErrNotFound // an alias with no targets is not routable
		}
		if _, ok := virtualModels[name]; !ok {
			return nil, ErrNotFound
		}
		// fall through to the virtual branch (3)
	}

	// 3: global virtual. Target set is the allowlist when the alias declares
	// one, otherwise every model the request path can actually attempt; the
	// strategy picks among them (spec §5: "resolved by the router from the
	// active strategy"). The set is filtered by the virtual's OWN capability
	// requirement, so `fudrouter/auto` cannot advertise a model CandidatesBatch
	// will discard (see activeModelIDs).
	if v, ok := virtualModels[name]; ok {
		// `found == false` here: the name has no alias row at all, so there is
		// no allowlist to read (res.ModelIDs is empty).
		return s.resolveVirtual(ctx, name, v.strategy, v.caps, name == autoVirtual, res.ModelIDs)
	}

	// 4: literal canonical slug.
	m, err := s.modelBySlug(ctx, name)
	if errors.Is(err, ErrNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	res.Kind = "model"
	res.ModelIDs = []string{m.id}
	res.ModelSlugs = []string{m.slug}
	return res, nil
}

type modelRow struct {
	id   string
	slug string
}

func (s *Store) modelBySlug(ctx context.Context, slug string) (*modelRow, error) {
	var m modelRow
	err := s.pool.QueryRow(ctx,
		`select id, slug from model where slug = $1 and status = 'active'`, slug,
	).Scan(&m.id, &m.slug)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &m, err
}

// SetChatCapable flips capabilities->'chat' on a model row after a probe
// proves the chat endpoint cannot serve it. The probe is the authority here:
// the catalogue gate is capabilities AND the request path is capabilities,
// so a row that fails the probe has a wrong claim and the correction is a
// one-shot write, not a recurring maintenance task. Idempotent: re-running
// the sweep rewrites the same value.
func (s *Store) SetChatCapable(ctx context.Context, slug string, chat bool) error {
	_, err := s.pool.Exec(ctx,
		`update model set capabilities = jsonb_set(
			coalesce(capabilities, '{}'::jsonb), '{chat}', $1::jsonb
		) where slug = $2`, chat, slug,
	)
	return err
}

// activeModelIDs is the target set a `[NAME]/*` virtual resolves to: every
// active model with at least one mapping the request path could actually
// ATTEMPT.
//
// Why the target set is the candidate predicate rather than `status='active'`:
// the strategy scores this set BEFORE CandidatesBatch filters it, so a model
// the batch will discard is not merely wasted work — it is a DEAD END the
// virtual advertises to its own admission loop, and the caller sees a model
// with zero candidates. MEASURED on the deployed catalogue (2026-11-02, 570
// rows, 271 active): 38 active models carry an explicit
// `capabilities->'chat' = false` (image, video, audio and embedding rows), and
// `fudrouter/auto` — whose only requirement IS chat — listed every one of them.
// The previous predicate returned 200 rows for `fudrouter/auto` while only 162
// of them could ever come back with a candidate: 38 dead ends, exactly the
// chat=false set. `TestVirtualFanOutStillCoversEveryModel` measured the same
// gap on its fixture as "only 203 of 241 resolved models returned candidates".
//
// The rule is the SAME rule the candidate queries apply, in the same statement:
// CapabilitySatisfied's explicit-`false` elimination (missing key passes — an
// unenriched row must never black-hole a request) and the
// provider_model → connection → credential chain, including the legacy
// `provider.credentials_enc` blob a connection without credential rows still
// dials through. Evaluating it in SQL rather than filtering the result in Go is
// deliberate: it keeps the fan-out at ONE query per virtual
// (virtual_fanout_test.go pins the batch to 1) while removing the dead ends.
//
// Capabilities are compared against the EFFECTIVE value — the mapping's
// capabilities_override merged over the canonical row, `||` with the right
// operand winning, which is exactly what Candidates assembles in Go. A mapping
// override of `false` vetoes a canonical `true`, so the override has to be part
// of this predicate or the target set drifts from the candidate set again.
//
// DISTINCT is over the routing identity, not the stored spelling. Otherwise the
// same model remains several virtual targets and its providers stay partitioned.
// Capability checks still use each mapping's original model row, like the batch:
// an alias must not erase a provider's explicit capability veto.
func (s *Store) activeModelIDs(ctx context.Context, requiredCaps map[string]bool) ([]string, []string, error) {
	return s.modelSetIDs(ctx, requiredCaps, false)
}

// liveSetCTE opens the target-set query as two CTEs: `live` (models with a 2xx
// inside the window) and `active` (the full fan-out, whose body the caller
// supplies). Kept beside the query it feeds rather than in virtual.go so the two
// halves of "which models may a virtual choose" are readable together.
//
// The join is attempt → provider_model → model, then the SAME identity mapping
// the outer query uses, so a 2xx recorded against a non-canonical duplicate still
// counts as a success for the canonical row it maps to. Without that the live set
// and the candidate set would disagree about identity, which is the depth-1
// defect again in a new place.
//
// The window is $2 rather than a literal so a test can set it to zero and
// exercise the empty-live-set recovery path deterministically, instead of hoping
// no other test in the suite left a recent 2xx behind.
const liveSetCTE = `
		with live as (
		    select distinct coalesce(canonical.id, m.id) as model_id
		    from request_attempt a
		    join provider_model pm on pm.id = a.provider_model_id
		    join model m on m.id = pm.model_id
		    left join model_slug_alias identity on identity.alias = m.slug
		    left join model canonical on canonical.id = identity.canonical_model_id
		      and canonical.status = 'active'
		    where a.started_at > now() - make_interval(hours => $2::int)
		      and a.http_status between 200 and 299
		      and m.status = 'active'
		),
		active as (`

// liveSetTail closes `active` and projects the answer: the live set when it has
// members, the whole fan-out when it does not.
//
// The fallback is INSIDE this statement on purpose. Doing it in Go would mean a
// second round trip on exactly the path (a cold or freshly-wiped database) where
// the router is already at its slowest, and would make the two branches two
// queries to keep in agreement. `fell_back` is projected so the caller can log
// the recovery path without asking the database again.
const liveSetTail = `
		)
		select id, slug, (not exists (select 1 from live)) as fell_back
		from active
		where not exists (select 1 from live)
		   or id in (select model_id from live)
		order by slug`

// modelSetIDs is the ONE query behind every virtual target set: the full active
// fan-out, or (liveOnly) that same set narrowed to models with a recent 2xx.
//
// Sharing the body is deliberate — the servability, capability-override and
// credential predicates are load-bearing and had to agree exactly, so a second
// copy would be a second thing to keep in sync with CandidatesBatch.
func (s *Store) modelSetIDs(ctx context.Context, requiredCaps map[string]bool, liveOnly bool) ([]string, []string, error) {
	// The required set rides as one jsonb parameter. `{}` (not `null`) when
	// nothing is required: jsonb_each is strict, but relying on a strict
	// function returning no rows is the kind of accident that reads as intent
	// later. Keys are never interpolated into the SQL text.
	caps := "{}"
	if len(requiredCaps) > 0 {
		if b, err := json.Marshal(requiredCaps); err == nil {
			caps = string(b)
		}
	}

	// The live set is a 24h aggregate over the attempt ledger; it is cached
	// in-process for liveSetTTL (virtual.go). Every other caller of this
	// function is a catalogue fan-out that must stay exact, so only the
	// liveOnly path consults the cache.
	liveKey := ""
	if liveOnly {
		liveKey = capsKey(requiredCaps)
		if ids, slugs, ok := s.live.get(liveKey); ok {
			return ids, slugs, nil
		}
	}

	head, tail, orderBy := "", "", "\n		order by slug"
	args := []any{caps}
	if liveOnly {
		// The inner body becomes the `active` CTE: no ORDER BY inside a CTE,
		// and the tail projects the intersection (or everything) with one.
		head, tail, orderBy = liveSetCTE, liveSetTail, ""
		args = append(args, liveWindowHoursForQuery)
	}
	rows, err := s.pool.Query(ctx, head+`
		select distinct coalesce(canonical.id, m.id) as id,
		       coalesce(canonical.slug, m.slug) as slug
		from model m
		left join model_slug_alias identity on identity.alias = m.slug
		left join model canonical on canonical.id = identity.canonical_model_id
		  and canonical.status = 'active'
		where m.status = 'active'
		  and exists (
		      select 1 from provider_model pm
		      join provider p on p.id = pm.provider_id
		      left join connection c on c.id = pm.connection_id
		      where pm.model_id = m.id
		        and pm.enabled
		        and pm.status not in ('disabled', 'unavailable')
		        and (c.id is null or c.enabled)
		        and (c.id is null or c.health_status is distinct from 'unhealthy')
		        and not exists (
		            select 1 from jsonb_each($1::jsonb) as r(k, v)
		            where v = 'true'::jsonb
		              and (coalesce(m.capabilities, '{}'::jsonb) || coalesce(pm.capabilities_override, '{}'::jsonb)) -> r.k = 'false'::jsonb
		        )
		        and (
		            coalesce(p.credentials_enc, '') <> ''
		            or (c.id is not null and exists (
		                select 1 from credential cr
		                where cr.connection_id = c.id
		                  and cr.status not in ('disabled', 'invalid')
		                  and (cr.cooldown_until is null or cr.cooldown_until <= now())
		            ))
		        )
		        and `+s.providerServableSQL()+`
		          )`+orderBy+tail, args...)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	var ids, slugs []string
	fellBack := false
	for rows.Next() {
		var id, slug string
		if liveOnly {
			if err := rows.Scan(&id, &slug, &fellBack); err != nil {
				return nil, nil, err
			}
		} else if err := rows.Scan(&id, &slug); err != nil {
			return nil, nil, err
		}
		ids = append(ids, id)
		slugs = append(slugs, slug)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	if liveOnly {
		if fellBack {
			// The live set was empty, so the SQL already widened to the full
			// fan-out. Say so: a tier silently serving everything is an outage
			// symptom, not a healthy state.
			logf("fudrouter: virtual %s: live set is EMPTY (no 2xx in %dh); served the full active fan-out — recovery path, not a healthy state", autoVirtual, liveWindowHours)
		} else if len(ids) > 0 {
			s.live.put(liveKey, ids, slugs)
		}
	}
	return ids, slugs, nil
}

// Candidate is one routable target: a canonical model served through one
// provider_model mapping on one connection, with the credential material the
// attempt will need.
//
// The query follows spec §5 exactly: canonical model → provider_model (enabled,
// status) → connection (enabled) → credential (usable). Capability filtering
// eliminates only an explicit `false` — a missing/unknown key is not a claim,
// so an unenriched catalog can never black-hole a request.
type Candidate struct {
	// The mapping's original model row owns its capabilities and price history.
	// CandidatesBatch keys the union by the requested identity separately; using
	// that identity here would silently re-price an aliased provider.
	ModelID          string
	ModelSlug        string
	ProviderModelID  string // provider_model.id (pmdl_...) — the entity id
	UpstreamModel    string // provider_model.provider_model_id: the name sent upstream
	ProviderID       string
	ProviderName     string
	ProviderSlug     string
	ProviderTier     string
	Region           string
	HealthStatus     string // connection.health_status (spec §4 vocabulary)
	Priority         int    // provider.priority, lower wins ties
	ConnectionID     string
	BaseURL          string
	AuthType         string
	TimeoutMs        int
	ConfigJSON       []byte // connection.config: {protocol, default_headers, auth_kind}
	EgressMode       string
	StickyTTLSeconds int
	ProxyURL         string
	Capabilities     map[string]any
	Context          int
	// Credentials are the usable secrets for this connection, best first.
	Credentials []Credential
	// Price is the effective price at query time (spec §6 resolution: specific
	// rule beats model-wide), needed by the cost-aware strategies. The REQUEST
	// re-resolves and snapshots its own price (ResolvePricing) — this copy is a
	// ranking signal only.
	Price *Pricing
	// LegacyBlob is the unsplit `provider.credentials_enc` used when the
	// connection has no credential rows yet (spec §14 promise 1–2 keep S0
	// providers working through the migration).
	LegacyBlob string
}

// Credential is one usable secret for a connection (spec §4).
//
// The json tags are load-bearing: Candidates builds these through
// `json_agg(json_build_object(...))` in the same query that selects the
// candidate rows (one round trip instead of a second batched credential
// query), so these names are part of the SQL contract. Renaming a field
// without the tag silently yields a zero-valued credential.
type Credential struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	SecretEnc string `json:"secret_enc"`
	Status    string `json:"status"`
	Weight    int    `json:"weight"`
	Priority  int    `json:"priority"`
}

// CandidatesBatch is Candidates for MANY models in ONE query, keyed by model id.
//
// Why it exists: a `[NAME]/*` virtual request — the name the docs and the
// playground advertise — resolves its candidate set from every active model
// (store.activeModelIDs). The admission loop then called Candidates once per
// model, so the fan-out was one round trip per model IN THE CATALOGUE: measured
// at 251 queries for a single request against a 251-model catalogue, with each
// query carrying the credential json_agg. That is the difference between a
// router that scales and one that does not.
//
// The result is byte-for-byte what N calls to Candidates would produce:
//
//   - the same filters (the model-id predicate becomes `= any($1)`),
//   - the same per-model order (`p.priority asc, pm.id` — Candidates' own outer
//     order, now a window function so it restarts per model),
//   - the same credential order (ordered INSIDE json_agg).
//
// A model with no routable target is ABSENT from the map rather than present as
// an empty slice, which mirrors Candidates returning ErrNotFound: the caller
// skips the same models either way.
//
// A canonical identity owns the UNION of its live source rows. The map key stays
// the requested id (including old ids held by account aliases/combos), but every
// Candidate retains its original model/mapping/upstream fields for billing and
// dispatch. This adds fan-out without re-keying any historical row.
func (s *Store) CandidatesBatch(ctx context.Context, modelIDs []string, requiredCaps map[string]bool) (map[string][]Candidate, error) {
	out := map[string][]Candidate{}
	if len(modelIDs) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `
		with requested as (
			select r.id as requested_model_id, coalesce(canonical.id, r.id) as canonical_model_id
			from model r
			left join model_slug_alias identity on identity.alias = r.slug
			left join model canonical on canonical.id = identity.canonical_model_id
			  and canonical.status = 'active'
			where r.id = any($1) and r.status = 'active'
		)
		select * from (
			select r.requested_model_id, m.id as model_id, m.slug, pm.id, pm.provider_model_id,
			       p.id, p.name, coalesce(p.slug, ''), p.tier, p.priority,
			       c.id, c.base_url, c.auth_type, c.timeout_ms, c.config::text,
			       coalesce(c.egress_mode, 'ipv6_rotate'), coalesce(c.sticky_ttl_seconds, 3600),
			       coalesce(c.proxy_url, ''),
			       coalesce(c.region, ''), coalesce(c.health_status, 'unknown'),
			       coalesce(pm.capabilities_override, '{}'::jsonb),
			       m.capabilities,
			       coalesce(pm.context_override, m.context, 0),
			       coalesce(p.credentials_enc, ''),
			       coalesce(creds.items, '[]'::json),
			       row_number() over (partition by r.requested_model_id order by p.priority asc, pm.id) as rn
			from model m
			left join model_slug_alias identity on identity.alias = m.slug
			left join model canonical on canonical.id = identity.canonical_model_id
			  and canonical.status = 'active'
			join requested r on r.canonical_model_id = coalesce(canonical.id, m.id)
			join provider_model pm on pm.model_id = m.id
			join provider p on p.id = pm.provider_id
			left join connection c on c.id = pm.connection_id
			left join lateral (
				select json_agg(json_build_object(
				           'id', cr.id, 'name', cr.name, 'secret_enc', cr.secret_enc,
				           'status', cr.status, 'weight', cr.weight, 'priority', cr.priority
				       ) order by cr.priority asc, cr.weight desc, cr.id) as items
				from credential cr
				where cr.connection_id = c.id
				  and cr.status not in ('disabled', 'invalid')
				  and (cr.cooldown_until is null or cr.cooldown_until <= now())
			) creds on true
			where m.status = 'active'
			  and pm.enabled
			  and pm.status not in ('disabled', 'unavailable')
			  and (c.id is null or c.enabled)
			  and (c.id is null or c.health_status is distinct from 'unhealthy')
			  and `+s.providerServableSQL()+`
		) ranked
		-- Ordered across the whole set so the map is built in one pass and every
		-- model's slice comes out in its own rank order.
		order by requested_model_id, rn`, modelIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var c Candidate
		var requestedID string
		var overrideJSON, capsJSON, credsJSON []byte
		var baseURL *string
		var authType *string
		var timeoutMs *int
		var connID *string
		var rn int
		if err := rows.Scan(&requestedID, &c.ModelID, &c.ModelSlug, &c.ProviderModelID, &c.UpstreamModel,
			&c.ProviderID, &c.ProviderName, &c.ProviderSlug, &c.ProviderTier, &c.Priority,
			&connID, &baseURL, &authType, &timeoutMs, &c.ConfigJSON,
			&c.EgressMode, &c.StickyTTLSeconds, &c.ProxyURL,
			&c.Region, &c.HealthStatus,
			&overrideJSON, &capsJSON, &c.Context, &c.LegacyBlob, &credsJSON, &rn,
		); err != nil {
			return nil, err
		}
		if connID != nil {
			c.ConnectionID = *connID
		}
		if baseURL != nil {
			c.BaseURL = *baseURL
		}
		if authType != nil {
			c.AuthType = *authType
		}
		if timeoutMs != nil {
			c.TimeoutMs = *timeoutMs
		}
		if err := json.Unmarshal(credsJSON, &c.Credentials); err != nil {
			return nil, err
		}
		// Effective capabilities = canonical, overridden per key by the mapping
		// (spec §5). Same rule as Candidates: an override key replaces the
		// canonical claim entirely, so `false` can veto even a canonical `true`.
		c.Capabilities = map[string]any{}
		_ = json.Unmarshal(capsJSON, &c.Capabilities)
		var override map[string]any
		_ = json.Unmarshal(overrideJSON, &override)
		for k, v := range override {
			c.Capabilities[k] = v
		}
		if !CapabilitySatisfied(c.Capabilities, requiredCaps) {
			continue
		}
		// A connection with no usable credential row and no legacy blob cannot be
		// attempted at all — drop it rather than fail later on every request.
		if len(c.Credentials) == 0 && c.LegacyBlob == "" {
			continue
		}
		out[requestedID] = append(out[requestedID], c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// Candidates returns the routable targets for one canonical model, in a stable
// order (provider priority, then credential priority).
//
// One round trip. This was two — the candidate rows, then a batched credential
// query for every distinct connection — and both sit before the first upstream
// byte. The credentials ride along as a json_agg, ordered INSIDE the aggregate
// (`order by cr.priority asc, cr.weight desc, cr.id`) so the pool's pick order
// is unchanged; the outer `order by` is the candidate order, which is the
// attempt order and therefore load-bearing on its own.
//
// json_agg over a LEFT JOIN lateral, not a plain LEFT JOIN: a connection with
// several credentials would otherwise multiply the candidate row, and one with
// none would disappear instead of staying reachable through its legacy blob.
func (s *Store) Candidates(ctx context.Context, modelID string, requiredCaps map[string]bool) ([]Candidate, error) {
	// Share the identity join and capability/credential scan with the batch;
	// separate implementations made it possible to fix only one admission path.
	byModel, err := s.CandidatesBatch(ctx, []string{modelID}, requiredCaps)
	if err != nil {
		return nil, err
	}
	out := byModel[modelID]
	if len(out) == 0 {
		return nil, ErrNotFound
	}
	return out, nil
}

// CapabilitySatisfied implements spec §5: a required capability eliminates a
// candidate only when the effective value is explicitly `false`. Missing or
// unknown keys pass — an unenriched catalog must never black-hole a request.
// (The router's routing tests pin this rule; both planes must agree on it.)
func CapabilitySatisfied(effective map[string]any, required map[string]bool) bool {
	for cap, need := range required {
		if !need {
			continue // a "must NOT have" claim is not part of the vocabulary
		}
		if v, ok := effective[cap]; ok {
			if b, isBool := v.(bool); isBool && !b {
				return false
			}
		}
	}
	return true
}

// HasSupply reports whether one provider_model mapping is tagged as serving a
// given economic bucket in `provider_model_supply` (migration 0033, decisions
// K3/K10). Single-purpose by design: it is the one-read guard consulted by
// catalogue and supply verification, NOT a hot-path lookup. Resolution and
// billing keep serving raw slugs (spec §5, displayFamilyCTE above), so this
// predicate must never be folded into Candidates/CandidatesBatch — doing so
// would partition routing by bucket, the exact drift the display-family fold
// exists to prevent.
//
// Absence returns `false, nil`, not an error: a mapping that predates the 0033
// backfill has no supply claim, which is a legal state, not a query failure. A
// mapping may serve SEVERAL buckets through the join table without duplicating
// its provider_model row — the whole reason the guard is a join table rather
// than a column on provider_model (K3).
func (s *Store) HasSupply(ctx context.Context, providerModelID string, bucket Bucket) (bool, error) {
	var one int
	err := s.pool.QueryRow(ctx, `
		select 1
		from provider_model_supply
		where provider_model_id = $1 and bucket = $2
		limit 1`, providerModelID, string(bucket),
	).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}
