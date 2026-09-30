// Package routing turns resolved model candidates into an ordered plan and
// executes it with retries and fallback (spec §9, PRD §30–34).
//
// Two halves:
//
//   - selection: constraint filter → strategy scoring → ordered candidates,
//     each carrying the `reason` it won its slot (spec §8 `request_attempt
//     .reason`);
//   - execution: the retry/fallback loop with the circuit breaker and the
//     request deadline. The executor is generic over the upstream exchange
//     (the proxy supplies the HTTP call), so the retry rules can be tested
//     without a server.
//
// The scoring formula is INTERNAL and may change without breaking the API
// (PRD §31) — what is pinned is the strategy names and their intent.
package routing

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/rand/v2"
	"strings"
	"sync/atomic"

	"github.com/anvxxr-arch/fudrouter/services/router/internal/store"
)

// Strategy names (PRD §30). `smart` is `balanced` unless the smart_routing
// feature flag is on (its learned signals are P2 and not in this tree).
const (
	StrategyBalanced          = "balanced"
	StrategyLowestCost        = "lowest_cost"
	StrategyLowestLatency     = "lowest_latency"
	StrategyHighestReliability = "highest_reliability"
	StrategyProviderPriority  = "provider_priority"
	StrategyWeighted          = "weighted"
	StrategyRoundRobin        = "round_robin"
	StrategyRandom            = "random"
	StrategySmart             = "smart"
)

// NormalizeStrategy maps a request's strategy override (or policy strategy)
// onto one the selector implements. Unknown values fall back to `def` — a
// caller's typo must not fail the request (the policy still applies).
func NormalizeStrategy(s, def string, smartEnabled bool) string {
	s = strings.TrimSpace(s)
	if s == StrategySmart {
		if smartEnabled {
			return StrategyBalendedAlias(smartEnabled)
		}
		return StrategyBalanced
	}
	switch s {
	case StrategyBalanced, StrategyLowestCost, StrategyLowestLatency,
		StrategyHighestReliability, StrategyProviderPriority,
		StrategyWeighted, StrategyRoundRobin, StrategyRandom:
		return s
	}
	if def == "" {
		return StrategyBalanced
	}
	return NormalizeStrategy(def, StrategyBalanced, smartEnabled)
}

// StrategyBalendedAlias keeps `smart`'s future learned behaviour in one place:
// with the flag on it behaves as balanced today (P2 owns the learned scoring).
func StrategyBalendedAlias(bool) string { return StrategyBalanced }

// Candidate is a routing view over one store.Candidate: the metrics the
// strategies score and the ordering inputs they use. One Candidate is one
// EXCHANGE TARGET (model mapping on a connection); the connection's credential
// rows rotate inside one attempt loop (spec §4: one account = one credential
// row, all picked through the connection's pool).
type Candidate struct {
	Store *store.Candidate
	// Reason is written into request_attempt.reason for whichever attempt uses
	// this candidate (spec §8).
	Reason string

	// Signals, defaults filled by LoadSignals.
	PriceInputMicro  int64 // micro-units per 1M tokens (cost.Price scale)
	PriceOutputMicro int64
	LatencyMs        int64 // p95 estimate; neutral when unmeasured
	Availability     float64
	Capacity         int64 // credential weight / connection capacity hint
}

// NeutralSignal values are used when a target has no measurement yet. They must
// be AT THE MIDPOINT of what measured targets can show: a new provider with no
// history must neither win every route nor lose every route (the same rule the
// capability filter follows in spec §5: a missing claim is not a claim).
const (
	neutralLatencyMs    = int64(300)
	neutralAvailability = 0.95
	neutralCapacity     = int64(100)
)

// LoadSignals fills a candidate's scoring signals from its stored state:
// prices from the pricing rule, latency/availability from the connection's
// config jsonb (`p95_latency_ms`, `availability`) when present, capacity from
// the credential weight.
func (c *Candidate) LoadSignals() {
	sc := c.Store
	if sc.Price != nil {
		in, _, out, _ := sc.Price.BillablePrices()
		c.PriceInputMicro, c.PriceOutputMicro = in, out
	}
	c.LatencyMs = neutralLatencyMs
	c.Availability = neutralAvailability
	c.Capacity = neutralCapacity

	// connection.config carries optional measured signals (spec §4 config).
	var cfg struct {
		P95LatencyMs *int64   `json:"p95_latency_ms"`
		Availability *float64 `json:"availability"`
		Capacity     *int64   `json:"capacity"`
	}
	if len(sc.ConfigJSON) > 0 {
		_ = json.Unmarshal(sc.ConfigJSON, &cfg)
	}
	if cfg.P95LatencyMs != nil && *cfg.P95LatencyMs > 0 {
		c.LatencyMs = *cfg.P95LatencyMs
	}
	if cfg.Availability != nil && *cfg.Availability > 0 && *cfg.Availability <= 1 {
		c.Availability = *cfg.Availability
	}
	if cfg.Capacity != nil && *cfg.Capacity > 0 {
		c.Capacity = *cfg.Capacity
	}
	// The health status is a fallback availability claim (spec §4 vocabulary).
	switch sc.HealthStatus {
	case "healthy":
		if cfg.Availability == nil {
			c.Availability = 0.99
		}
	case "degraded":
		if cfg.Availability == nil {
			c.Availability = 0.9
		}
	case "unhealthy":
		if cfg.Availability == nil {
			c.Availability = 0.5
		}
	}
	// Credential weight is the capacity hint when nothing else claims one.
	if cfg.Capacity == nil && len(sc.Credentials) > 0 {
		c.Capacity = int64(sc.Credentials[0].Weight)
		if c.Capacity <= 0 {
			c.Capacity = neutralCapacity
		}
	}
}

// Constraints is spec §9 `constraints`. Missing keys constrain nothing (a
// missing claim is not a claim).
type Constraints struct {
	MaxInputPriceMicro  *int64
	MaxOutputPriceMicro *int64
	MaxP95LatencyMs     *int64
	MinAvailability     *float64
	AllowedProviders    []string
	BlockedProviders    []string
	RegionPreference    string
}

// Preferences is the `provider_preferences` / `model_preferences` shape agreed
// with the control plane: {"order": ["<slug>", …]}, optionally {"weights":
// {"<slug>": 0.7}} for the weighted strategy.
type Preferences struct {
	Order   []string
	Weights map[string]float64
}

// Weights is spec §9 `weights` for the balanced score: price, latency,
// reliability, capacity.
type Weights struct {
	Price      float64
	Latency    float64
	Reliability float64
	Capacity   float64
}

// DefaultWeights mirrors the seeded `rte_default` policy (0007).
func DefaultWeights() Weights {
	return Weights{Price: 0.25, Latency: 0.25, Reliability: 0.25, Capacity: 0.25}
}

// Plan is the fully resolved routing decision inputs.
type Plan struct {
	Strategy         string
	Constraints      Constraints
	ProviderPref     Preferences
	ModelPref        Preferences
	Weights          Weights
	MaxAttempts      int
	RequestTimeoutMs int
	FallbackEnabled  bool
}

// Filter eliminates candidates the constraints reject (spec §9). The filter
// runs BEFORE scoring: a candidate that cannot be afforded must not win on
// latency and then fail the request.
func Filter(cands []Candidate, c Constraints) []Candidate {
	out := make([]Candidate, 0, len(cands))
	for _, cd := range cands {
		sc := cd.Store
		if c.MaxInputPriceMicro != nil && cd.PriceInputMicro > *c.MaxInputPriceMicro {
			continue
		}
		if c.MaxOutputPriceMicro != nil && cd.PriceOutputMicro > *c.MaxOutputPriceMicro {
			continue
		}
		if c.MaxP95LatencyMs != nil && cd.LatencyMs > *c.MaxP95LatencyMs {
			continue
		}
		if c.MinAvailability != nil && cd.Availability < *c.MinAvailability {
			continue
		}
		if len(c.AllowedProviders) > 0 && !matchesAny(c.AllowedProviders, sc) {
			continue
		}
		if len(c.BlockedProviders) > 0 && matchesAny(c.BlockedProviders, sc) {
			continue
		}
		if c.RegionPreference != "" && sc.Region != "" && sc.Region != c.RegionPreference {
			// NULL region passes: a missing claim is not a veto (spec §5 rule
			// applied to region too).
			continue
		}
		out = append(out, cd)
	}
	return out
}

// matchesAny tests a provider list (ids or slugs) against a candidate.
func matchesAny(list []string, sc *store.Candidate) bool {
	for _, want := range list {
		if want == sc.ProviderID || want == sc.ProviderName || want == sc.ProviderSlug {
			return true
		}
	}
	return false
}

// Select orders candidates for `plan`'s strategy and stamps each with the
// reason it won its slot. The output is the attempt order; the executor walks
// it and stops at the first success.
func Select(cands []Candidate, plan Plan) []Candidate {
	if len(cands) == 0 {
		return nil
	}
	out := make([]Candidate, len(cands))
	copy(out, cands)

	switch plan.Strategy {
	case StrategyLowestCost:
		sortBy(out, func(a, b Candidate) bool {
			ta, tb := a.totalPrice(), b.totalPrice()
			if ta != tb {
				return ta < tb
			}
			return a.Store.Priority < b.Store.Priority
		})
	case StrategyLowestLatency:
		sortBy(out, func(a, b Candidate) bool {
			if a.LatencyMs != b.LatencyMs {
				return a.LatencyMs < b.LatencyMs
			}
			return a.Store.Priority < b.Store.Priority
		})
	case StrategyHighestReliability:
		sortBy(out, func(a, b Candidate) bool {
			if a.Availability != b.Availability {
				return a.Availability > b.Availability
			}
			return a.Store.Priority < b.Store.Priority
		})
	case StrategyProviderPriority:
		sortBy(out, func(a, b Candidate) bool {
			oa, ob := prefRank(plan.ProviderPref, a), prefRank(plan.ProviderPref, b)
			if oa != ob {
				return oa < ob // lower rank = more preferred
			}
			return a.Store.Priority < b.Store.Priority
		})
	case StrategyWeighted:
		out = weightedOrder(out, plan.ProviderPref)
	case StrategyRoundRobin:
		out = roundRobinOrder(out)
	case StrategyRandom:
		rand.Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] })
	default: // balanced (and smart's current behaviour)
		sortBy(out, func(a, b Candidate) bool {
			sa, sb := balancedScore(a, plan.Weights), balancedScore(b, plan.Weights)
			if sa != sb {
				return sa > sb
			}
			// A preference list breaks score ties before raw provider priority.
			oa, ob := prefRank(plan.ProviderPref, a), prefRank(plan.ProviderPref, b)
			if oa != ob {
				return oa < ob
			}
			return a.Store.Priority < b.Store.Priority
		})
	}

	// Model preference is a final tie-order hint across models in the set: a
	// preferred model's targets sort ahead of an unpreferred model's at equal
	// standing. Applied as a stable partition on the model slug.
	if len(plan.ModelPref.Order) > 0 {
		stablePartition(out, func(a Candidate) bool {
			return rankOf(plan.ModelPref.Order, a.Store.ModelSlug) >= 0
		})
	}

	for i := range out {
		out[i].Reason = selectReason(plan, out[i], i)
	}
	return out
}

func (c Candidate) totalPrice() int64 {
	return c.PriceInputMicro + c.PriceOutputMicro
}

// balancedScore is the weighted normalized sum (PRD §31: formula internal).
// Every term is in [0,1] with 1 = best, so weights compare like for like.
func balancedScore(c Candidate, w Weights) float64 {
	if w == (Weights{}) {
		w = DefaultWeights()
	}
	nPrice := normBest(float64(c.totalPrice()), true)
	nLat := normBest(float64(c.LatencyMs), true)
	nRel := c.Availability
	nCap := normBest(float64(c.Capacity), false)
	return w.Price*nPrice + w.Latency*nLat + w.Reliability*nRel + w.Capacity*nCap
}

// normBest maps a positive raw value to (0,1] where 1 is best, using a soft
// reciprocal so the scale of the metric does not matter: smaller raw is better
// when lowerIsBetter, larger raw is better otherwise. The reciprocal keeps a
// 10x-outlier from dominating a weighted sum the way a linear min/max would.
func normBest(raw float64, lowerIsBetter bool) float64 {
	if raw <= 0 {
		if lowerIsBetter {
			return 1
		}
		return 0
	}
	v := 1 / (1 + math.Log10(1+raw/100))
	if !lowerIsBetter {
		v = math.Log10(1+raw/100) / (1 + math.Log10(1+raw/100))
		if v <= 0 {
			v = 0.5
		}
	}
	if v > 1 {
		v = 1
	}
	return v
}

// prefRank returns the index of a candidate in the preference list, or a large
// sentinel when it is not listed.
func prefRank(p Preferences, c Candidate) int {
	r := rankOf(p.Order, c.Store.ProviderID)
	if r < 0 {
		r = rankOf(p.Order, c.Store.ProviderName)
	}
	if r < 0 {
		r = rankOf(p.Order, c.Store.ProviderSlug)
	}
	if r < 0 {
		return len(p.Order) + 1
	}
	return r
}

func rankOf(order []string, name string) int {
	for i, s := range order {
		if s == name {
			return i
		}
	}
	return -1
}

// weightedOrder spreads load across the preference list by declared weight
// (evenly when no weights are declared), then falls back to score order for
// unlisted providers.
func weightedOrder(cands []Candidate, p Preferences) []Candidate {
	if len(p.Order) == 0 {
		// No preference: round-robin is the honest reading of "weighted" over
		// an unweighted set.
		return roundRobinOrder(cands)
	}
	listed := make([]Candidate, 0, len(cands))
	rest := make([]Candidate, 0, len(cands))
	for _, c := range cands {
		if prefRank(p, c) < len(p.Order) {
			listed = append(listed, c)
		} else {
			rest = append(rest, c)
		}
	}
	// Stable round-robin across the preference list order, repeated weight/step
	// times so a weight of 2 gets two slots per cycle before the next provider.
	byRank := map[int][]Candidate{}
	for _, c := range listed {
		r := prefRank(p, c)
		byRank[r] = append(byRank[r], c)
	}
	out := make([]Candidate, 0, len(cands))
	for round := 0; len(out) < len(listed); round++ {
		progressed := false
		for rank := range p.Order {
			q := byRank[rank]
			if len(q) == 0 {
				continue
			}
			weight := p.Weights[p.Order[rank]]
			slots := 1
			if weight > 0 {
				slots = int(math.Round(weight * 2))
				if slots < 1 {
					slots = 1
				}
			}
			for i := 0; i < slots && len(q) > 0; i++ {
				out = append(out, q[0])
				q = q[1:]
				progressed = true
			}
			byRank[rank] = q
		}
		if !progressed {
			break
		}
		_ = round
	}
	return append(out, rest...)
}

var rrCounter atomic.Uint64

// roundRobinOrder rotates the candidate list by a process-wide counter, so
// consecutive requests start at different targets and load spreads.
func roundRobinOrder(cands []Candidate) []Candidate {
	n := len(cands)
	if n < 2 {
		return cands
	}
	off := int(rrCounter.Add(1) % uint64(n))
	out := make([]Candidate, 0, n)
	for i := range n {
		out = append(out, cands[(i+off)%n])
	}
	return out
}

// selectReason records WHY a candidate won its slot (spec §8 `reason`): the
// strategy, its rank, and the signal that decided it. It is written into
// request_attempt.reason so an operator can reconstruct a routing decision
// without the (mutable) policy that produced it.
func selectReason(plan Plan, c Candidate, rank int) string {
	switch plan.Strategy {
	case StrategyLowestCost:
		return fmt.Sprintf("%s #%d: input %d + output %d micro/1M", plan.Strategy, rank+1, c.PriceInputMicro, c.PriceOutputMicro)
	case StrategyLowestLatency:
		return fmt.Sprintf("%s #%d: p95 %dms", plan.Strategy, rank+1, c.LatencyMs)
	case StrategyHighestReliability:
		return fmt.Sprintf("%s #%d: availability %.2f", plan.Strategy, rank+1, c.Availability)
	case StrategyProviderPriority, StrategyWeighted:
		return fmt.Sprintf("%s #%d: provider %s priority %d", plan.Strategy, rank+1, c.Store.ProviderName, c.Store.Priority)
	case StrategyRoundRobin, StrategyRandom:
		return fmt.Sprintf("%s #%d: provider %s", plan.Strategy, rank+1, c.Store.ProviderName)
	default:
		return fmt.Sprintf("balanced #%d: score %.3f (price %d, p95 %dms, avail %.2f)",
			rank+1, balancedScore(c, plan.Weights), c.totalPrice(), c.LatencyMs, c.Availability)
	}
}

// sortBy is a stable ascending sort with an explicit comparator.
func sortBy(s []Candidate, less func(a, b Candidate) bool) {
	// insertion sort: candidate sets are small (< a dozen) and this keeps the
	// ordering stable without pulling sort.Slice's less allocation into the
	// hot path.
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && less(s[j], s[j-1]); j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

// stablePartition moves the elements matching `first` to the front, preserving
// relative order on both sides.
func stablePartition(s []Candidate, first func(Candidate) bool) {
	out := make([]Candidate, 0, len(s))
	for _, c := range s {
		if first(c) {
			out = append(out, c)
		}
	}
	for _, c := range s {
		if !first(c) {
			out = append(out, c)
		}
	}
	copy(s, out)
}

// ErrNoCandidates is returned when a request resolved to a model with no
// routable target left after capability and constraint filtering.
var ErrNoCandidates = errors.New("routing: no candidates")
