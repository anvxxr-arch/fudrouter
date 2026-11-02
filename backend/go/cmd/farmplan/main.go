// farmplan prints the DRY-RUN farm plan for every provider in the catalogue:
// what WOULD be farmed if policies were enabled and a run were triggered
// manually. It executes nothing — no signup, no outbound request, no write of
// any kind; the only SQL it runs is SELECT.
//
// Why this exists as a table rather than an alert: the live pool is uneven
// (e.g. mistral carried 10,187 invalid credentials in one snapshot; freeai and
// zro sit mostly rate_limited with cooldowns), so the operator needs to see
// the whole board — usable vs target, which triggers fired, and the verdict —
// before deciding which policy to enable.
//
// Usage: DATABASE_URL=postgres://... farmplan
package main

import (
	"context"
	"fmt"
	"os"
	"sort"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/farmpolicy"
	"github.com/jackc/pgx/v5"
)

func main() {
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		fmt.Println("db:", err)
		os.Exit(1)
	}
	defer conn.Close(ctx)

	// The usable predicate is the router's own rule (AGENTS.md, mirrored in
	// routing): status not in ('disabled','invalid') AND no active cooldown.
	// auth_failed deliberately counts as usable — mirroring, not inventing.
	// first_expiry is the earliest FUTURE cooldown_until across the provider's
	// credentials: the quota-reset signal the evaluator pre-warms on.
	rows, err := conn.Query(ctx, `
		select
			p.id,
			coalesce(p.slug, p.id)                              as label,
			count(c.id)                                         as total,
			count(c.id) filter (
				where c.status not in ('disabled', 'invalid')
				  and (c.cooldown_until is null or c.cooldown_until <= now())
			)                                                   as usable,
			min(c.cooldown_until) filter (where c.cooldown_until > now()) as first_expiry,
			fp.enabled, fp.min_usable_creds, fp.target_creds,
			fp.trigger_codes, fp.cooldown_minutes, fp.last_run_at,
			coalesce(
				(select array_agg(distinct rl.error_code)
				 from request_log rl
				 where rl.provider_id = p.id
				   and rl.created_at > now() - interval '24 hours'
				   and rl.error_code is not null),
				'{}'::text[])
			as recent_codes
		from provider p
		left join farm_policy fp on fp.provider_id = p.id
		left join connection cn on cn.provider_id = p.id
		left join credential c on c.connection_id = cn.id
		group by p.id, fp.enabled, fp.min_usable_creds, fp.target_creds,
		         fp.trigger_codes, fp.cooldown_minutes, fp.last_run_at
		order by p.id`)
	if err != nil {
		fmt.Println("query:", err)
		os.Exit(1)
	}
	defer rows.Close()

	now := time.Now()
	type plan struct {
		label    string
		decision farmpolicy.Decision
		usable   int
		total    int
	}
	var plans []plan
	for rows.Next() {
		var (
			id, label      string
			total, usable  int
			firstExpiry    *time.Time
			enabled        *bool
			minUsable      int
			target         int
			triggerCodes   []string
			cooldownMin    int
			lastRun        *time.Time
			recentCodes    []string
		)
		if err := rows.Scan(&id, &label, &total, &usable, &firstExpiry,
			&enabled, &minUsable, &target, &triggerCodes, &cooldownMin, &lastRun,
			&recentCodes); err != nil {
			fmt.Println("scan:", err)
			os.Exit(1)
		}

		p := farmpolicy.Policy{
			ProviderID:      id,
			Enabled:         enabled != nil && *enabled,
			MinUsable:       minUsable,
			Target:          target,
			TriggerCodes:    triggerCodes,
			CooldownMinutes: cooldownMin,
		}
		// A provider whose farm_policy row is missing (seeded after this
		// provider was created) reads as disabled: absent intent is not intent.
		s := farmpolicy.State{
			Usable:           usable,
			Total:            total,
			RecentErrorCodes: recentCodes,
			Now:              now,
		}
		if firstExpiry != nil {
			firstIn := firstExpiry.Sub(now)
			s.FirstCooldownIn = &firstIn
		}
		if lastRun != nil {
			s.LastRun = *lastRun
		}
		plans = append(plans, plan{label: label, decision: farmpolicy.Evaluate(p, s), usable: usable, total: total})
	}
	if err := rows.Err(); err != nil {
		fmt.Println("rows:", err)
		os.Exit(1)
	}

	// Highest want first: the top of the table is the decision the operator
	// has to make today.
	sort.SliceStable(plans, func(i, j int) bool {
		return plans[i].decision.Want > plans[j].decision.Want
	})

	fmt.Printf("%-42s %13s  %-28s %6s  %s\n",
		"provider", "usable/target", "triggers", "WANT", "verdict")
	anyWant := false
	for _, pl := range plans {
		verdict := string(pl.decision.Status)
		switch pl.decision.Status {
		case farmpolicy.Cooldown:
			verdict = fmt.Sprintf("cooldown %dm", int(pl.decision.CooldownRemaining.Minutes()+0.5))
		case farmpolicy.Ready:
			if len(pl.decision.Triggers) == 0 {
				verdict = "ready (idle)"
			}
		}
		trig := "-"
		if len(pl.decision.Triggers) > 0 {
			trig = fmt.Sprint(pl.decision.Triggers)
		}
		if pl.decision.Want > 0 {
			anyWant = true
		}
		fmt.Printf("%-42s %6d/%-6d  %-28s %6d  %s\n",
			pl.label, pl.usable, pl.total, trig, pl.decision.Want, verdict)
	}
	if !anyWant {
		fmt.Println("\n(no provider wants credentials — dry run, nothing executed)")
	} else {
		fmt.Println("\n(dry run — nothing was executed; farms trigger manually only)")
	}
}
