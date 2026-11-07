package routing

import (
	"context"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/vk"
)

// The exact envelope measured from freemodel.in (2026-11-03, 307 attempts in
// 20 minutes, HTTP 503). The test pins the LITERAL string: a "smart" matcher
// that also catches "upgrade" or "unavailable" would reclassify ordinary
// per-account refusals from other providers, which the card forbids.
const liveMaintenanceBody = `{"error":"FreeModel is being upgraded right now. Please retry in a few minutes - nothing was charged."}`

func TestMaintenanceEnvelope(t *testing.T) {
	cases := []struct {
		name string
		body string
		want bool
	}{
		{"live measured envelope", liveMaintenanceBody, true},
		{"bare vendor message", `{"error":"FreeModel is being upgraded right now"}`, true},
		{"case insensitive", `{"error":"FREEMODEL IS BEING UPGRADED RIGHT NOW."}`, true},
		// Negatives: every one of these was seen in the same 90-minute window and
		// must keep its existing classification (card invariant: only the
		// freemodel maintenance envelope changes behaviour).
		{"nginx 502 page", `<html><head><title>502 Bad Gateway</title></head></html>`, false},
		{"daily limit reached", `{"error":"Daily limit reached. Try again tomorrow."}`, false},
		{"token balance exhausted", `{"error":"Token balance exhausted. You have 0 tokens remaining and insufficient credit balance."}`, false},
		{"generic unavailable", `{"error":"The service is temporarily unavailable, please retry"}`, false},
		{"upgrade without the vendor anchor", `{"error":"The model is being upgraded right now, try later"}`, false},
		{"empty body", ``, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := MaintenanceEnvelope([]byte(tc.body)); got != tc.want {
				t.Errorf("MaintenanceEnvelope(%q) = %v, want %v", tc.body, got, tc.want)
			}
		})
	}
}

// pmCandidate is the minimum a walk needs: a provider identity and a
// provider_model, so breakerTarget and the maintenance park both have keys.
func pmCandidate(providerID, providerModelID string) Candidate {
	return Candidate{
		Store: &store.Candidate{
			ModelID:         "mdl_m",
			ModelSlug:       "m",
			ProviderID:      providerID,
			ProviderName:    providerID,
			ProviderModelID: providerModelID,
			Priority:        100,
		},
		LatencyMs:    50,
		Availability: 0.9,
		Capacity:     10,
	}
}

func maintenanceAttempt(c *Candidate) *Attempt {
	return &Attempt{
		ErrorCode:       ErrCodeProviderUnavailable,
		HTTPStatus:      503,
		Retryable:       true,
		MaintenancePark: true,
		RawMessage:      "FreeModel is being upgraded right now.",
		StartedAt:       time.Now(),
		FinishedAt:      time.Now(),
		LatencyMs:       60,
	}
}

func okAttempt() *Attempt {
	return &Attempt{StartedAt: time.Now(), FinishedAt: time.Now(), LatencyMs: 10}
}

func TestMaintenanceParkRoundTrip(t *testing.T) {
	ctx := context.Background()
	cb := NewCircuitBreaker(vk.NewFake(), nil)

	if cb.MaintenanceParked(ctx, "prv_freemodel") {
		t.Fatal("provider parked before anything was observed")
	}
	cb.ParkMaintenance(ctx, "prv_freemodel")
	if !cb.MaintenanceParked(ctx, "prv_freemodel") {
		t.Fatal("ParkMaintenance did not take effect")
	}
	// Only the parked provider moves.
	if cb.MaintenanceParked(ctx, "prv_other") {
		t.Fatal("an unrelated provider was parked")
	}
}

// A park must remove the provider's candidates from admission but never change
// another provider's fate, and never empty the set.
func TestFilterMaintenanceParked(t *testing.T) {
	ctx := context.Background()
	cb := NewCircuitBreaker(vk.NewFake(), nil)

	fm1 := pmCandidate("prv_freemodel", "pmdl_fm_1")
	fm2 := pmCandidate("prv_freemodel", "pmdl_fm_2")
	other := pmCandidate("prv_other", "pmdl_o_1")

	// Nothing parked: the list is returned untouched.
	if got := cb.FilterMaintenanceParked(ctx, []Candidate{fm1, fm2, other}); len(got) != 3 {
		t.Fatalf("unparked filter dropped candidates: %d of 3", len(got))
	}

	cb.ParkMaintenance(ctx, "prv_freemodel")
	got := cb.FilterMaintenanceParked(ctx, []Candidate{fm1, fm2, other})
	if len(got) != 1 || candidateProviderID(&got[0]) != "prv_other" {
		t.Fatalf("filtered = %v, want only prv_other", names(got))
	}

	// Fail-open: a model whose ONLY provider is parked still gets one honest
	// attempt instead of a "no routable target" 502.
	got = cb.FilterMaintenanceParked(ctx, []Candidate{fm1, fm2})
	if len(got) != 2 {
		t.Fatalf("fail-open returned %d candidates, want the original 2", len(got))
	}
}

// The core behaviour change: ONE maintenance declaration must cost ONE attempt,
// and the walk must still reach a different provider.
func TestExecuteParksProviderAfterMaintenanceEnvelope(t *testing.T) {
	ctx := context.Background()
	cb := NewCircuitBreaker(vk.NewFake(), nil)

	fm1 := pmCandidate("prv_freemodel", "pmdl_fm_1")
	fm2 := pmCandidate("prv_freemodel", "pmdl_fm_2")
	fm3 := pmCandidate("prv_freemodel", "pmdl_fm_3")
	other := pmCandidate("prv_other", "pmdl_o_1")

	tried := map[string]int{}
	fn := func(_ context.Context, cand *Candidate, next, budget int) []*Attempt {
		pid := candidateProviderID(cand)
		tried[pid]++
		if pid == "prv_freemodel" {
			return []*Attempt{maintenanceAttempt(cand)}
		}
		return []*Attempt{okAttempt()}
	}

	res := Execute(ctx, []Candidate{fm1, fm2, fm3, other},
		Plan{Strategy: StrategyProviderPriority, MaxAttempts: 6, FallbackEnabled: true}, time.Time{}, cb, fn)

	if res.Winner == nil || candidateProviderID(res.Winner.Candidate) != "prv_other" {
		t.Fatalf("winner = %+v, want prv_other — maintenance on one provider must not end the walk", res.Winner)
	}
	if tried["prv_freemodel"] != 1 {
		t.Fatalf("freemodel candidates tried %d times, want 1 (its siblings must be skipped)", tried["prv_freemodel"])
	}
	if tried["prv_other"] != 1 {
		t.Fatalf("other provider tried %d times, want 1", tried["prv_other"])
	}
	if !cb.MaintenanceParked(ctx, "prv_freemodel") {
		t.Fatal("the maintenance declaration did not park the provider for later requests")
	}
	if cb.MaintenanceParked(ctx, "prv_other") {
		t.Fatal("the healthy provider was parked")
	}
}

// A model whose only provider is under maintenance must still make exactly one
// real attempt and report the provider's own answer — not a phantom 502 and not
// six fast-fails.
func TestExecuteMaintenanceOnOnlyProviderCostsOneAttempt(t *testing.T) {
	ctx := context.Background()
	fm1 := pmCandidate("prv_freemodel", "pmdl_fm_1")
	fm2 := pmCandidate("prv_freemodel", "pmdl_fm_2")
	fm3 := pmCandidate("prv_freemodel", "pmdl_fm_3")

	tried := 0
	fn := func(_ context.Context, cand *Candidate, next, budget int) []*Attempt {
		tried++
		return []*Attempt{maintenanceAttempt(cand)}
	}

	res := Execute(ctx, []Candidate{fm1, fm2, fm3},
		Plan{Strategy: StrategyProviderPriority, MaxAttempts: 6, FallbackEnabled: true}, time.Time{}, nil, fn)

	if tried != 1 {
		t.Fatalf("attempted %d candidates, want 1", tried)
	}
	if len(res.Attempts) != 1 {
		t.Fatalf("recorded %d attempts, want 1", len(res.Attempts))
	}
	if res.LastErrorCode != ErrCodeProviderUnavailable {
		t.Fatalf("LastErrorCode = %q, want %q", res.LastErrorCode, ErrCodeProviderUnavailable)
	}
	if res.Winner != nil {
		t.Fatal("a maintenance envelope was reported as a winner")
	}
}

// INVARIANT: a 503 from a provider that did NOT send the freemodel envelope
// keeps the pre-existing behaviour — retryable, no park, every candidate walked.
func TestExecuteNonMaintenance503IsUnchanged(t *testing.T) {
	ctx := context.Background()
	a := pmCandidate("prv_other", "pmdl_o_1")
	b := pmCandidate("prv_other2", "pmdl_o_2")
	c := pmCandidate("prv_other3", "pmdl_o_3")

	tried := 0
	fn := func(_ context.Context, cand *Candidate, next, budget int) []*Attempt {
		tried++
		return []*Attempt{{
			ErrorCode:  ErrCodeProviderUnavailable,
			HTTPStatus: 503,
			Retryable:  true,
			RawMessage: "no online worker",
			StartedAt:  time.Now(),
			FinishedAt: time.Now(),
			LatencyMs:  40,
		}}
	}

	res := Execute(ctx, []Candidate{a, b, c},
		Plan{Strategy: StrategyProviderPriority, MaxAttempts: 6, FallbackEnabled: true}, time.Time{}, nil, fn)

	if tried != 3 {
		t.Fatalf("attempted %d candidates, want 3 — a non-freemodel 503 must keep walking", tried)
	}
	if len(res.Attempts) != 3 {
		t.Fatalf("recorded %d attempts, want 3", len(res.Attempts))
	}
}
