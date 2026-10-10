package store

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
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

// ActiveModels lists the published catalogue.
//
// The gate is the same rule the control plane's publish gate implements
// (`shared/control-lib/publish.ts`, endpoint-surface spec §2.1): canonical model
// active AND provider servable. Two views of one catalogue must not drift.
func (s *Store) ActiveModels(ctx context.Context) ([]ModelInfo, error) {
	rows, err := s.pool.Query(ctx, `
		select m.slug, m.name, coalesce(m.context, 0),
		       coalesce(pr.input_price::text, m.input_price::text),
		       coalesce(pr.output_price::text, m.output_price::text),
		       coalesce(pr.currency, m.currency, 'USD')
		from model m
		join provider_model pm on pm.model_id = m.id and pm.enabled
		join provider p on p.id = pm.provider_id
		left join lateral (
			select input_price, output_price, currency
			from pricing_rule r
			where r.model_id = m.id
			  and r.provider_model_id is null
			  and r.effective_from <= now()
			  and (r.effective_until is null or r.effective_until > now())
			order by r.version desc
			limit 1
		) pr on true
		where m.status = 'active' and `+s.providerServableSQL()+`
		group by m.slug, m.name, m.context, m.input_price, m.output_price, m.currency,
		         pr.input_price, pr.output_price, pr.currency
		order by m.slug`)
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
func (s *Store) PublishedModel(ctx context.Context, slug string) (*ModelInfo, error) {
	m := &ModelInfo{OwnedBy: "fudrouter"}
	var priceIn, priceOut, curCode *string
	err := s.pool.QueryRow(ctx, `
		select m.slug, m.name, coalesce(m.context, 0),
		       coalesce(pr.input_price::text, m.input_price::text),
		       coalesce(pr.output_price::text, m.output_price::text),
		       coalesce(pr.currency, m.currency, 'USD')
		from model m
		join provider_model pm on pm.model_id = m.id and pm.enabled
		join provider p on p.id = pm.provider_id
		left join lateral (
			select input_price, output_price, currency
			from pricing_rule r
			where r.model_id = m.id
			  and r.provider_model_id is null
			  and r.effective_from <= now()
			  and (r.effective_until is null or r.effective_until > now())
			order by r.version desc
			limit 1
		) pr on true
		where m.slug = $1 and m.status = 'active' and `+s.providerServableSQL()+`
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
var virtualModels = map[string]struct {
	strategy string
	caps     map[string]bool
}{
	"fudrouter/auto":      {caps: chatOnly},
	"fudrouter/fast":      {strategy: "lowest_latency", caps: chatOnly},
	"fudrouter/cheap":     {strategy: "lowest_cost", caps: chatOnly},
	"fudrouter/balanced":  {strategy: "balanced", caps: chatOnly},
	"fudrouter/reliable":  {strategy: "highest_reliability", caps: chatOnly},
	"fudrouter/reasoning": {caps: map[string]bool{"chat": true, "reasoning": true}},
	"fudrouter/coding":    {caps: chatOnly},
}

// ResolveModel maps a request's `model` string onto a model set.
//
// Alias resolution order (spec §5): project alias → workspace alias → global
// virtual → literal `model.slug`. First match wins.
func (s *Store) ResolveModel(ctx context.Context, k *APIKeyRow, name string) (*ModelResolution, error) {
	name = strings.TrimSpace(name)
	res := &ModelResolution{Requested: name}

	// 1–2: project, then workspace alias. Targets are ordered by `position`.
	var aliasID string
	var kind string
	err := s.pool.QueryRow(ctx, `
		select a.id,
		       case when a.project_id is not null then 'project'
		            when a.workspace_id is not null then 'workspace'
		            else 'global' end as kind
		from model_alias a
		where a.enabled and a.name = $1
		  and (a.project_id = $2 or (a.project_id is null and a.workspace_id = $3)
		       or (a.project_id is null and a.workspace_id is null))
		order by (a.project_id is not null) desc, (a.workspace_id is not null) desc
		limit 1`, name, k.ProjectID, k.WorkspaceID,
	).Scan(&aliasID, &kind)
	switch {
	case err == nil:
		rows, err := s.pool.Query(ctx, `
			select t.model_id, m.slug
			from model_alias_target t join model m on m.id = t.model_id
			where t.alias_id = $1
			order by t.position`, aliasID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var id, slug string
			if err := rows.Scan(&id, &slug); err != nil {
				return nil, err
			}
			res.ModelIDs = append(res.ModelIDs, id)
			res.ModelSlugs = append(res.ModelSlugs, slug)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if len(res.ModelIDs) > 0 {
			res.Kind = "alias"
			return res, nil
		}
		// A global row with no targets is a `fudrouter/*` virtual descriptor:
		// the row exists so the catalogue can describe the name, and its
		// candidate set is strategy-resolved below rather than pinned. Only a
		// non-virtual empty alias is unroutable — returning early here made
		// every `fudrouter/*` name a 404.
		if kind != "global" {
			return nil, ErrNotFound // an alias with no targets is not routable
		}
		if _, ok := virtualModels[name]; !ok {
			return nil, ErrNotFound
		}
		// fall through to the virtual branch (3)
	case errors.Is(err, pgx.ErrNoRows):
		// fall through
	default:
		return nil, err
	}

	// 3: global virtual. Target set is every active model; the strategy picks
	// among them (spec §5: "resolved by the router from the active strategy").
	if v, ok := virtualModels[name]; ok {
		ids, slugs, err := s.activeModelIDs(ctx)
		if err != nil {
			return nil, err
		}
		res.Kind = "virtual"
		res.ModelIDs, res.ModelSlugs = ids, slugs
		res.StrategyHint = v.strategy
		res.RequiredCapabilities = v.caps
		return res, nil
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

func (s *Store) activeModelIDs(ctx context.Context) ([]string, []string, error) {
	rows, err := s.pool.Query(ctx, `
		select m.id, m.slug from model m
		where m.status = 'active'
		  and exists (select 1 from provider_model pm
		              join provider p on p.id = pm.provider_id
		              where pm.model_id = m.id and pm.enabled and `+s.providerServableSQL()+`)
		order by m.slug`)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var ids, slugs []string
	for rows.Next() {
		var id, slug string
		if err := rows.Scan(&id, &slug); err != nil {
			return nil, nil, err
		}
		ids = append(ids, id)
		slugs = append(slugs, slug)
	}
	return ids, slugs, rows.Err()
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
	ModelID         string
	ModelSlug       string
	ProviderModelID string // provider_model.id (pmdl_…) — the entity id
	UpstreamModel   string // provider_model.provider_model_id: the name sent upstream
	ProviderID      string
	ProviderName    string
	ProviderSlug    string
	ProviderTier    string
	Region          string
	HealthStatus    string // connection.health_status (spec §4 vocabulary)
	Priority        int // provider.priority, lower wins ties
	ConnectionID    string
	BaseURL         string
	AuthType        string
	TimeoutMs       int
	ConfigJSON      []byte // connection.config: {protocol, default_headers, auth_kind}
	Capabilities    map[string]any
	Context         int
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
type Credential struct {
	ID       string
	Name     string
	SecretEnc string
	Status   string
	Weight   int
	Priority int
}

// Candidates returns the routable targets for one canonical model, in a stable
// order (provider priority, then credential priority).
func (s *Store) Candidates(ctx context.Context, modelID string, requiredCaps map[string]bool) ([]Candidate, error) {
	rows, err := s.pool.Query(ctx, `
		select m.id, m.slug, pm.id, pm.provider_model_id,
		       p.id, p.name, coalesce(p.slug, ''), p.tier, p.priority,
		       c.id, c.base_url, c.auth_type, c.timeout_ms, c.config::text,
		       coalesce(c.region, ''), coalesce(c.health_status, 'unknown'),
		       coalesce(pm.capabilities_override, '{}'::jsonb),
		       m.capabilities,
		       coalesce(pm.context_override, m.context, 0),
		       coalesce(p.credentials_enc, '')
		from model m
		join provider_model pm on pm.model_id = m.id
		join provider p on p.id = pm.provider_id
		left join connection c on c.id = pm.connection_id
		where m.id = $1
		  and m.status = 'active'
		  and pm.enabled
		  and pm.status not in ('disabled', 'unavailable')
		  and (c.id is null or c.enabled)
		  and (c.id is null or c.health_status is distinct from 'unhealthy')
		  and `+s.providerServableSQL()+`
		order by p.priority asc, pm.id`, modelID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Candidate
	for rows.Next() {
		var c Candidate
		var overrideJSON, capsJSON []byte
		var baseURL *string
		var authType *string
		var timeoutMs *int
		var connID *string
		if err := rows.Scan(&c.ModelID, &c.ModelSlug, &c.ProviderModelID, &c.UpstreamModel,
			&c.ProviderID, &c.ProviderName, &c.ProviderSlug, &c.ProviderTier, &c.Priority,
			&connID, &baseURL, &authType, &timeoutMs, &c.ConfigJSON,
			&c.Region, &c.HealthStatus,
			&overrideJSON, &capsJSON, &c.Context, &c.LegacyBlob,
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
		// Effective capabilities = canonical, overridden per key by the mapping
		// (spec §5). An override key replaces the canonical claim entirely, so
		// `false` can veto even a canonical `true`.
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
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// Release the candidate result before the batch credential query below:
	// holding it defers the connection back to the pool while a second query
	// runs, defeating part of the pool-efficiency goal.
	rows.Close()
	if len(out) == 0 {
		return nil, ErrNotFound
	}

	// Credential usability is a per-candidate filter (spec §5: "credential
	// (usable: not disabled/invalid, cooldown_until past/NULL)").
	// One batch query for every distinct connection instead of one round trip
	// per candidate.
	byConn, err := s.usableCredentialsBatch(ctx, connectionIDs(out))
	if err != nil {
		return nil, err
	}
	for i := range out {
		out[i].Credentials = byConn[out[i].ConnectionID]
	}
	// Per-candidate prices are filled by the caller through cachedPricing
	// (proxy): the request's own billing snapshot in buildRow still resolves
	// and freezes its price at request time.
	// A connection with no usable credential row and no legacy blob cannot be
	// attempted at all — drop it rather than fail later on every request.
	filtered := out[:0]
	for _, c := range out {
		if len(c.Credentials) == 0 && c.LegacyBlob == "" {
			continue
		}
		filtered = append(filtered, c)
	}
	return filtered, nil
}

// connectionIDs collects the distinct non-empty connection ids of a
// candidate set, sorted for a stable query plan.
func connectionIDs(cands []Candidate) []string {
	seen := map[string]bool{}
	var ids []string
	for _, c := range cands {
		if c.ConnectionID == "" || seen[c.ConnectionID] {
			continue
		}
		seen[c.ConnectionID] = true
		ids = append(ids, c.ConnectionID)
	}
	sort.Strings(ids)
	return ids
}

// usableCredentialsBatch is the batched form of usableCredentials: one query
// for every distinct connection, grouped by connection id in the same order
// (priority asc, weight desc, id). An empty input returns an empty map with
// no query.
func (s *Store) usableCredentialsBatch(ctx context.Context, ids []string) (map[string][]Credential, error) {
	out := map[string][]Credential{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `
		select id, name, secret_enc, status, weight, priority, connection_id
		from credential
		where connection_id = any($1)
		  and status not in ('disabled', 'invalid')
		  and (cooldown_until is null or cooldown_until <= now())
		order by priority asc, weight desc, id`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var c Credential
		var connID string
		if err := rows.Scan(&c.ID, &c.Name, &c.SecretEnc, &c.Status, &c.Weight, &c.Priority, &connID); err != nil {
			return nil, err
		}
		out[connID] = append(out[connID], c)
	}
	return out, rows.Err()
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
