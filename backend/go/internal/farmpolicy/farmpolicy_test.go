// Rationale: farmpolicy.Evaluate is the brain of cmd/farmplan — it decides
// what WOULD be farmed without ever firing a farm. The standing operator order
// is that farms run only on a manual trigger, so this function is the ONLY
// artifact that may say "WANT n credentials". Getting the verdicts wrong is
// not a cosmetic bug: a false "ready" on a disabled policy is a policy
// override, and a false cooldown-remaining mis-schedules a human. These tests
// pin every verdict, including the pre-warm-before-reset case that exists
// because the router exposes each provider's exact quota reset time.
package farmpolicy_test

import (
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/farmpolicy"
)

func TestEvaluate(t *testing.T) {
	now := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)

	healthy := farmpolicy.Policy{
		ProviderID: "prv-healthy",
		Enabled:    true,
		MinUsable:  50,
		Target:     100,
	}

	cases := []struct {
		name           string
		policy         farmpolicy.Policy
		state          farmpolicy.State
		wantStatus     farmpolicy.Status
		wantTriggers   []farmpolicy.Trigger
		wantWant       int
		wantRemaining  time.Duration
		wantPrewarm    bool
		wantRemainingS *float64 // set if CooldownRemaining must equal this
	}{
		{
			name: "zero usable, INSUFFICIENT_CREDITS, reports WANT",
			policy: farmpolicy.Policy{
				ProviderID: "prv-drained",
				Enabled:    true,
				MinUsable:  10,
				Target:     100,
			},
			state: farmpolicy.State{
				Usable:             0,
				Total:              40,
				RecentErrorCodes:   []string{"INSUFFICIENT_CREDITS", "INSUFFICIENT_CREDITS", "CIRCUIT_OPEN"},
				Now:                now,
			},
			// 0 < min(10) → deficit; INSUFFICIENT_CREDITS → quota_drain.
			// CIRCUIT_OPEN is deliberately in the errors: it is router noise,
			// not a quota signal, and must NOT fire anything.
			wantStatus:   farmpolicy.Ready,
			wantTriggers: []farmpolicy.Trigger{farmpolicy.Deficit, farmpolicy.QuotaDrain},
			wantWant:     100,
		},
		{
			name: "same provider, enabled=false, reports DISABLED",
			policy: farmpolicy.Policy{
				ProviderID: "prv-drained",
				Enabled:    false,
				MinUsable:  10,
				Target:     100,
			},
			state: farmpolicy.State{
				Usable:           0,
				Total:            40,
				RecentErrorCodes: []string{"INSUFFICIENT_CREDITS"},
				Now:              now,
			},
			// Disabled wins even though the pool is empty and a trigger would
			// fire: intent is explicit, and Want still shows the gap.
			wantStatus:   farmpolicy.Disabled,
			wantTriggers: nil,
			wantWant:     100,
		},
		{
			name: "inside cooldown, reports COOLDOWN with remaining",
			policy: farmpolicy.Policy{
				ProviderID:      "prv-cooled",
				Enabled:         true,
				MinUsable:       10,
				Target:          100,
				CooldownMinutes: 30,
			},
			state: farmpolicy.State{
				Usable:           0,
				RecentErrorCodes: []string{"INSUFFICIENT_CREDITS"},
				LastRun:          now.Add(-10 * time.Minute),
				Now:              now,
			},
			wantStatus:     farmpolicy.Cooldown,
			wantRemainingS: ptr(20.0), // 30m - 10m
			wantWant:       100,
		},
		{
			name: "healthy provider reports nothing",
			policy: healthy,
			state: farmpolicy.State{
				Usable:  100,
				Total:   100,
				Now:     now,
			},
			wantStatus:   farmpolicy.Ready,
			wantTriggers: nil,
			wantWant:     0,
		},
		{
			name: "prewarm before the reset window",
			policy: farmpolicy.Policy{
				ProviderID: "prv-zro",
				Enabled:    true,
				MinUsable:  50,
				Target:     200,
			},
			state: farmpolicy.State{
				Usable:                          120,
				Total:                           500,
				FirstCooldownIn:                 durPtr(600 * time.Second), // 10m < 15m window
				RecentErrorCodes:                []string{"RATE_LIMITED"},
				Now:                             now,
			},
			// Pool is above its floor (no deficit) but BELOW target, and the
			// earliest cooldown expires inside the window: load it now so the
			// reset window opens onto a full pool.
			wantStatus:   farmpolicy.Ready,
			wantTriggers: []farmpolicy.Trigger{farmpolicy.Prewarm, farmpolicy.RateLimited},
			wantWant:     80,
			wantPrewarm:  true,
		},
		{
			name: "cooldown window with pool already at target does not prewarm",
			policy: farmpolicy.Policy{
				ProviderID: "prv-full",
				Enabled:    true,
				MinUsable:  50,
				Target:     200,
			},
			state: farmpolicy.State{
				Usable:                          200,
				Total:                           200,
				FirstCooldownIn:                 durPtr(300 * time.Second),
				Now:                             now,
			},
			// Nothing to load: the prewarm trigger is absent even though the
			// window is open, and Want stays 0.
			wantStatus:   farmpolicy.Ready,
			wantTriggers: nil,
			wantWant:     0,
			wantPrewarm:  true, // the window itself is still reported as open
		},
		{
			name: "never-run policy is never in a cooldown",
			policy: farmpolicy.Policy{
				ProviderID:      "prv-never",
				Enabled:         true,
				MinUsable:       1,
				Target:          10,
				CooldownMinutes: 60,
			},
			state: farmpolicy.State{
				Usable: 0,
				Total:  5,
				Now:    now, // LastRun stays zero
			},
			wantStatus:   farmpolicy.Ready,
			wantTriggers: []farmpolicy.Trigger{farmpolicy.Deficit},
			wantWant:     10,
		},
		{
			name: "RATE_LIMITED errors fire the rate_limited trigger",
			policy: farmpolicy.Policy{
				ProviderID: "prv-zro",
				Enabled:    true,
				MinUsable:  0,
				Target:     100,
			},
			state: farmpolicy.State{
				Usable:           100,
				Total:            100,
				RecentErrorCodes: []string{"RATE_LIMITED"},
				Now:              now,
			},
			// Pool is at target, no deficit — but a saturated pool that is
			// still erroring is the farming case: add capacity before the next
			// reset.
			wantStatus:   farmpolicy.Ready,
			wantTriggers: []farmpolicy.Trigger{farmpolicy.RateLimited},
			wantWant:     0,
		},
		{
			name: "provider-specific trigger codes fire as quota evidence",
			policy: farmpolicy.Policy{
				ProviderID:   "prv-custom",
				Enabled:      true,
				MinUsable:    0,
				Target:       50,
				TriggerCodes: []string{"UPSTREAM_ERROR"},
			},
			state: farmpolicy.State{
				Usable:           20,
				Total:            30,
				RecentErrorCodes: []string{"UPSTREAM_ERROR"},
				Now:              now,
			},
			wantStatus:   farmpolicy.Ready,
			wantTriggers: []farmpolicy.Trigger{farmpolicy.QuotaDrain},
			wantWant:     30,
		},
		{
			name: "cooldown beats a would-be trigger report",
			policy: farmpolicy.Policy{
				ProviderID:      "prv-cd",
				Enabled:         true,
				MinUsable:       10,
				Target:          100,
				CooldownMinutes: 60,
			},
			state: farmpolicy.State{
				Usable:           0,
				Total:            40,
				RecentErrorCodes: []string{"INSUFFICIENT_CREDITS"},
				LastRun:          now.Add(-30 * time.Minute),
				Now:              now,
			},
			// Cooldown suppresses the trigger list entirely — the operator sees
			// one verdict, not a verdict plus a wish list.
			wantStatus:   farmpolicy.Cooldown,
			wantTriggers: nil,
			wantRemainingS: ptr(30.0),
			wantWant:     100,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := farmpolicy.Evaluate(tc.policy, tc.state)

			if got.Status != tc.wantStatus {
				t.Errorf("status = %q, want %q", got.Status, tc.wantStatus)
			}
			if got.Want != tc.wantWant {
				t.Errorf("want = %d, want %d", got.Want, tc.wantWant)
			}
			if got.PrewarmInside != tc.wantPrewarm {
				t.Errorf("prewarmInside = %v, want %v", got.PrewarmInside, tc.wantPrewarm)
			}
			if tc.wantRemainingS != nil {
				if got.CooldownRemaining != time.Duration(*tc.wantRemainingS)*time.Minute {
					t.Errorf("cooldownRemaining = %v, want %v", got.CooldownRemaining, time.Duration(*tc.wantRemainingS)*time.Minute)
				}
			} else if got.CooldownRemaining != 0 {
				t.Errorf("cooldownRemaining = %v, want 0", got.CooldownRemaining)
			}

			if len(got.Triggers) != len(tc.wantTriggers) {
				t.Fatalf("triggers = %v, want %v", got.Triggers, tc.wantTriggers)
			}
			for i := range got.Triggers {
				if got.Triggers[i] != tc.wantTriggers[i] {
					t.Fatalf("triggers = %v, want %v", got.Triggers, tc.wantTriggers)
				}
			}
		})
	}
}

func ptr(f float64) *float64 { return &f }

func durPtr(d time.Duration) *time.Duration { return &d }
