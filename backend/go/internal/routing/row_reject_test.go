package routing

import (
	"context"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/vk"
)

// A row-reject attempt is what lifecycle.go synthesises when an upstream
// answers a retryable 4xx whose body blames the MAPPING (measured 2026-11-03:
// tokenjuice's DeepSeek-V4.1-Flash row answered `duplicate field
// reasoning_content` with HTTP 400 to 383 of 383 attempts). No credential
// failed, so no credential park exists to stop the walk re-picking the row.
func rowRejectAttempt(c *Candidate) *Attempt {
	return &Attempt{
		ErrorCode:     ErrCodeInvalidRequest,
		HTTPStatus:    400,
		Retryable:     true,
		RowRejectPark: true,
		RawMessage:    "duplicate field `reasoning_content` at line 1 column 109228",
		StartedAt:     time.Now(),
		FinishedAt:    time.Now(),
		LatencyMs:     95_000,
	}
}

func TestRowRejectParkRoundTrip(t *testing.T) {
	ctx := context.Background()
	cb := NewCircuitBreaker(vk.NewFake(), nil)

	if cb.RowRejectParked(ctx, "pmdl_rot") {
		t.Fatal("row parked before anything was observed")
	}
	cb.ParkRowReject(ctx, "pmdl_rot")
	if !cb.RowRejectParked(ctx, "pmdl_rot") {
		t.Fatal("ParkRowReject did not take effect")
	}
	// Only the parked row moves — a sibling row of the same provider must stay
	// servable, which is the whole point of a ROW-scoped park.
	if cb.RowRejectParked(ctx, "pmdl_sibling") {
		t.Fatal("an unrelated row was parked")
	}
	if cb.MaintenanceParked(ctx, "prv_any") {
		t.Fatal("a row-reject leaked into the provider maintenance park")
	}
}

// The park must remove ONLY the rotten row: its healthy siblings and every
// other provider survive admission.
func TestFilterRowRejectParked(t *testing.T) {
	ctx := context.Background()
	cb := NewCircuitBreaker(vk.NewFake(), nil)

	rot := pmCandidate("prv_tokenjuice", "pmdl_rot")
	sib1 := pmCandidate("prv_tokenjuice", "pmdl_sib1")
	sib2 := pmCandidate("prv_tokenjuice", "pmdl_sib2")
	other := pmCandidate("prv_freemodel", "pmdl_o_1")

	// Nothing parked: untouched.
	if got := cb.FilterRowRejectParked(ctx, []Candidate{rot, sib1, sib2, other}); len(got) != 4 {
		t.Fatalf("unparked filter dropped candidates: %d of 4", len(got))
	}

	cb.ParkRowReject(ctx, "pmdl_rot")
	got := cb.FilterRowRejectParked(ctx, []Candidate{rot, sib1, sib2, other})
	if len(got) != 3 {
		t.Fatalf("filtered = %v, want 3 (rot row dropped)", names(got))
	}
	for _, c := range got {
		if candidateProviderModelID(&c) == "pmdl_rot" {
			t.Fatal("the parked row survived admission")
		}
	}

	// Fail-open: the rotten row is the model's ONLY candidate — it still gets
	// one honest attempt rather than a \"no routable target\" 502.
	if got := cb.FilterRowRejectParked(ctx, []Candidate{rot}); len(got) != 1 {
		t.Fatalf("fail-open returned %d candidates, want the original 1", len(got))
	}
}

// Core behaviour: ONE row rejection costs ONE attempt, the walk moves past the
// row's other credentials AND past its sibling rows to a different provider —
// then the row is parked for later requests.
func TestExecuteParksRowAfterBodyRejection(t *testing.T) {
	ctx := context.Background()
	cb := NewCircuitBreaker(vk.NewFake(), nil)

	rot := pmCandidate("prv_tokenjuice", "pmdl_rot")
	sib := pmCandidate("prv_tokenjuice", "pmdl_sib")
	other := pmCandidate("prv_freemodel", "pmdl_o_1")

	tried := map[string]int{}
	fn := func(_ context.Context, cand *Candidate, next, budget int) []*Attempt {
		id := candidateProviderModelID(cand)
		tried[id]++
		if id == "pmdl_rot" {
			// >1 attempt in one callback = the walk rotated credentials on the
			// rejected row. lifecycle.go's break must prevent Execute from
			// re-entering it; the assertion below pins that behaviour.
			return []*Attempt{rowRejectAttempt(cand), rowRejectAttempt(cand)}
		}
		return []*Attempt{okAttempt()}
	}

	res := Execute(ctx, []Candidate{rot, sib, other},
		Plan{Strategy: StrategyProviderPriority, MaxAttempts: 6, FallbackEnabled: true}, time.Time{}, cb, fn)

	if res.Winner == nil {
		t.Fatal("no winner — the walk must reach a servable candidate")
	}
	if got := candidateProviderModelID(res.Winner.Candidate); got != "pmdl_sib" && got != "pmdl_o_1" {
		t.Fatalf("winner row = %q, want a candidate that is not the rejected row", got)
	}
	if tried["pmdl_rot"] != 1 {
		t.Fatalf("rejected row entered %d times, want 1 — the row park must stop the walk re-entering it", tried["pmdl_rot"])
	}
	if !cb.RowRejectParked(ctx, "pmdl_rot") {
		t.Fatal("the body rejection did not park the row for later requests")
	}
	if cb.RowRejectParked(ctx, "pmdl_sib") {
		t.Fatal("a healthy sibling row was parked")
	}
}

// INVARIANT: an ordinary retryable error that is NOT a body rejection must
// keep the pre-existing walk — no row park, and the row's own retry budget is
// still usable (a 429 is about the credential, not the mapping).
func TestExecuteNonBodyRejectionDoesNotParkRow(t *testing.T) {
	ctx := context.Background()
	cb := NewCircuitBreaker(vk.NewFake(), nil)

	a := pmCandidate("prv_a", "pmdl_a")
	b := pmCandidate("prv_b", "pmdl_b")

	tried := 0
	fn := func(_ context.Context, cand *Candidate, next, budget int) []*Attempt {
		tried++
		return []*Attempt{{
			ErrorCode:  ErrCodeRateLimited,
			HTTPStatus: 429,
			Retryable:  true,
			RawMessage: "rate limited",
			StartedAt:  time.Now(),
			FinishedAt: time.Now(),
			LatencyMs:  30,
		}}
	}

	Execute(ctx, []Candidate{a, b},
		Plan{Strategy: StrategyProviderPriority, MaxAttempts: 6, FallbackEnabled: true}, time.Time{}, cb, fn)

	if tried != 2 {
		t.Fatalf("attempted %d candidates, want 2 — a plain 429 must keep walking", tried)
	}
	if cb.RowRejectParked(ctx, "pmdl_a") || cb.RowRejectParked(ctx, "pmdl_b") {
		t.Fatal("a plain 429 parked a row — only body rejections may")
	}
}
