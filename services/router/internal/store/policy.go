package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/anvxxr-arch/fudrouter/services/router/internal/ids"
	"github.com/jackc/pgx/v5"
)

// RoutingPolicy is the routing configuration in force for a request (spec §9).
type RoutingPolicy struct {
	ID                 string
	WorkspaceID        string
	ProjectID          string
	EnvironmentID      string
	Name               string
	Strategy           string // balanced|lowest_cost|lowest_latency|highest_reliability|provider_priority|weighted|round_robin|random|smart
	Enabled            bool
	MaxAttempts        int
	RequestTimeoutMs   int
	FallbackEnabled    bool
	ProviderPreferences map[string]any
	ModelPreferences    map[string]any
	Constraints         map[string]any
	Weights             map[string]any
}

// DefaultRoutingPolicy is the PRD §139 default, used when neither the chain
// nor `system_setting['default_routing_policy']` names one.
func DefaultRoutingPolicy() *RoutingPolicy {
	return &RoutingPolicy{
		ID:               "rte_default",
		Name:             "Platform Default",
		Strategy:         "balanced",
		Enabled:          true,
		MaxAttempts:      2,
		RequestTimeoutMs: 30000,
		FallbackEnabled:  true,
		Weights:          map[string]any{"price": 0.25, "latency": 0.25, "reliability": 0.25, "capacity": 0.25},
		Constraints:      map[string]any{},
		ProviderPreferences: map[string]any{},
		ModelPreferences:    map[string]any{},
	}
}

// RoutingPolicyFor resolves the policy chain: environment → project →
// workspace → platform default (`system_setting['default_routing_policy']`,
// spec §9). The first level that names a policy wins; nothing else is merged.
func (s *Store) RoutingPolicyFor(ctx context.Context, k *APIKeyRow) (*RoutingPolicy, error) {
	// The most specific binding wins: environment.routing_policy_id, then a
	// policy row scoped to the project, then to the workspace.
	var policyID string
	err := s.pool.QueryRow(ctx, `
		select coalesce(
			(select e.routing_policy_id from environment e where e.id = $1 and e.routing_policy_id is not null),
			(select rp.id from routing_policy rp
			 where rp.enabled and rp.project_id = $2 and rp.environment_id is null
			 order by rp.id limit 1),
			(select rp.id from routing_policy rp
			 where rp.enabled and rp.workspace_id = $3 and rp.project_id is null and rp.environment_id is null
			 order by rp.id limit 1)
		)`, k.EnvironmentID, k.ProjectID, k.WorkspaceID,
	).Scan(&policyID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}

	if policyID == "" {
		// Platform default: system_setting['default_routing_policy'] = {"id":"rte_default"}.
		var raw []byte
		err := s.pool.QueryRow(ctx,
			`select value from system_setting where key = 'default_routing_policy'`).Scan(&raw)
		if err == nil {
			var setting struct {
				ID string `json:"id"`
			}
			if json.Unmarshal(raw, &setting) == nil {
				policyID = setting.ID
			}
		}
	}
	if policyID == "" {
		return DefaultRoutingPolicy(), nil
	}

	p := &RoutingPolicy{}
	var prefs, modelPrefs, constraints, weights []byte
	err = s.pool.QueryRow(ctx, `
		select id, coalesce(workspace_id,''), coalesce(project_id,''), coalesce(environment_id,''),
		       name, strategy, enabled, max_attempts, request_timeout_ms, fallback_enabled,
		       provider_preferences, model_preferences, constraints, weights
		from routing_policy where id = $1`, policyID,
	).Scan(&p.ID, &p.WorkspaceID, &p.ProjectID, &p.EnvironmentID,
		&p.Name, &p.Strategy, &p.Enabled, &p.MaxAttempts, &p.RequestTimeoutMs, &p.FallbackEnabled,
		&prefs, &modelPrefs, &constraints, &weights)
	if errors.Is(err, pgx.ErrNoRows) {
		return DefaultRoutingPolicy(), nil
	}
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(prefs, &p.ProviderPreferences)
	_ = json.Unmarshal(modelPrefs, &p.ModelPreferences)
	_ = json.Unmarshal(constraints, &p.Constraints)
	_ = json.Unmarshal(weights, &p.Weights)
	if !p.Enabled {
		return DefaultRoutingPolicy(), nil
	}
	if p.MaxAttempts < 1 {
		p.MaxAttempts = 1
	}
	if p.RequestTimeoutMs <= 0 {
		p.RequestTimeoutMs = 30000
	}
	return p, nil
}

// CircuitBreakerConfig is the breaker's CONFIGURATION (spec §9): runtime state
// lives in Valkey (`circuit:{target}:{id}`), config lives here.
type CircuitBreakerConfig struct {
	ID               string
	Target           string // provider|connection|model
	TargetID         string
	FailureThreshold int
	WindowSeconds    int
	OpenMs           int
	HalfOpenProbes   int
	Enabled          bool
}

// CircuitBreakers loads breaker configs for the given targets. Targets are
// addressed as (target kind, id) pairs; a target with no row uses the caller's
// defaults.
func (s *Store) CircuitBreakers(ctx context.Context) (map[string]CircuitBreakerConfig, error) {
	rows, err := s.pool.Query(ctx, `
		select id, target, target_id, failure_threshold, window_seconds,
		       open_ms, half_open_probes, enabled
		from circuit_breaker`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]CircuitBreakerConfig{}
	for rows.Next() {
		var c CircuitBreakerConfig
		if err := rows.Scan(&c.ID, &c.Target, &c.TargetID, &c.FailureThreshold,
			&c.WindowSeconds, &c.OpenMs, &c.HalfOpenProbes, &c.Enabled); err != nil {
			return nil, err
		}
		out[c.Target+":"+c.TargetID] = c
	}
	return out, rows.Err()
}

// GenericPassthrough reports whether the `/v1/*` catch-all may forward
// unimplemented endpoints at all.
//
// This is the escape hatch the endpoint-surface spec §8 left open ("should the
// catch-all return 404 for unimplemented /v1/* paths? … do not leave it
// implicit"). It is explicit now: honesty wins by default (spec §14 promise #5:
// a valid key sees 404), but an operator can restore "forward anything" by
// setting `system_setting['generic_passthrough'] = true`, which routes every
// unimplemented `/v1/*` path to the generic forwarder instead. The router
// reads the setting per call — it is a rare, deliberate toggle.
func (s *Store) GenericPassthrough(ctx context.Context) bool {
	var raw []byte
	err := s.pool.QueryRow(ctx,
		`select value from system_setting where key = 'generic_passthrough'`).Scan(&raw)
	if err != nil {
		return false // default: truthful 404 (spec §14 promise #5)
	}
	// The control plane stores this setting as {"enabled": bool} (apps/web
	// lib/server/settings.ts + admin settings action); a bare bool was also
	// written historically. Both spellings MUST open the hatch — parsing only
	// one made the admin toggle a no-op against this reader.
	var enabled bool
	if json.Unmarshal(raw, &enabled) == nil && enabled {
		return true
	}
	var obj struct {
		Enabled *bool `json:"enabled"`
	}
	if json.Unmarshal(raw, &obj) == nil && obj.Enabled != nil && *obj.Enabled {
		return true
	}
	return false
}

// InsertAlertEvent records an alert firing or resolving (spec §11). Budget and
// low-balance thresholds raise these; the control plane renders them.
func (s *Store) InsertAlertEvent(ctx context.Context, alertID, message, state string, value float64) error {
	id := ids.New("ale")
	if state == "resolved" {
		_, err := s.pool.Exec(ctx, `
			insert into alert_event (id, alert_id, triggered_at, value, message, state, resolved_at)
			values ($1, $2, now(), $3, $4, 'resolved', now())`, id, alertID, value, message)
		return err
	}
	_, err := s.pool.Exec(ctx, `
		insert into alert_event (id, alert_id, triggered_at, value, message, state)
		values ($1, $2, now(), $3, $4, 'firing')`, id, alertID, value, message)
	return err
}

// FindOrCreateAlert locates a workspace alert by its `condition->>'type'`, or
// creates one with the given condition (spec §11 `alert.condition` = {"type",
// "threshold", "window_seconds"} — low-balance alerts carry the billing
// thresholds so the control plane can render them; see the billing plane's
// agreement on `{"type":"low_balance", …}`).
func (s *Store) FindOrCreateAlert(ctx context.Context, workspaceID, name, alertType string, condition map[string]any) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `
		select id from alert
		where workspace_id is not distinct from $1
		  and condition->>'type' = $2
		order by created_at desc limit 1`, nullStr(workspaceID), alertType,
	).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	id = ids.New("alr")
	cond, err := json.Marshal(condition)
	if err != nil {
		return "", err
	}
	err = s.pool.QueryRow(ctx, `
		insert into alert (id, workspace_id, name, condition, channel, enabled)
		values ($1, $2, $3, $4, 'inapp', true)
		on conflict (id) do nothing
		returning id`, id, nullStr(workspaceID), name, cond).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		// A concurrent insert won the race; re-read it.
		err = s.pool.QueryRow(ctx, `
			select id from alert
			where workspace_id is not distinct from $1 and condition->>'type' = $2
			order by created_at desc limit 1`, nullStr(workspaceID), alertType).Scan(&id)
	}
	return id, err
}

// InsertSystemEvent records an observability event (spec §11). Budget
// threshold crossings write one so the status page and the alert history see
// the same story.
func (s *Store) InsertSystemEvent(ctx context.Context, eventType, resource, resourceID, workspaceID string, metadata map[string]any) error {
	meta := []byte("{}")
	if len(metadata) > 0 {
		if b, err := json.Marshal(metadata); err == nil {
			meta = b
		}
	}
	_, err := s.pool.Exec(ctx, `
		insert into system_event (id, type, resource, resource_id, workspace_id, metadata)
		values ($1,$2,$3,$4,$5,$6)`,
		ids.New("evt"), eventType, nullStr(resource), nullStr(resourceID), nullStr(workspaceID), meta)
	return err
}

// RecentAlertFiring reports whether an alert already fired recently for the
// same condition value, so a threshold crossing raises ONE alert_event instead
// of one per request (PRD §42 is an alert, not a log).
func (s *Store) RecentAlertFiring(ctx context.Context, alertID string, within time.Duration) (bool, error) {
	var n int
	err := s.pool.QueryRow(ctx, `
		select count(*) from alert_event
		where alert_id = $1 and state = 'firing'
		  and triggered_at > now() - ($2 * interval '1 second')`,
		alertID, within.Seconds()).Scan(&n)
	return n > 0, err
}
