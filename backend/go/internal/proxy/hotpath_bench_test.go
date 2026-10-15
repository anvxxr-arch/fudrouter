package proxy

// Hot-path benchmarks for the admission half of the lifecycle (PRD §85).
//
// Why these exist: the router's budget for one request is a few milliseconds,
// and the admission half runs before a single byte goes upstream. These
// benchmarks pin the CPU cost of the parts that are pure functions of the
// request body, so a change that adds a parse, an allocation or a map
// round-trip shows up as a number instead of as a production latency nobody
// can attribute.
//
// Everything here is deliberately free of Postgres and Valkey: the DB-backed
// paths (ResolveModel, Candidates, EffectiveLimits) are covered by the
// integration suite, and a benchmark that needs a live DSN would silently skip
// on a developer box and prove nothing. The S0 limiter's own cost lives with
// its implementation (internal/limits/bench_test.go), not here.

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/routing"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
)

// A realistic chat-completions body: the fields the router reads plus the
// noise a real client sends. tokenEstimate only needs three of them, so the
// benchmark measures how much the rest costs.
var benchBody = []byte(`{
  "model": "grok-4.6",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Explain the difference between a fixed and a sliding rate-limit window, and when each is the right choice."}
  ],
  "temperature": 0.7,
  "top_p": 1,
  "max_tokens": 2048,
  "stream": false,
  "user": "bench-runner",
  "metadata": {"session": "abc123", "tags": ["bench", "hot-path"]}
}`)

// A body with no declared output bound: tokenEstimate must return 0 without
// allocating a map for the whole document.
var benchBodyNoMax = []byte(`{
  "model": "grok-4.6",
  "messages": [{"role": "user", "content": "hello"}],
  "stream": true
}`)

func BenchmarkTokenEstimate(b *testing.B) {
	b.Run("with-max-tokens", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			if n := tokenEstimate(benchBody); n != 2048 {
				b.Fatalf("tokenEstimate = %d, want 2048", n)
			}
		}
	})
	b.Run("no-max-tokens", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			if n := tokenEstimate(benchBodyNoMax); n != 0 {
				b.Fatalf("tokenEstimate = %d, want 0", n)
			}
		}
	})
}

// benchCandidates builds a candidate set the size a busy model actually
// resolves to: several providers, each with a distinct signal profile so the
// sort does real comparisons rather than hitting a tie on every pair.
func benchCandidates(n int) []routing.Candidate {
	out := make([]routing.Candidate, 0, n)
	for i := range n {
		c := routing.Candidate{
			Store: &store.Candidate{
				ModelID:      "mdl_bench",
				ModelSlug:    "grok-4.6",
				ProviderID:   "prv_bench",
				ProviderName: "provider",
				ProviderSlug: "provider",
				Priority:     i,
				Region:       "us-east",
			},
			PriceInputMicro:  int64(1000 + i*10),
			PriceOutputMicro: int64(2000 + i*10),
			LatencyMs:        int64(300 + i*7),
			Availability:     0.9 + float64(i%10)/100,
			Capacity:         100,
		}
		c.LoadSignals()
		out = append(out, c)
	}
	return out
}

func BenchmarkRoutingFilterSelect(b *testing.B) {
	plan := routing.Plan{
		Strategy: routing.StrategyBalanced,
		Weights:  routing.DefaultWeights(),
	}
	// Constraints bound the candidate set without emptying it, so Filter does
	// real comparisons instead of returning everything untouched.
	maxIn, maxOut, maxP95 := int64(5000), int64(9000), int64(2000)
	minAvail := 0.9
	constrained := routing.Plan{
		Strategy: routing.StrategyBalanced,
		Weights:  routing.DefaultWeights(),
		Constraints: routing.Constraints{
			MaxInputPriceMicro:  &maxIn,
			MaxOutputPriceMicro: &maxOut,
			MaxP95LatencyMs:     &maxP95,
			MinAvailability:     &minAvail,
		},
	}
	sizes := []struct {
		n     int
		label string
	}{
		{4, "4-candidates"},
		{16, "16-candidates"},
		{64, "64-candidates"},
	}
	for _, s := range sizes {
		cands := benchCandidates(s.n)
		b.Run(s.label, func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				kept := routing.Filter(cands, plan.Constraints)
				if len(kept) == 0 {
					b.Fatal("filter dropped every candidate")
				}
				ordered := routing.Select(kept, plan)
				if len(ordered) != len(kept) {
					b.Fatalf("select returned %d of %d", len(ordered), len(kept))
				}
			}
		})
		b.Run(s.label+"-constrained", func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				kept := routing.Filter(cands, constrained.Constraints)
				ordered := routing.Select(kept, constrained)
				if len(ordered) > len(cands) {
					b.Fatalf("select returned %d of %d", len(ordered), len(cands))
				}
			}
		})
	}
}

// BenchmarkBodyDecode is the reference point for tokenEstimate: what the
// current full-document decode costs, so the Phase 2 change has a number to
// beat rather than a claim.
func BenchmarkBodyDecode(b *testing.B) {
	b.Run("full-map", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			var req map[string]any
			if err := json.Unmarshal(benchBody, &req); err != nil {
				b.Fatal(err)
			}
			if _, ok := req["max_tokens"].(float64); !ok {
				b.Fatal("max_tokens missing")
			}
		}
	})
}

// Guard: the benchmark fixtures must stay in step with the shapes the hot
// path reads, or the numbers measure a body the router never sees.
func TestBenchFixturesMatchHotPath(t *testing.T) {
	if got := tokenEstimate(benchBody); got != 2048 {
		t.Fatalf("benchBody max_tokens = %d, want 2048", got)
	}
	if got := tokenEstimate(benchBodyNoMax); got != 0 {
		t.Fatalf("benchBodyNoMax max_tokens = %d, want 0", got)
	}
	cands := benchCandidates(4)
	kept := routing.Filter(cands, routing.Constraints{})
	if len(kept) != 4 {
		t.Fatalf("unconstrained filter kept %d of 4", len(kept))
	}
	if ordered := routing.Select(kept, routing.Plan{Strategy: routing.StrategyBalanced, Weights: routing.DefaultWeights()}); len(ordered) != 4 {
		t.Fatalf("select returned %d of 4", len(ordered))
	}
	_ = time.Second
}
