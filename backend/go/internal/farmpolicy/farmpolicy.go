// Package farmpolicy decides, per provider, whether a signup-farm run is
// WANTED — and nothing more. It is pure: no database, no clock, no network.
// A caller reads state and injects it; the same function powers unit tests
// and the operator's dry-run table.
//
// Why pure by construction: the standing operator order is that farms run only
// on a manual trigger, so the evaluator must be incapable of firing one even
// by accident. Its output is a plan; execution is a separate, human-started
// act that does not exist in this package.
package farmpolicy

import (
	"sort"
	"time"
)

// Trigger names a reason to farm. The built-ins cover the measured failure
// modes; a provider can add codes via Policy.TriggerCodes (e.g. a provider
// whose drain surfaces as UPSTREAM_ERROR instead of a quota code).
type Trigger string

const (
	// Deficit: the usable pool is below the configured floor. Fires with no
	// error evidence at all — a silent drain (credentials expiring one by one)
	// leaves no error codes to read, only a shrinking count.
	Deficit Trigger = "deficit"
	// QuotaDrain: a quota signal appeared in recent errors — accounts are being
	// consumed faster than they last. Built-in signal: INSUFFICIENT_CREDITS.
	QuotaDrain Trigger = "quota_drain"
	// RateLimited: RATE_LIMITED appeared in recent errors — the pool exists but
	// is saturated.
	RateLimited Trigger = "rate_limited"
	// Prewarm: credentials are inside the window before the earliest cooldown
	// expiry. The router can see a provider's exact quota reset time; adding
	// credentials BEFORE the window opens means the pool is loaded the moment
	// the reset lands instead of farming reactively afterwards.
	Prewarm Trigger = "prewarm"
)

// builtInTriggerCodes are the error codes the evaluator always treats as quota
// signals. Provider-specific extras ride in Policy.TriggerCodes and fire the
// same QuotaDrain signal — they are, by definition of that column, quota
// evidence, and inventing one trigger name per code would make the operator
// table unreadable.
var builtInTriggerCodes = map[string]bool{
	"INSUFFICIENT_CREDITS": true,
}

// PrewarmWindow is how close to the earliest cooldown expiry a provider counts
// as "inside the reset window". 15 minutes: long enough for a human to act on
// the plan, short enough not to prewarm half the day.
const PrewarmWindow = 15 * time.Minute

// Policy is one farm_policy row.
type Policy struct {
	ProviderID      string
	Enabled         bool
	MinUsable       int
	Target          int
	TriggerCodes    []string
	CooldownMinutes int
}

// State is what the caller observed about a provider right now.
type State struct {
	// Usable credentials under the router predicate: status not in
	// ('disabled','invalid') and not in an active cooldown. auth_failed counts
	// as usable — that is the router's own rule, mirrored here on purpose.
	Usable int
	// Total credential rows regardless of status.
	Total int
	// RecentErrorCodes are the provider's error codes from the observation
	// window (e.g. last 24h of request_log.error_code). Duplicates fine.
	RecentErrorCodes []string
	// FirstCooldownIn: time until the EARLIEST credential cooldown_until in
	// the future — the quota-reset signal. Nil when no credential is cooling
	// down. A pointer, not a numeric sentinel, because a zero-value State must
	// not read as "expires right now": that exact trap made every healthy
	// provider look prewarm-eligible in the first test run.
	FirstCooldownIn *time.Duration
	// LastRun is when this policy last executed a farm run; zero means never.
	LastRun time.Time
	// Now is injected, never read from the wall clock — that is what keeps the
	// function deterministic and the cooldown test honest.
	Now time.Time
}

// Status is the operator-facing verdict.
type Status string

const (
	// Disabled: the policy row says enabled=false. Always wins — a disabled
	// policy is a statement of intent, not a state the evaluator may override.
	Disabled Status = "disabled"
	// Cooldown: a run happened within CooldownMinutes. CooldownRemaining
	// carries the exact wait so the operator knows when to return.
	Cooldown Status = "cooldown"
	// Ready: not blocked; the plan below is what WOULD run on a manual trigger.
	Ready Status = "ready"
)

// Decision is the evaluator's output.
type Decision struct {
	ProviderID string
	Triggers   []Trigger
	// Want is the top-up count: Target - Usable, floored at 0. Set whenever a
	// trigger fires, regardless of blocking — the operator wants to see the
	// gap even for a disabled provider.
	Want   int
	Status Status
	// CooldownRemaining is > 0 only when Status is Cooldown.
	CooldownRemaining time.Duration
	// PrewarmInside is true when SecondsUntilFirstCooldownExpiry falls in the
	// prewarm window.
	PrewarmInside bool
}

// Evaluate turns observed state into a farm plan. Read-only and
// side-effect-free by design — see the package comment.
func Evaluate(p Policy, s State) Decision {
	d := Decision{ProviderID: p.ProviderID, Status: Ready}

	// Cooldown first: remaining is computed from the injected clock, and a
	// never-run policy (zero LastRun) cannot be inside a cooldown no matter
	// what CooldownMinutes says.
	if !s.LastRun.IsZero() && p.CooldownMinutes > 0 {
		if since := s.Now.Sub(s.LastRun); since < time.Duration(p.CooldownMinutes)*time.Minute {
			d.CooldownRemaining = time.Duration(p.CooldownMinutes)*time.Minute - since
			d.Status = Cooldown
		}
	}

	if s.FirstCooldownIn != nil && *s.FirstCooldownIn >= 0 && *s.FirstCooldownIn <= PrewarmWindow {
		d.PrewarmInside = true
	}

	// Want is computed BEFORE the blockers return: the operator wants to see
	// the gap for a disabled or cooling provider too — "disabled" hides the
	// plan, not the size of the hole.
	if s.Usable < p.Target {
		d.Want = p.Target - s.Usable
	}

	// Disabled wins over cooldown in the reported verdict: the operator fixing
	// a disabled policy needs to see "disabled", not a cooldown they cannot
	// act on anyway. Triggers are suppressed behind both blockers — one
	// verdict, not a verdict plus a wish list.
	if !p.Enabled {
		d.Status = Disabled
		return d
	}
	if d.Status == Cooldown {
		return d
	}

	d.Triggers = triggers(p, s)
	return d
}

// triggers fires each signal independently; the list is sorted for stable
// output and deduplicated because RecentErrorCodes may repeat a code.
func triggers(p Policy, s State) []Trigger {
	fired := map[Trigger]bool{}
	var out []Trigger
	add := func(t Trigger) {
		if !fired[t] {
			fired[t] = true
			out = append(out, t)
		}
	}

	if s.Usable < p.MinUsable {
		add(Deficit)
	}

	extra := make(map[string]bool, len(p.TriggerCodes))
	for _, c := range p.TriggerCodes {
		extra[c] = true
	}
	for _, code := range s.RecentErrorCodes {
		if code == "RATE_LIMITED" {
			add(RateLimited)
			continue
		}
		if builtInTriggerCodes[code] || extra[code] {
			add(QuotaDrain)
		}
	}

	if s.FirstCooldownIn != nil &&
		*s.FirstCooldownIn >= 0 &&
		*s.FirstCooldownIn <= PrewarmWindow &&
		s.Usable < p.Target {
		add(Prewarm)
	}

	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}
