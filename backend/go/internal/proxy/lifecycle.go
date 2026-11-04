package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/cost"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/egress"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/ids"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/limits"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/routing"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/sourceip"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/jackc/pgx/v5/pgconn"
)

// lifecycle carries ONE request through PRD §85: authenticate → limits →
// budget → resolve model → route → attempt(s) → record → charge. Every
// /v1/* entry point runs the same machinery so a new endpoint cannot skip
// billing, the ledger or the error taxonomy.
type lifecycle struct {
	h *Handler
	r *http.Request
	w http.ResponseWriter

	start     time.Time
	requestID string
	endpoint  string
	requested string // the raw `model` string, or "" for non-model endpoints

	// unrestricted is set when the requested slug carried the
	// `-unrestricted` virtual suffix: resolution, routing and billing all
	// run on the base slug, and dispatch prepends the unrestricted system
	// prompt to the upstream body (unrestricted.go).
	unrestricted bool

	// injections are the operator-authored prompt injections that apply to
	// this request (prompt_injection table): resolved once at admission,
	// applied once at dispatch, before the attempt loop (injection.go).
	injections []store.PromptInjection

	key   *store.APIKeyRow
	lim   *store.Limits
	pol   *routing.Plan
	polID string

	resolved *store.ModelResolution
	cands    []routing.Candidate

	deadline time.Time
	timing   map[string]int64

	stream             bool
	clientDisconnected bool
	streamTTFT         *int

	// admission holds the concurrency slot for the request's lifetime. It is
	// the concrete type, not an interface: the only implementation is
	// *limits.Admission, and boxing it in an interface forced it to the heap on
	// every request (measured: the full-chain benchmark's remaining alloc).
	// Release is nil-safe, so the zero value needs no separate flag.
	admission *limits.Admission
	// cancelUpstream releases the non-streaming request bound.
	cancelUpstream func()

	attempts  []*routing.Attempt
	pricing   *store.Pricing
	usage     usageCounts
	usageSeen bool
	// tokensSaved is the estimated input tokens compression removed before
	// dispatch (compress.go). Recorded for reporting only — never billed.
	tokensSaved int64

	status   string // spec §8 vocabulary
	errCode  string
	errMsg   string
	rawErr   string // raw upstream text: request_log.error only (spec §8)
	httpStat int

	// wire selects the error envelope a rejection is written in: "" is the
	// [OI] shape, "anthropic" is {"type":"error","error":{...}} (the /v1/messages
	// surface, anthropic.go) and "gemini" is the Google shape
	// {"error":{"code","message","status"}} (the /v1beta surface, gemini.go).
	// Only rejections are shaped here — success bodies are translated by the
	// surface's own file.
	wire string

	finished bool

	// ledgerWG tracks the detached ledger writes (the retry loop and the
	// attempts insert). Production never waits on it — the whole point of
	// detaching is that the client does not. Tests join it so an assertion
	// about the ledger sees a settled state instead of racing the goroutine,
	// and so t.Cleanup(st.Close) cannot close the pool mid-write.
	ledgerWG sync.WaitGroup
}

// usageCounts is the provider-reported usage of one request (PRD §87, §122).
type usageCounts struct {
	TokensIn          int64
	CachedInputTokens int64
	TokensOut         int64
	ReasoningTokens   int64
	TotalTokens       int64
}

// validateFunc is the endpoint-specific body/path validation. It runs AFTER
// authentication and the key-policy gates (so an invalid key is 401 on every
// path — endpoint-surface spec §3.1) and BEFORE the limit counters (so a
// malformed body does not burn a request from the key's window).
//
// It returns the routing key (the body's `model`, or "" for non-model
// endpoints) and a rejection to answer with, if any.
type validateFunc func(body []byte) (slug string, reject *apiError)

// begin runs the admission half of the lifecycle. It answers the client itself
// on every rejection and returns ok=false there; on success the caller MUST
// call finish (defer it). `wire` shapes rejections like the surface's own API
// (see the lifecycle.wire comment).
func (h *Handler) begin(w http.ResponseWriter, r *http.Request, start time.Time, endpoint string, body []byte, validate validateFunc, wire string) (*lifecycle, bool) {
	lc := &lifecycle{
		h:         h,
		r:         r,
		w:         w,
		start:     start,
		requestID: ids.New("req"),
		endpoint:  endpoint,
		timing:    map[string]int64{},
		wire:      wire,
	}
	// The request id is on EVERY response, success or failure (PRD §90), so a
	// client can correlate an error with its request_log row.
	w.Header().Set("x-fudrouter-request-id", lc.requestID)

	authStart := time.Now()
	key, err := h.authenticate(r)
	if err != nil {
		if errors.Is(err, errAuthRateLimited) {
			lc.reject(routing.ErrCodeRateLimited, err.Error(), "rate_limited", http.StatusTooManyRequests)
			return lc, false
		}
		lc.reject(routing.ErrCodeAuthError, err.Error(), "client_error", int(statusCodeFor(routing.ErrCodeAuthError)))
		return lc, false
	}
	lc.key = key

	// Policy gates that belong to the key itself (spec §3): endpoint allowlist,
	// IP allowlist.
	if err := lc.checkPolicy(r); err != nil {
		lc.reject(routing.ErrCodeAuthorization, err.Error(), "client_error", int(statusCodeFor(routing.ErrCodeAuthorization)))
		return lc, false
	}
	lc.timing["auth"] = time.Since(authStart).Milliseconds()

	// Endpoint-specific validation (body shape, path support): a truthful 404
	// for an unimplemented path (spec §14 promise #5) or 400 for a bad body.
	slug, rejection := validate(body)
	lc.requested = slug
	if rejection != nil {
		lc.reject(rejection.Code, rejection.Message, "client_error", rejection.Status)
		return lc, false
	}

	// `-unrestricted` is a virtual suffix: resolve the base slug, remember
	// the flag for dispatch's system-prompt injection. The raw string stays
	// in lc.requested so logs and billing name what the client asked for.
	// Only allowlisted base slugs carry a twin (unrestricted.go): a
	// suffixed slug outside the allowlist keeps its full form and fails
	// resolution as the unknown model it is.
	resolveSlug := slug
	if base, ok := stripUnrestricted(slug); ok && unrestrictedAllowed(base) {
		lc.unrestricted = true
		resolveSlug = base
	}

	limStart := time.Now()
	lim, err := h.store.AdmissionLimits(r.Context(), key)
	if err != nil {
		// A limit lookup failure must not fail the request (fail open, spec
		// §12): log and continue unbounded at this level.
		log.Printf("[proxy] limit resolution failed for key %s: %v", key.ID, err)
		lim = &store.Limits{}
	}
	lc.lim = lim

	adm, rej := h.limiter.Check(r.Context(),
		&limits.APIKeyIdentity{KeyID: key.ID, UserID: key.UserID, Store: h.store},
		lim, tokenEstimate(body))
	if rej != nil {
		status := "rate_limited"
		if rej.HTTPStatus == http.StatusPaymentRequired {
			status = "client_error"
		}
		lc.reject(rej.Code, rej.Message, status, rej.HTTPStatus)
		return lc, false
	}
	// The concurrency slot lives for the whole request. Check returns the
	// Admission by value so it stays on this stack frame; taking its address
	// here is the one place it must outlive the call.
	lc.admission = &adm

	// Budget gate (spec §7/§10): thresholds raise alerts; 100% + block rejects.
	if err := h.checkBudgets(r.Context(), lc); err != nil {
		lc.reject(routing.ErrCodeInsufficientCredits, err.Error(), "client_error", http.StatusPaymentRequired)
		return lc, false
	}
	lc.timing["rate_limit"] = time.Since(limStart).Milliseconds()

	routeStart := time.Now()
	pol, err := h.cachedRoutingPolicy(r.Context(), key)
	if err != nil {
		pol = store.DefaultRoutingPolicy()
	}
	// Breaker config is lazy (D1): the first request pulls the circuit_breaker
	// table into the breaker; later requests refresh it on the in-process TTL.
	// Fail-open — an unreadable table keeps the last good config (D4).
	h.refreshBreakerConfig(r.Context())
	strategyOverride := ""
	// The strategy header lets a caller override the stored routing policy's
	// strategy, so it is off by default and must be opted into with
	// ROUTER_ALLOW_STRATEGY_HEADER=on. Left unset, the header is ignored
	// entirely: only an operator who knows what a strategy does to routing may
	// hand that choice to clients.
	if strings.EqualFold(strings.TrimSpace(os.Getenv("ROUTER_ALLOW_STRATEGY_HEADER")), "on") {
		strategyOverride = r.Header.Get("x-fudrouter-strategy")
	}
	plan := routing.PlanFromRoutingPolicy(pol, strategyOverride, false)
	lc.pol, lc.polID = &plan, pol.ID

	if slug != "" {
		res, err := h.store.ResolveModel(r.Context(), key, resolveSlug)
		if err != nil {
			code := routing.ErrCodeModelNotFound
			if !errors.Is(err, store.ErrNotFound) {
				code = routing.ErrCodeInternalError
			}
			lc.reject(code, "unknown model: "+slug, "client_error", int(statusCodeFor(code)))
			return lc, false
		}
		if err := lc.checkModelPolicy(res); err != nil {
			lc.reject(routing.ErrCodeAuthorization, err.Error(), "client_error", http.StatusForbidden)
			return lc, false
		}
		lc.resolved = res

		// A virtual model carries its OWN strategy (store/catalog.go's
		// virtualModels: fudrouter/fast → lowest_latency, fudrouter/cheap →
		// lowest_cost, fudrouter/reliable → highest_reliability, ...). It is
		// applied HERE, after resolution, because the hint does not exist until
		// the name has been resolved — every check above runs on `slug`, which
		// only ResolveModel turns into a kind and a target set.
		//
		// Before this the hint was dead code: `res.StrategyHint` was set on
		// every virtual and read by NOTHING, so fudrouter/fast, /cheap and
		// /reliable all silently ran the policy's `balanced`. A name whose
		// advertised behaviour is a lie is worse than one that does not exist.
		//
		// Precedence (see routing.ResolveStrategy):
		// opt-in header override → the virtual's own hint → the stored policy,
		// which the plan already carries. Reassigning lc.pol is what makes the
		// decision visible to Execute and to the ledger's recorded strategy.
		plan.Strategy = routing.ResolveStrategy(plan.Strategy, strategyOverride, res.StrategyHint)
		lc.pol = &plan

		// Prompt injections (prompt_injection): resolved here, applied once in
		// dispatch. Cached in Valkey like the routing policy, and fail-open —
		// a lookup failure dispatches the request unmodified.
		canonical := ""
		if len(res.ModelSlugs) > 0 {
			canonical = res.ModelSlugs[0]
		}
		lc.injections = h.cachedInjections(r.Context(), key, lc.requested, canonical)

		// Candidates: capability filter first (spec §5), then constraints and
		// scoring (spec §9).
		//
		// ONE query for the whole model set. This looped `Candidates` per model
		// id, and a `[NAME]/*` virtual name resolves its set from EVERY active
		// model — measured at 251 queries for one request against a 251-model
		// catalogue, each carrying the credential json_agg. The batch form is the
		// same SQL with `= any($1)` and a per-model row_number, so the fan-out is
		// a constant instead of a function of catalogue size.
		//
		// ROUND TRIP BUDGET: 5 for a canonical slug request — LookupAPIKey,
		// ResolveModel, then this batch, then the finish() write path
		// (request_log and its ledger row in one statement, plus one
		// request_attempt insert). It was 10, and 14 before that: the literal
		// slug branch used to be a second ResolveModel query, ChargeRequest used
		// to be six round trips with a row lock held across five of them, and
		// admission's three policy reads (limits, gate state, budget rows) are
		// now served from the in-process cache (store/admission.go) instead of
		// Postgres. A bare round trip on this box is ~117µs, so 5 is ~0.6ms; the
		// rest of the request's latency is contention, not query count.
		// TestFullRequestRoundTrips in internal/store pins the total and lists
		// every statement.
		//
		// The alias ordering below still reads res.ModelSlugs, and the per-model
		// candidate order is preserved by CandidatesBatch's window function.
		byModel, err := h.store.CandidatesBatch(r.Context(), res.ModelIDs, res.RequiredCapabilities)
		if err != nil {
			// A batch read failure is treated like "no routable target for this
			// model" was: fall through to the empty-merged rejection below, which
			// answers the same 404 the per-model loop produced when every call
			// failed.
			byModel = nil
		}
		var merged []routing.Candidate
		for _, modelID := range res.ModelIDs {
			cands := byModel[modelID]
			for j := range cands {
				c := cands[j]
				rc := routing.Candidate{Store: &c}
				rc.LoadSignals()
				merged = append(merged, rc)
			}
		}
		// Per-candidate prices drive the cost-aware strategies. Resolved here
		// through the shared fillCandidatePricing helper (fail-open to DB) so N
		// candidates cost N cache hits instead of N pricing queries; the
		// request's own billing snapshot in buildRow is untouched.
		h.fillCandidatePricing(r.Context(), merged)
		// The alias's own target order is the model preference when the policy
		// declares none (spec §5: alias targets are ordered by position).
		if len(plan.ModelPref.Order) == 0 && res.Kind == "alias" {
			plan.ModelPref.Order = append([]string(nil), res.ModelSlugs...)
		}
		merged = routing.Filter(merged, plan.Constraints)
		if len(merged) == 0 {
			lc.reject(routing.ErrCodeModelNotFound,
				"no candidate satisfies the request constraints for "+slug,
				"provider_error", http.StatusNotFound)
			return lc, false
		}
		// Measured reliability for the whole set, in the same one-round-trip
		// shape as the pricing fill above. It must run BEFORE Select: the
		// selector's reliability term and its collapsed-target demotion both
		// read the values this installs, and a miss leaves a candidate on its
		// declared availability (a Valkey outage degrades to ranking without
		// measurement, never to ranking on zeroes).
		lc.h.breaker.FillReliability(r.Context(), merged)
		lc.cands = routing.Select(merged, plan)
	}
	lc.timing["routing"] = time.Since(routeStart).Milliseconds()

	// The request deadline (spec §9): request_timeout_ms is absolute, and no
	// attempt may start that cannot finish inside it.
	lc.deadline = start.Add(time.Duration(plan.RequestTimeoutMs) * time.Millisecond)
	return lc, true
}

// tokenEstimate is the caller's own upper bound on output tokens (`max_tokens`
// / `max_completion_tokens` / `max_output_tokens`). The router does not count
// tokens (PRD §87: it bills what the upstream reports), so the TPM window is
// checked against the bound the CLIENT declared — and skipped when it declared
// none.
//
// A struct decode, not `map[string]any`. The map form allocated the ENTIRE
// body — every message, content string and nested object — to read three
// numbers (65 allocs / 2.3 kB on a realistic 500-byte chat request, measured by
// BenchmarkBodyDecode), and admission runs before any upstream byte moves, so
// that cost sat directly on the request's critical path. The scanner skips
// unknown fields without allocating them, which is where the win comes from.
//
// The error is only fatal when it is NOT a type error. A wrong-typed bound
// (`"max_tokens": "2048"`) must fall THROUGH to the next key rather than
// abandon the body — that is the behaviour token_estimate_test.go pins, and
// encoding/json continues past a field type error, leaving the remaining
// fields populated. A syntax error means the document is unparseable, which
// declares no bound at all: 0, and the endpoint's own validate does the
// rejecting.
func tokenEstimate(body []byte) int64 {
	// json.Unmarshal into a three-field struct, NOT a json.Decoder token walk.
	//
	// The token walk was tried and measured: 17.8 µs / 190 allocs/op versus
	// 5.0 µs / 8 allocs/op here, because Decoder.Token() boxes every token into
	// an `any`. The stdlib's Unmarshal is already a single-pass scanner that
	// skips unknown fields without materializing them; the struct is the cheap
	// shape. (The earlier comment claiming a hand-written scanner was a
	// description of an intent that was never implemented — the code has always
	// been this Unmarshal.)
	var f struct {
		MaxTokens     *float64 `json:"max_tokens"`
		MaxCompletion *float64 `json:"max_completion_tokens"`
		MaxOutput     *float64 `json:"max_output_tokens"`
	}
	if err := json.Unmarshal(body, &f); err != nil {
		var typeErr *json.UnmarshalTypeError
		if !errors.As(err, &typeErr) {
			return 0
		}
	}
	for _, bound := range []*float64{f.MaxTokens, f.MaxCompletion, f.MaxOutput} {
		if bound != nil && *bound > 0 {
			return int64(*bound)
		}
	}
	return 0
}

// checkPolicy enforces the key policy gates that need no routing decision
// (spec §3): endpoint allowlist, IP allowlist. A policy that says nothing is
// permissive (missing field = inherit, and there is nothing above to inherit).
func (lc *lifecycle) checkPolicy(r *http.Request) error {
	p := lc.key.Policy

	if len(p.Endpoints) > 0 && !contains(p.Endpoints, lc.endpoint) {
		return fmt.Errorf("this API key may not use %s", lc.endpoint)
	}
	if len(p.IPAllowlist) > 0 {
		ip := clientIP(r)
		if ip == "" || !ipAllowed(p.IPAllowlist, ip) {
			return fmt.Errorf("client IP is not in this API key's allowlist")
		}
	}
	return nil
}

// checkModelPolicy enforces the model/alias allowlists of the key policy
// (spec §3). The raw string is matched so an allowlist can name an alias.
func (lc *lifecycle) checkModelPolicy(res *store.ModelResolution) error {
	p := lc.key.Policy
	if len(p.Models) == 0 && len(p.Aliases) == 0 {
		return nil
	}
	allowed := false
	if contains(p.Aliases, res.Requested) {
		allowed = true
	}
	for _, slug := range res.ModelSlugs {
		if contains(p.Models, slug) {
			allowed = true
		}
	}
	if contains(p.Models, res.Requested) {
		allowed = true
	}
	if !allowed {
		return fmt.Errorf("this API key may not use model %s", res.Requested)
	}
	return nil
}

// TrustedProxiesEnv lists the ingress addresses whose X-Forwarded-For entries
// may be believed, as a comma-separated list of IPs and CIDRs. It is the
// operator's declaration of "my TLS terminates here" — the same rule the
// control plane's writeAudit follows, but made explicit instead of trusting
// whoever spoke first.
const TrustedProxiesEnv = "ROUTER_TRUSTED_PROXIES"

// trustedProxies is parsed once at startup from TrustedProxiesEnv. Empty means
// trust nothing: X-Forwarded-For is ignored entirely and clientIP falls back to
// RemoteAddr, which is the one address the router itself observed. Leaving the
// var unset therefore fails CLOSED — a client that forges
// `X-Forwarded-For: 1.2.3.4` cannot defeat a key's ip_allowlist or poison the
// request_log rows when the operator has not declared a proxy.
var trustedProxies = parseTrustedProxies(os.Getenv(TrustedProxiesEnv))

// parseTrustedProxies turns the env value into subnets. A bare IP becomes a
// /32 or /128 so every entry is one comparable *net.IPNet. Malformed entries
// are dropped rather than fatal: a typo must not stop the data plane, and the
// safe direction of a dropped entry is that its hop is treated as untrusted.
func parseTrustedProxies(spec string) []*net.IPNet {
	var out []*net.IPNet
	for _, part := range strings.Split(spec, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if _, subnet, err := net.ParseCIDR(part); err == nil {
			out = append(out, subnet)
			continue
		}
		if ip := net.ParseIP(part); ip != nil {
			bits := 32
			if ip.To4() == nil {
				bits = 128
			}
			out = append(out, &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)})
		}
	}
	return out
}

// isTrustedProxy reports whether addr is one of the declared ingress hops.
func isTrustedProxy(addr string) bool {
	ip := net.ParseIP(strings.TrimSpace(addr))
	if ip == nil {
		return false
	}
	for _, subnet := range trustedProxies {
		if subnet.Contains(ip) {
			return true
		}
	}
	return false
}

// clientIP extracts the request's client address by walking X-Forwarded-For
// from RIGHT to LEFT, skipping every entry that is a trusted proxy
// (ROUTER_TRUSTED_PROXIES, comma-separated IPs/CIDRs), and returning the first
// address that is not. The header is walked ONLY when the socket peer itself
// is a declared proxy — a direct caller forging X-Forwarded-For gets its peer
// address, never the forged value (fail closed, same gate as the React
// plane's clientIp). With no XFF, or with every entry a trusted proxy, it
// falls back to the peer host. Unparseable → "".
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer := strings.TrimSpace(host)
	// The header is believed only when the socket peer is a declared proxy:
	// otherwise any direct caller could forge X-Forwarded-For and defeat a
	// key's ip_allowlist (or poison request_log.client_ip). An untrusted peer
	// means the peer itself is the client — the same gate the React plane
	// uses (server/lib/ip.mjs clientIp).
	if !isTrustedProxy(peer) {
		if ip := net.ParseIP(peer); ip != nil {
			return ip.String()
		}
		return ""
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		hops := strings.Split(xff, ",")
		for i := len(hops) - 1; i >= 0; i-- {
			hop := strings.TrimSpace(hops[i])
			if hop == "" {
				continue
			}
			if isTrustedProxy(hop) {
				continue
			}
			if ip := net.ParseIP(hop); ip != nil {
				return ip.String()
			}
		}
	}
	if ip := net.ParseIP(peer); ip != nil {
		return ip.String()
	}
	return ""
}

// ipAllowed matches a dotted/CIDR allowlist (spec §3 `ip_allowlist`).
func ipAllowed(list []string, ipStr string) bool {
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return false
	}
	for _, entry := range list {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		if strings.Contains(entry, "/") {
			_, subnet, err := net.ParseCIDR(entry)
			if err == nil && subnet.Contains(ip) {
				return true
			}
			continue
		}
		if parsed := net.ParseIP(entry); parsed != nil && parsed.Equal(ip) {
			return true
		}
	}
	return false
}

// reject answers a client-side rejection and arms the ledger record.
func (lc *lifecycle) reject(code, message, status string, httpStatus int) {
	lc.errCode, lc.errMsg, lc.status, lc.httpStat = code, message, status, httpStatus
	e := normalize(code, message)
	lc.setResponseHeaders()
	lc.w.Header().Set("Content-Type", "application/json")
	lc.w.WriteHeader(e.Status)
	if lc.wire == "anthropic" {
		// The /v1/messages surface answers in the Anthropic error envelope
		// (anthropic.go), so a rejection is parseable by an Anthropic client.
		_ = json.NewEncoder(lc.w).Encode(map[string]any{
			"type": "error",
			"error": map[string]string{
				"type": anthropicErrorType(e.Code), "message": e.Message,
			},
		})
	} else if lc.wire == "gemini" {
		// The /v1beta surface (gemini.go) rejects in the Google envelope, so a
		// Gemini SDK raises its own typed error instead of a shape mismatch.
		_ = json.NewEncoder(lc.w).Encode(geminiErrorBody(e.Code, e.Message))
	} else {
		_ = json.NewEncoder(lc.w).Encode(map[string]any{
			"error": map[string]string{"message": e.Message, "type": e.Type, "code": e.Code},
		})
	}
	// A rejected request is still a ledger row (spec §8: metadata always).
	lc.finish()
}

// setResponseHeaders stamps the PRD §90 identity headers, and the optional
// cost metadata behind its flag (default off).
func (lc *lifecycle) setResponseHeaders() {
	h := lc.w.Header()
	h.Set("x-fudrouter-request-id", lc.requestID)
	if lc.resolved != nil && len(lc.resolved.ModelSlugs) > 0 {
		h.Set("x-fudrouter-model", lc.servedModel())
	}
	if winner := lc.winner(); winner != nil && winner.Candidate != nil {
		h.Set("x-fudrouter-provider", winner.Candidate.Store.ProviderName)
	}
	h.Set("x-fudrouter-latency", fmt.Sprint(time.Since(lc.start).Milliseconds()))
	// Cost metadata is flag-gated (PRD §90, default off) and only stamped when
	// the usage to compute it from is already known: on a stream the headers go
	// out with the FIRST byte, long before the usage chunk arrives, so the
	// header is simply absent there (the value is still billed and recorded in
	// request_log).
	if lc.h.showCostMeta && lc.usageSeen {
		h.Set("x-fudrouter-cost-micro", fmt.Sprint(lc.customerCost()))
	}
}

// resolvePricing returns the spec §6 price snapshot — the pricing_rule version
// effective at REQUEST START (lc.start), frozen so a later price change never
// rewrites history — resolving it on first use and reusing the result.
//
// Lazy because the snapshot is needed in two places at different times: the
// cost header (only when usage is known, so after a non-stream response body is
// read) and buildRow (at ledger write). Resolved under a DETACHED context: the
// client may already be gone, and the snapshot must still land.
func (lc *lifecycle) resolvePricing() *store.Pricing {
	if lc.pricing != nil {
		return lc.pricing
	}
	w := lc.winner()
	if w == nil || w.Candidate == nil {
		return nil
	}
	pctx, cancel := context.WithTimeout(context.WithoutCancel(lc.r.Context()), 5*time.Second)
	p, err := lc.h.store.ResolvePricing(pctx,
		w.Candidate.Store.ModelID, w.Candidate.Store.ProviderModelID, lc.start)
	cancel()
	if err != nil {
		return nil
	}
	lc.pricing = p
	return p
}

// customerCost is the charge the lifecycle computed (or would compute) in
// micro-units — the value request_log.cost carries. Only surfaced to the
// client behind the cost-headers flag (PRD §90).
func (lc *lifecycle) customerCost() int64 {
	p := lc.resolvePricing()
	if p == nil {
		return 0
	}
	in, cached, out, reason := p.BillablePrices()
	u := lc.usage
	c := cost.ComputeUsage(
		u.TokensIn-u.CachedInputTokens, u.CachedInputTokens,
		u.TokensOut-u.ReasoningTokens, u.ReasoningTokens,
		in, cached, out, reason)
	if c < 0 {
		return 0
	}
	return c
}

func (lc *lifecycle) servedModel() string {
	if w := lc.winner(); w != nil && w.Candidate != nil {
		return w.Candidate.Store.ModelSlug
	}
	if lc.resolved != nil && len(lc.resolved.ModelSlugs) > 0 {
		return lc.resolved.ModelSlugs[0]
	}
	return lc.requested
}

func (lc *lifecycle) winner() *routing.Attempt {
	for i := len(lc.attempts) - 1; i >= 0; i-- {
		if lc.attempts[i].ErrorCode == "" {
			return lc.attempts[i]
		}
	}
	return nil
}

// fail records a terminal failure and answers the client with the normalized
// envelope. `err` is raw upstream/transport text (recorded in the ledger only).
func (lc *lifecycle) fail(err error) {
	code := lc.errCode
	if code == "" {
		code = routing.ErrCodeUpstreamError
	}
	if len(lc.attempts) > 0 {
		last := lc.attempts[len(lc.attempts)-1]
		if last.ErrorCode != "" {
			code = last.ErrorCode
		}
		if last.RawMessage != "" {
			lc.rawErr = last.RawMessage
		}
	}
	if err != nil && lc.rawErr == "" {
		lc.rawErr = err.Error()
	}
	msg := lc.errMsg
	// The queue message is trusted only when the LAST attempt asked for a
	// client-visible status: an earlier attempt's hint must not describe a
	// later, different failure.
	if len(lc.attempts) == 0 || lc.attempts[len(lc.attempts)-1].ClientStatus == 0 {
		msg = ""
	}
	if msg == "" {
		msg = "upstream request failed"
	}
	lc.errCode, lc.errMsg = code, msg
	lc.status = statusForErrCode(code)
	lc.httpStat = statusCodeFor(code)

	e := normalize(code, msg)
	lc.setResponseHeaders()
	if len(lc.attempts) > 0 {
		last := lc.attempts[len(lc.attempts)-1]
		// A back-off hint can override the taxonomy default status (waiting
		// room: 503, not provider-unavailable's 502) and relays its
		// Retry-After seconds so the client knows when to come back.
		if last.ClientStatus != 0 {
			lc.httpStat = last.ClientStatus
		}
		if last.RetryAfterSeconds > 0 {
			lc.w.Header().Set("Retry-After", strconv.Itoa(last.RetryAfterSeconds))
		}
	}
	lc.w.Header().Set("Content-Type", "application/json")
	// httpStat carries the back-off override (or the taxonomy default), so it —
	// not e.Status — is what the client sees.
	status := lc.httpStat
	if status == 0 {
		status = e.Status
	}
	lc.w.WriteHeader(status)
	if lc.wire == "anthropic" {
		// The /v1/messages surface answers in the Anthropic error envelope.
		_ = json.NewEncoder(lc.w).Encode(map[string]any{
			"type": "error",
			"error": map[string]string{
				"type": anthropicErrorType(e.Code), "message": e.Message,
			},
		})
	} else if lc.wire == "gemini" {
		// The /v1beta surface (gemini.go) rejects in the Google envelope.
		_ = json.NewEncoder(lc.w).Encode(geminiErrorBody(e.Code, e.Message))
	} else {
		_ = json.NewEncoder(lc.w).Encode(map[string]any{
			"error": map[string]string{"message": e.Message, "type": e.Type, "code": e.Code},
		})
	}
	lc.finish()
}

// statusForErrCode maps the taxonomy onto the spec §8 status vocabulary.
func statusForErrCode(code string) string {
	switch code {
	case "":
		return "success"
	case routing.ErrCodeRateLimited:
		return "rate_limited"
	case routing.ErrCodeProviderTimeout:
		return "timeout"
	case routing.ErrCodeProviderUnavailable, routing.ErrCodeCircuitOpen, routing.ErrCodeUpstreamError:
		return "provider_error"
	case routing.ErrCodeInternalError:
		return "internal_error"
	case routing.ErrCodeAuthError, routing.ErrCodeAuthorization, routing.ErrCodeInvalidRequest,
		routing.ErrCodeModelNotFound, routing.ErrCodeContextTooLong, routing.ErrCodeUnsupportedParam,
		routing.ErrCodeContentRejected, routing.ErrCodeInsufficientCredits:
		return "client_error"
	}
	return "internal_error"
}

// upstreamContext bounds a non-streaming exchange end to end. A stream is
// governed by the client's own connection (r.Context()) plus the routing
// deadline for the ATTEMPT START only — a stream lives until the client
// disconnects, and an overall timeout would sever it mid-answer.
func (lc *lifecycle) upstreamContext(r *http.Request, stream bool) context.Context {
	if stream {
		return r.Context()
	}
	bound := nonStreamTimeout
	if d := time.Until(lc.deadline); !lc.deadline.IsZero() && d > 0 && d < bound {
		bound = d
	}
	ctx, cancel := context.WithTimeout(r.Context(), bound)
	// cancel runs when the response body is fully read or the handler returns;
	// the caller stores it on the lifecycle so the body read stays bounded.
	lc.cancelUpstream = cancel
	return ctx
}

// ledgerWriteBudget bounds ONE attempt: the primary charge, and each retry of
// the fallback ledger insert. Each attempt builds a fresh context (an expired
// one never revives), so it cannot inherit the primary's leftovers.
//
// Retries use ledgerWriteRetryBudget instead (1s). One budget for both was the
// v1 mistake: a retry is a BACKGROUND attempt whose only job is to be cheap
// enough to repeat, so the moment it is worth retrying — the queue is deep —
// every second it holds a connection is a second a request-path query spends
// queued behind it. Measured: at 5s per attempt the pool was 100% occupied for
// 60+ consecutive seconds; at 1s the same rows still land, but the loop
// releases its slots ~5x more often, so an inter-attempt gap is always coming.
const ledgerWriteBudget = 5 * time.Second

// ledgerWriteRetryBudget bounds ONE retry attempt of the fallback loop.
const ledgerWriteRetryBudget = 1 * time.Second

// ledgerWriteDeadline bounds the fallback's retry loop as a WHOLE (see finish).
//
// It used to be a fixed count (ledgerWriteAttempts = 3, ~15s of wall clock),
// which made the loss a function of queue depth: once the queue took longer
// than 3 attempts, the row was dropped, and whether a given run reached that
// depth depended on the machine. Measured on one commit: 0, 2, 5 and 6 rows
// lost out of 2000 across four runs of the same test. A fixed count cannot be
// "wide enough" because the queue has no fixed size.
//
// A deadline is the queue-depth argument in the only form that terminates:
// keep retrying until the queue drains, give up only when the row is
// demonstrably un-writable. The write is detached from the client (see the
// DETACHED note below), so the client latency never sees it. The row is
// idempotent (`request_log on conflict (id) do nothing`, ledger keyed
// `usage:<id>`), so extra attempts can never double-charge.
//
// COST, corrected. v1 justified this deadline with "the cost of a long deadline
// is one held goroutine, which is strictly cheaper than a lost billing row."
// The goroutine count is right (measured: 1.0 per pending row) and it is the
// wrong unit. Each attempt also HOLDS A POOL CONNECTION for its whole budget,
// and the pool is shared with auth, key lookup, rate limiting and every other
// read on the request path. Per lost-charge row that was 3x5s=15s of occupancy
// before, ~28x5s=140s after — 9x, unbounded, since the loop ends only when the
// queue drains. Serial A/B holding the billing_account row lock, 60 writers,
// pool 60, sampling pg_stat_activity for wait_event_type='Lock': the old code
// freed the pool at t=18s (blocked 60 -> 0, goroutines 70 -> 10); the v1 code
// held 60/60 blocked for the whole minute. That turns a billing-loss bug into
// a billing-loss-plus-outage risk. The three limits below are the fix: a 1s
// retry budget, a backoff well under it, and a writer cap that keeps most of
// the pool for request-path traffic.
const ledgerWriteDeadline = 5 * time.Minute

// ledgerWriteBackoff is the first retry's sleep; it doubles per attempt up to
// ledgerWriteBackoffMax. The cap matters more than the base now that the loop
// is bounded by a deadline: without it, exponential backoff spends the whole
// deadline asleep instead of re-queuing behind the drain.
//
// The cap MUST stay well under ledgerWriteRetryBudget or a cycle costs
// budget+backoff: at 5s+5s a single futile cycle ate a sixth of the deadline
// and re-queued only ~5x per minute, which is exactly the sampling pattern that
// kept the pool saturated. 1s backoff against a 1s attempt re-queues ~2x as
// often for the same wall clock.
const (
	ledgerWriteBackoff    = 250 * time.Millisecond
	ledgerWriteBackoffMax = 1 * time.Second
)

// ledgerWriterFraction sizes the concurrent-writer cap as a fraction of the
// pool: a thundering herd must never be able to occupy every connection.
//
// 2 leaves half the pool (30 of 60) for request-path work while still draining
// a saturated backlog. It is chosen from measurement, not taste: at 10 (cap 6)
// the drain rate throttled the ledger — a 2000-request run against a 60-pool
// produced 1335 failed charges and the retry loop recovered only ~3 rows/s, so
// 655 rows were still queued when the run ended. The cap must bound OCCUPANCY
// per attempt without becoming the bottleneck for the rows themselves.
const ledgerWriterFraction = 2

// ledgerWriterCapSize derives the concurrent detached-writer cap from the pool.
// A pool too small to divide still gets one writer: a cap of zero would shed
// every billing row under saturation, which is worse than the contention it
// prevents.
func ledgerWriterCapSize(maxConns int32) int {
	if n := int(maxConns) / ledgerWriterFraction; n > 1 {
		return n
	}
	return 1
}

// acquireLedgerSlot takes one of the bounded detached-writer slots, waiting at
// most ledgerWriterWait. It returns ok=false only when the row must be shed.
//
// Two shapes are wrong here, and both were tried:
//
//   - Non-blocking (`select {…default: shed}`) sheds every row the instant the
//     cap is warm. Under pool contention every request fails its primary charge
//     at once, so the whole backlog competes for the same few slots: measured
//     1097 of 2000 rows dropped — the fix re-created the loss it exists to
//     remove.
//   - Holding the slot for the WHOLE retry loop throttles billing throughput to
//     cap/cycle. The slot is then held through the backoff sleep, where it buys
//     nothing: the writer is asleep, not using a connection. Measured with a
//     6-slot cap held across the loop: still 209 of 2000 rows waiting on a slot
//     when the run ended.
//
// So the slot is per-ATTEMPT: taken for the duration of one insert, released
// before the backoff. Waiting costs no pool connection (the writer parks in the
// channel, it does not hold a connection), so waiting is nearly free and
// shedding is the expensive branch.
//
// A nil channel means no cap was configured (tests and alternate constructors
// build a bare Handler). A money path fails OPEN on that: a nil channel would
// otherwise fall to default and shed every row, which is the worst outcome
// available.
func (h *Handler) acquireLedgerSlot(parent context.Context) (release func(), ok bool) {
	noop := func() {}
	if h.ledgerWriters == nil {
		return noop, true
	}
	wait := h.ledgerWriterWait
	if wait <= 0 {
		wait = ledgerWriteDeadline
	}
	waitCtx, cancel := context.WithTimeout(parent, wait)
	defer cancel()
	select {
	case h.ledgerWriters <- struct{}{}:
		return func() { <-h.ledgerWriters }, true
	case <-waitCtx.Done():
		return noop, false
	}
}

// finish writes the ledger: request_log (with the usage_charge ledger row when
// there is a billing account, PRD §128) plus one request_attempt row per
// routing attempt (spec §8). It is the single funnel every outcome passes
// through — which is why one token clamp covers them all.
func (lc *lifecycle) finish() {
	if lc.finished {
		return
	}
	lc.finished = true

	// Release the concurrency slot first: it must not survive the request.
	if lc.admission != nil {
		lc.admission.Release()
	}
	if lc.cancelUpstream != nil {
		defer lc.cancelUpstream()
	}

	ctx, cancel := context.WithTimeout(context.WithoutCancel(lc.r.Context()), ledgerWriteBudget)
	defer cancel()

	// Clamp at the funnel: the token counts come from the upstream's `usage`
	// block, which is untrusted. A negative count would make cost negative and
	// lower the month's total, walking a key past its cap.
	u := lc.usage
	u.TokensIn, u.CachedInputTokens, u.TokensOut, u.ReasoningTokens, u.TotalTokens =
		clampTokens(u.TokensIn), clampTokens(u.CachedInputTokens),
		clampTokens(u.TokensOut), clampTokens(u.ReasoningTokens), clampTokens(u.TotalTokens)

	// request_log.http_status was NULL on every success row. Only reject() and
	// fail() ever set lc.httpStat; the success paths (serveBuffered, stream,
	// anthropic) write 200 straight to the client and left it at zero. Measured
	// on the live ledger: 724/724 status='success' rows had http_status NULL, so
	// every per-status metric undercounted the only outcome that matters. The
	// router answers success with 200 and nothing else, and a cancelled stream
	// had already sent its 200 headers, so derive it at this single funnel
	// rather than at four separate WriteHeader call sites.
	if lc.httpStat == 0 && lc.errCode == "" {
		lc.httpStat = http.StatusOK
	}

	row := lc.buildRow(u)
	if row.Cost > 0 && lc.key != nil {
		// The spend counters move with the charge so the next request's fast
		// path sees it (spec §7). They stay on the primary context: both are
		// best-effort counters with the durable DB aggregate behind them
		// (Limiter.SpendAdd, budgetSpent), so an expired context can
		// under-count a window but never leave usage unbilled.
		defer lc.h.limiter.SpendAdd(ctx,
			&limits.APIKeyIdentity{KeyID: lc.key.ID, Store: lc.h.store},
			row.Cost)
		defer lc.h.budgetSpendAdd(ctx, lc, row.Cost)
	}

	charge, err := lc.h.store.ChargeRequest(ctx, row)
	if err != nil {
		log.Printf("[proxy] charge failed for %s: %v", row.ID, err)
		// The ledger row is the priority: fall back to an insert that still
		// carries the credit_ledger entry, so a failed charge can never leave
		// balance_micro desynced from SUM(credit_ledger.amount_micro). Only if
		// THAT fails too is the request invisible.
		//
		// The fallback needs a context of its own. The only realistic reason
		// ChargeRequest fails is that ctx expired, and an expired context never
		// revives — reusing it made this branch unreachable for the one failure
		// it exists to repair (Begin(ctx) fails instantly, after the client
		// already has its 200). Not Background(): the write stays bounded.
		//
		// It RETRIES, because one fresh context is not enough when the pool is
		// saturated: the retry re-queues behind the same 128 waiters and can
		// expire again. Measured 2026-10-31 at 128 workers against a
		// 20-connection pool: 268 charge failures, of which the single-shot
		// fallback saved 160 and lost 108 — 108 requests answered 200 and were
		// never billed. Each attempt gets its own fresh budget, so a retry that
		// waited out the queue still has time to write. The row is idempotent
		// (request_log `on conflict (id) do nothing`, ledger keyed
		// `usage:<request id>`), so a retry that races a slow first attempt
		// cannot double-charge.
		//
		// Bounded by ledgerWriteDeadline, not by an attempt count: a fixed
		// count made the loss a function of queue depth, and the queue has no
		// fixed size. The goroutine is already past the client's response.
		//
		// What the extra attempts cost is CONNECTION-SECONDS, not goroutines
		// (see the COST note on ledgerWriteDeadline): each attempt holds a pool
		// connection for its whole budget, and the pool is shared with the
		// request path. Hence the 1s retry budget and the writer cap below.
		//
		// DETACHED, because that reasoning was false as written. Every call
		// site is `defer lc.finish()` or an inline `lc.finish()` on the
		// REQUEST goroutine (proxy.go:366, stream.go:127, anthropic.go:121,
		// gemini.go:242, generic.go:166), and a deferred call runs before the
		// handler returns — so the sleeps held the client's connection open.
		// Measured 2026-11-01: BenchmarkStreamSSE_CopyLoopOnly = 754ms/op,
		// exactly 250ms+500ms of backoff plus three refused dials, against a
		// benchmark comment claiming the write "fails fast (~1ms)". At the
		// 150 rps target that pins 113 concurrent connections doing nothing
		// (Little's Law: 150 × 0.754s), 28% of the 400-concurrent budget.
		//
		// Safe to detach: the row is idempotent (request_log `on conflict (id)
		// do nothing`, ledger keyed `usage:<request id>`), so a detached retry
		// racing a slow first attempt cannot double-charge. The context is
		// already WithoutCancel, so it survives the handler returning.
		lc.ledgerWG.Add(1)
		go func() {
			defer lc.ledgerWG.Done()

			// Bound OCCUPANCY, not rows: at most cap detached writers are inside
			// the retry loop at once. See acquireLedgerSlot for the two wrong
			// shapes (non-blocking shed, whole-loop hold) and why the slot is
			// per-attempt.
			//
			// A charge that failed for a reason draining cannot fix (constraint
			// violation, bad column) will produce the SAME error on the fallback
			// statement, so one attempt is the whole budget: retrying it would
			// hold a connection for five minutes to re-learn the same thing.
			hardFailure := !isRetryableChargeErr(err)
			window := ledgerWriteDeadline
			if hardFailure {
				window = ledgerWriteRetryBudget
			}
			deadline := time.Now().Add(window)
			backoff := ledgerWriteBackoff
			for attempt := 1; ; attempt++ {
				releaseSlot, acquired := lc.h.acquireLedgerSlot(lc.r.Context())
				if !acquired {
					n := lc.h.ledgerWritersShed.Add(1)
					log.Printf("[proxy] ledger write for %s shed after %v waiting for a slot: "+
						"%d/%d writers busy (total shed %d) — ROW LOST, raise pool size",
						row.ID, lc.h.ledgerWriterWait, len(lc.h.ledgerWriters),
						cap(lc.h.ledgerWriters), n)
					return
				}
				ledgerCtx, ledgerCancel := context.WithTimeout(
					context.WithoutCancel(lc.r.Context()), ledgerWriteRetryBudget)
				err2 := lc.h.store.InsertRequestLogWithLedger(ledgerCtx, row)
				ledgerCancel()
				releaseSlot()
				if err2 == nil {
					if attempt > 1 {
						log.Printf("[proxy] ledger write recovered for %s on attempt %d", row.ID, attempt)
					}
					writeAttempts(lc, row.ID)
					return
				}
				// Out of time, or the write failed for a reason a retry cannot
				// fix (a constraint violation re-queues identically forever).
				// A deadline failure is the queue being deep, which IS
				// retryable; anything else is not.
				remaining := time.Until(deadline)
				if hardFailure || remaining <= 0 || !isRetryableLedgerErr(err2) {
					if hardFailure {
						log.Printf("[proxy] ledger write for %s abandoned: charge failure is not "+
							"retryable (%v), fallback hit %v after %d attempt(s) — ROW LOST",
							row.ID, err, err2, attempt)
					} else {
						log.Printf("[proxy] request_log insert failed after %d attempts: %v", attempt, err2)
					}
					return
				}
				// Back off before re-queuing: an immediate retry lands behind
				// the same waiters and burns the next budget the same way.
				// Sleep no longer than the deadline allows, so the final
				// attempt still has time to acquire a connection.
				sleep := min(backoff, remaining)
				time.Sleep(sleep)
				backoff = min(backoff*2, ledgerWriteBackoffMax)
			}
		}()
	} else {
		// The charge succeeded, so the parent row is already durable on ctx.
		// The attempts still go to a detached goroutine: they are a forensic
		// trail, not something the client waits on, and the FK is satisfied.
		lc.ledgerWG.Add(1)
		go func() {
			defer lc.ledgerWG.Done()
			writeAttempts(lc, row.ID)
		}()
	}
	if charge != nil && !store.FreeAccessNoPaymentGateway && (charge.Warning || charge.HardStop) {
		// Free access: the balance thresholds gate nothing while there is no
		// payment gateway, so raiseLowBalance would pin a permanently firing
		// "low balance" incident on every active user the moment their
		// balance crossed $10 — noise, not signal. Restored with the gate.
		lc.h.raiseLowBalance(ctx, charge, row.UserID)
	}
}

// writeAttempts inserts one request_attempt row per routing attempt, after the
// parent request_log row is durable (request_attempt.request_id is an FK to it,
// migration 0006).
//
// Why it is its own function: it runs on the detached ledger goroutine, so the
// FK ordering is expressed by the call site rather than by a defer that would
// otherwise race the parent write. ONE round trip for the whole chain — this
// was a loop with one insert per attempt, so a request that fell over three
// candidates paid three sequential round trips after the client already had its
// answer, and a retry chain is exactly when the router is already behind.
//
// The budget matches the fallback's: a retry chain fits in one multi-row insert
// (maxAttemptsPerInsert=32 per round trip), so this is one statement against a
// lock the earlier writes already released. Not Background(): an unbounded
// write after the client has its bytes could still pin the goroutine forever.
// Rejected: a retry loop, an outbox, a queue, a config knob — the fresh context
// is the whole fix.
//
// The attempts get a context of their own, same shape as the fallback's. BUG
// they fix: the attempts reused ledgerCtx, so when the primary burned its
// budget the attempts inherited the fallback's context — already part-spent
// waiting behind the same saturated pool — and the pool-saturation probe
// measured 18/144 attempt rows lost vs 3/144 ledger rows (6x): the forensic
// trail a re-bill would follow died exactly when it was most needed.

// retryableSQLErrors are the SQLSTATEs a drain can fix. Everything else is a
// bug in the row or the schema: re-queuing it produces the identical error.
//
// Matched on the typed code, never on the error text. v1 searched the message
// for substrings like "40001", which classifies a row whose VALUE happens to
// contain those digits as retryable — a false positive that holds a connection
// for the whole deadline. `errors.As` on *pgconn.PgError reads the field the
// server actually sent.
var retryableSQLErrors = map[string]bool{
	"53300": true, // too_many_connections
	"40001": true, // serialization_failure
	"40P01": true, // deadlock_detected
	"57P01": true, // admin_shutdown
	"08006": true, // connection_failure
	"08003": true, // connection_does_not_exist
	"57014": true, // query_canceled (statement_timeout)
}

// transientNetErrs are the pre-connection failures, where no SQLSTATE exists.
var transientNetErrs = []string{
	"connection refused",
	"connection reset",
	"broken pipe",
	"i/o timeout",
	"connection closed",
}

// isRetryableErr reports whether a failed write is worth re-queuing: the queue
// was deep (context expiry), the server was momentarily out of slots or in a
// serialization conflict, or the connection died before the statement ran.
func isRetryableErr(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return true
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return retryableSQLErrors[pgErr.Code]
	}
	msg := err.Error()
	for _, s := range transientNetErrs {
		if strings.Contains(msg, s) {
			return true
		}
	}
	return false
}

// isRetryableLedgerErr applies the same rule to a fallback insert failure.
func isRetryableLedgerErr(err error) bool { return isRetryableErr(err) }

// isRetryableChargeErr answers the question the fallback loop actually needs:
// can a DRAIN fix the reason the primary charge failed? If not, the fallback
// statement will fail the same way, so there is no point retrying it for five
// minutes. This is what turns "retry until the deadline" into a bounded cost
// for rows that are simply wrong.
func isRetryableChargeErr(err error) bool { return isRetryableErr(err) }

func writeAttempts(lc *lifecycle, requestID string) {
	if len(lc.attempts) == 0 {
		return
	}
	rows := make([]*store.RequestAttempt, 0, len(lc.attempts))
	for _, a := range lc.attempts {
		rows = append(rows, attemptRow(requestID, a))
	}
	attemptsCtx, attemptsCancel := context.WithTimeout(
		context.WithoutCancel(lc.r.Context()), ledgerWriteBudget)
	defer attemptsCancel()
	if err := lc.h.store.InsertRequestAttempts(attemptsCtx, rows); err != nil {
		log.Printf("[proxy] request_attempt insert failed: %v", err)
	}
}

// buildRow assembles the spec §8 request_log row from the lifecycle state.
func (lc *lifecycle) buildRow(u usageCounts) *store.RequestLog {
	row := &store.RequestLog{
		ID:        lc.requestID,
		Endpoint:  lc.endpoint,
		Stream:    lc.stream,
		Attempts:  max(len(lc.attempts), 1),
		Timing:    lc.timing,
		Currency:  "USD",
		LatencyMs: time.Since(lc.start).Milliseconds(),
	}
	if lc.key != nil {
		row.UserID = lc.key.UserID
		row.APIKeyID = lc.key.ID
	}
	row.ClientIP = clientIP(lc.r)
	row.ClientDisconnected = lc.clientDisconnected
	row.RequestedModel = lc.requested
	row.RoutingPolicyID = lc.polID
	if lc.pol != nil {
		row.Strategy = lc.pol.Strategy
	}
	if lc.resolved != nil {
		row.ModelID = firstOf(lc.resolved.ModelIDs)
	}
	if w := lc.winner(); w != nil && w.Candidate != nil {
		row.ModelID = w.Candidate.Store.ModelID
		row.ProviderModelID = w.Candidate.Store.ProviderModelID
		row.ProviderID = w.Candidate.Store.ProviderID
		row.ConnectionID = w.Candidate.Store.ConnectionID
		if w.CredentialID != "" {
			row.CredentialID = w.CredentialID
		}
		if w.TTFTMs != nil {
			row.TTFTMs = w.TTFTMs
		}
		// spec §8 timing["connection"]: time to the upstream's response headers
		// on the winning exchange (body time is `generation`).
		lc.timing["connection"] = w.LatencyMs
	}
	if lc.streamTTFT != nil {
		row.TTFTMs = lc.streamTTFT
	}

	row.TokensIn, row.CachedInputTokens, row.TokensOut, row.ReasoningTokens = u.TokensIn, u.CachedInputTokens, u.TokensOut, u.ReasoningTokens
	row.TokensSaved = lc.tokensSaved
	if lc.usageSeen {
		total := u.TotalTokens
		if total == 0 {
			total = u.TokensIn + u.TokensOut
		}
		row.TotalTokens = &total
	}
	// total_tokens NULL = the provider did not report (PRD §122).

	// Price snapshot (spec §6): the version effective at request start, frozen
	// into the row so a later price change never rewrites history. Resolved
	// under the DETACHED context: the client may already be gone, and the
	// snapshot must still land.
	if p := lc.resolvePricing(); p != nil {
		row.PricingRuleID = p.RuleID
		if !p.Legacy {
			row.InputPriceMicro = strPtr(p.InputStr)
			row.OutputPriceMicro = strPtr(p.OutputStr)
			if p.CachedStr != "" {
				row.CachedInputPriceMicro = strPtr(p.CachedStr)
			}
			if p.ReasonStr != "" {
				row.ReasoningPriceMicro = strPtr(p.ReasonStr)
			}
		}
		in, cached, out, reason := p.BillablePrices()
		// Four token classes at their own price (spec §6 NULL fallbacks).
		row.Cost = cost.ComputeUsage(
			u.TokensIn-u.CachedInputTokens, u.CachedInputTokens,
			u.TokensOut-u.ReasoningTokens, u.ReasoningTokens,
			in, cached, out, reason)
		if row.Cost < 0 {
			row.Cost = 0
		}
		// No per-provider price list exists yet, so the provider cost is the
		// same number (0007's precedent: "a snapshot, not a lie").
		row.ProviderCostMicro = row.Cost
	}

	row.Status = lc.status
	if row.Status == "" {
		row.Status = "success"
	}
	if lc.clientDisconnected {
		row.Status = "cancelled"
	}
	row.ErrorCode = lc.errCode
	// Raw upstream text goes in `error`, never to the client (spec §8).
	row.Error = lc.rawErr
	if row.Error == "" {
		row.Error = lc.errMsg
	}
	if lc.httpStat != 0 {
		s := lc.httpStat
		row.HTTPStatus = &s
	}
	row.FallbackUsed = len(lc.attempts) > 1
	return row
}

// attemptRow maps one routing attempt onto its spec §8 request_attempt row.
func attemptRow(requestID string, a *routing.Attempt) *store.RequestAttempt {
	at := &store.RequestAttempt{
		ID:         ids.New("rta"),
		RequestID:  requestID,
		Attempt:    a.Attempt,
		Reason:     a.Reason,
		StartedAt:  a.StartedAt,
		FinishedAt: a.FinishedAt,
		LatencyMs:  a.LatencyMs,
		TTFTMs:     a.TTFTMs,
		Metadata:   map[string]any{},
	}
	if a.Candidate != nil && a.Candidate.Store != nil {
		at.ProviderID = a.Candidate.Store.ProviderID
		at.ConnectionID = a.Candidate.Store.ConnectionID
		at.ProviderModelID = a.Candidate.Store.ProviderModelID
		at.Metadata["upstream_model"] = a.Candidate.Store.UpstreamModel
		at.Metadata["model_slug"] = a.Candidate.Store.ModelSlug
	}
	if a.CredentialID != "" {
		at.CredentialID = a.CredentialID
	}
	if a.HTTPStatus != 0 {
		s := a.HTTPStatus
		at.HTTPStatus = &s
	}
	if a.ErrorCode != "" {
		at.ErrorCode = a.ErrorCode
	}
	retryable := a.Retryable
	at.Retryable = &retryable
	if a.RawMessage != "" {
		at.Metadata["upstream_error"] = truncate(a.RawMessage, 500)
	}
	return at
}

// readUpstreamBody reads the winning exchange's buffered body and records
// timing["generation"] — the upstream's body time, which spec §8 defines as the
// generation phase for a non-streaming call.
//
// Why this exists: the streaming path records `generation` (stream.go) but the
// buffered path recorded NOTHING for it. Measured on a successful non-streaming
// request, the stored map was `auth:21 rate_limit:6 routing:10 queue:0
// connection:0` — no generation, the one phase that is most of a buffered call.
// A dashboard reading that column reports zero for the largest phase instead of
// reporting a gap, and the three handlers each did their own io.ReadAll, so
// there was no single place that could have recorded it.
//
// The 50MiB bound is unchanged; it is the ceiling all three call sites used.
// isEventStream reports whether an upstream response is an SSE stream. The
// sniff must never drain one: the body is the client's live answer, and reading
// it here would consume the bytes before they are relayed.
func isEventStream(resp *http.Response) bool {
	return resp != nil && strings.Contains(resp.Header.Get("Content-Type"), "event-stream")
}

func (lc *lifecycle) readUpstreamBody(resp *http.Response) ([]byte, error) {
	start := time.Now()
	defer func() { lc.timing["generation"] = lc.timing["generation"] + time.Since(start).Milliseconds() }()
	return io.ReadAll(io.LimitReader(resp.Body, 50<<20))
}

// readUpstreamBodyBounded is readUpstreamBody with a hard ceiling: a timer
// CLOSES the body when genericTimeout fires, which is the only lever that stops
// a stalled read without cancelling a context the response depends on.
//
// It exists because the 2xx error-envelope sniff runs inside exchange(), BEFORE
// any surface arms its own body-read bound. The request context does not save
// the read either: on the generic surface it is the CLIENT's own connection,
// which a stalled upstream never ends. Without this, serving `HTTP 200` and then
// never sending the body parked the handler indefinitely — measured:
// TestGenericBodyReadIsBounded saw ServeGeneric outlive a 500ms bound by 20s+
// once the sniff began draining the body that early.
func (lc *lifecycle) readUpstreamBodyBounded(resp *http.Response) ([]byte, error) {
	t := time.AfterFunc(genericTimeout, func() { _ = resp.Body.Close() })
	defer t.Stop()
	return lc.readUpstreamBody(resp)
}

// serveBuffered relays a buffered upstream body and records the outcome.
func (lc *lifecycle) serveBuffered(w http.ResponseWriter, respBody []byte, hdr http.Header) {
	copyUpstreamHeaders(w, hdr)
	if w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", "application/json")
	}
	lc.usage, lc.usageSeen = parseUsage(respBody)
	if lc.usageSeen {
		lc.errCode, lc.status = "", "success"
	} else {
		lc.status = "success"
	}
	lc.setResponseHeaders()
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(respBody)
	lc.finish()
}

// logTarget records the upstream status of the winning exchange's transport
// phase (kept separate from the attempt rows so a stream's status is known
// before its body ends).
func (lc *lifecycle) logTarget(status int) {
	if len(lc.attempts) == 0 {
		return
	}
	last := lc.attempts[len(lc.attempts)-1]
	if last.HTTPStatus == 0 {
		last.HTTPStatus = status
	}
}

// dispatch runs the routing walk for one request body against the connection
// network. `path` is the upstream path (chat/completions for the native
// endpoint, or the client's own /v1-stripped path for the generic one).
func (lc *lifecycle) dispatch(ctx context.Context, upBody []byte, method, rawQuery, upstreamPath string) (*http.Response, error) {
	if len(lc.cands) == 0 {
		// No model resolution (non-model endpoint): pick nothing to route.
		return nil, fmt.Errorf("no routable target")
	}

	// One injection per request, before the attempt loop: a retry inside
	// attempt() reuses the same body, so injecting in exchange() would
	// prepend the prompt once per upstream try.
	if lc.unrestricted {
		upBody = injectUnrestricted(upBody)
	}
	// Operator injections apply after the unrestricted persona so a
	// model-scoped prepend lands closest to the conversation; both are applied
	// once, before the attempt loop, because a retry reuses this body.
	if len(lc.injections) > 0 {
		upBody = applyInjections(upBody, lc.injections)
	}

	attemptFn := func(attemptCtx context.Context, cand *routing.Candidate, next, budget int) []*routing.Attempt {
		return lc.attempt(attemptCtx, cand, next, budget, upBody, method, rawQuery, upstreamPath)
	}
	res := routing.Execute(ctx, lc.cands, *lc.pol, lc.deadline, lc.h.breaker, attemptFn)
	lc.attempts = res.Attempts

	if res.Winner != nil {
		if resp, ok := res.Winner.Payload.(*http.Response); ok {
			return resp, nil
		}
		return nil, fmt.Errorf("no response payload")
	}
	if len(res.Attempts) == 0 {
		return nil, fmt.Errorf("request deadline reached before any attempt could start")
	}
	return nil, fmt.Errorf("every candidate failed: %s", res.LastErrorCode)
}

// attempt is ONE candidate's exchange loop: it rotates the connection's
// credential rows (spec §4) and records every real upstream exchange as its own
// attempt (spec §8) until one succeeds, the attempt budget runs out, or the
// failure is request-shaped (spec §9). routing.Execute renumbers the rows and
// enforces the total budget; `n` is the loop's first attempt number.
func (lc *lifecycle) attempt(ctx context.Context, cand *routing.Candidate, n, budget int, upBody []byte, method, rawQuery, upstreamPath string) []*routing.Attempt {
	var out []*routing.Attempt
	// Rotate this candidate's credential accounts ONCE (spec §4), then hand the
	// remaining attempt budget to the next candidate. Without this a provider
	// that 429s/402s every account drains MaxAttempts here and the fallback
	// candidate is never reached (measured: gonka24 draining all 6 attempts at
	// ~4s each — 25s — while a healthy dahl sat unused).
	maxTries := 8
	if t := lc.h.targetFor(cand); t != nil && t.pool != nil {
		if pn := t.pool.Len(); pn > 0 && pn < maxTries {
			maxTries = pn
		}
	}
	// The budget Execute computed for THIS candidate: it already subtracted one
	// attempt per still-viable candidate behind this one, so a pool deeper than
	// the walk's whole MaxAttempts (8 zro accounts vs max_attempts=6) can no
	// longer starve the fallback. pool.Len() alone was not enough — it is the
	// smaller ceil only when the pool is smaller than the reserve.
	if budget > 0 && budget < maxTries {
		maxTries = budget
	}
	for i := 0; i < maxTries; i++ {
		if err := ctx.Err(); err != nil {
			break
		}
		if lc.pol != nil && len(lc.attempts)+len(out) >= lc.pol.MaxAttempts {
			break
		}
		// Always allow the FIRST try on a candidate even when its p95 estimate
		// overshoots the deadline (Execute's last-resort pass relies on this);
		// later tries still respect the deadline.
		if i > 0 && !lc.deadline.IsZero() && time.Now().Add(estimateFor(cand)).After(lc.deadline) {
			break // spec §9: never start an attempt that cannot finish
		}
		a := lc.exchange(ctx, cand, n+len(out), upBody, method, rawQuery, upstreamPath)
		out = append(out, a)
		if a.ErrorCode == "" || !a.Retryable {
			break
		}
	}
	if len(out) == 0 {
		a := &routing.Attempt{Attempt: n, Candidate: cand, Reason: cand.Reason(), StartedAt: time.Now()}
		a.ErrorCode, a.Retryable = routing.ErrCodeProviderTimeout, true
		a.RawMessage = "request deadline reached before an attempt could start"
		a.FinishedAt = time.Now()
		a.LatencyMs = a.FinishedAt.Sub(a.StartedAt).Milliseconds()
		out = append(out, a)
	}
	return out
}

// estimateFor is the candidate's p95 latency estimate (ms) used by the attempt
// loop's deadline check — the same signal routing.Execute's budget check uses.
func estimateFor(cand *routing.Candidate) time.Duration {
	if cand == nil || cand.LatencyMs <= 0 {
		return 300 * time.Millisecond
	}
	return time.Duration(cand.LatencyMs) * time.Millisecond
}

// exchange performs ONE upstream exchange and classifies it (spec §9). The
// attempt it returns is one request_attempt row.
func (lc *lifecycle) exchange(ctx context.Context, cand *routing.Candidate, n int, upBody []byte, method, rawQuery, upstreamPath string) *routing.Attempt {
	a := &routing.Attempt{Attempt: n, Candidate: cand, Reason: cand.Reason(), StartedAt: time.Now()}

	target := lc.h.targetFor(cand)
	if target == nil {
		a.ErrorCode, a.Retryable = routing.ErrCodeProviderUnavailable, true
		a.FinishedAt = time.Now()
		a.LatencyMs = a.FinishedAt.Sub(a.StartedAt).Milliseconds()
		return a
	}
	// Source-IP throttle gate (connlimit.go): an upstream that allows ~2
	// requests per 5s from one address is not failing, it is full. Skipping the
	// candidate HERE — before a 429 is ever emitted — keeps the response honest
	// and leaves the budget for a provider that can actually serve it.
	if target.rateRPM > 0 && !lc.h.connLim.admitWait(ctx, target.connID,
		specFor(target.rateRPM, target.rateBurst, target.rateWindowMs), 10*time.Second) {
		a.ErrorCode, a.Retryable = routing.ErrCodeRateLimited, false
		a.RawMessage = "connection pacing gate: no local rate token within budget"
		a.FinishedAt = time.Now()
		a.LatencyMs = 0
		return a
	}
	pickStart := time.Now()
	pickCtx, cancel := context.WithTimeout(ctx, pickBudget)
	picked, err := target.pool.Pick(pickCtx)
	cancel()
	// spec §8 timing["queue"]: time spent waiting for a usable upstream account.
	lc.timing["queue"] += time.Since(pickStart).Milliseconds()
	if err != nil {
		// Log it: a PROVIDER_UNAVAILABLE with no diagnostic is indistinguishable
		// from a provider outage, and the pool's own reason ("all 6,426
		// account(s) unusable: ...") is the only thing that says whether the
		// cause is a dead key, a parked key, or a walk that ran out of budget.
		lc.h.notePickFailure(cand, err)
		a.ErrorCode, a.Retryable = routing.ErrCodeProviderUnavailable, true
		a.RawMessage = err.Error()
		a.FinishedAt = time.Now()
		a.LatencyMs = a.FinishedAt.Sub(a.StartedAt).Milliseconds()
		return a
	}

	a.CredentialID = picked.CredID
	// The upstream must see the provider's OWN model id, never the name the
	// client asked for: a virtual (`fudrouter/auto`) or an alias resolves to a
	// concrete canonical model, and even a canonical slug can be served under a
	// different upstream id (provider_model.provider_model_id). Sending the
	// client's string verbatim made every virtual fail upstream with "model not
	// found" while the same slug called directly worked.
	upBody = rewriteModelField(upBody, cand.Store.UpstreamModel)

	// Native protocols are not OpenAI-compatible HTTP. Cloudflare AI
	// Playground answers over an anonymous `cf_agent` WebSocket, so its
	// exchange is synthesized here and handed back as a normal response.
	if strings.EqualFold(target.protocol, "cfp") {
		return lc.exchangeCFP(ctx, cand, a, upBody, target)
	}

	upURL := strings.TrimRight(cand.Store.BaseURL, "/") + upstreamPath
	if rawQuery != "" {
		upURL += "?" + rawQuery
	}
	reqCtx := ctx
	if lc.cancelUpstream == nil && !lc.stream {
		var cancelReq context.CancelFunc
		reqCtx, cancelReq = context.WithTimeout(ctx, nonStreamTimeout)
		defer cancelReq()
	}
	ct := lc.r.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/json"
	}
	// newUpReq rebuilds the upstream request from the still-unconsumed body
	// bytes. http.Request.Body is a single-use reader, so a rotation retry must
	// build a NEW request instead of replaying an exhausted one — that mistakes
	// silently fails every keyless call after its first send.
	newUpReq := func(c context.Context) (*http.Request, error) {
		req, rerr := http.NewRequestWithContext(c, method, upURL, bytes.NewReader(upBody))
		if rerr != nil {
			return nil, rerr
		}
		req.Header.Set("Content-Type", ct)
		// A keyless connection carries a placeholder secret. Sending it would be
		// worse than sending nothing: anonymous endpoints such as OVHcloud AI
		// Endpoints answer 403 "authentication failed" to ANY request carrying an
		// Authorization header, which would park a credential doing its job.
		if target.authKind != "noauth" {
			req.Header.Set("Authorization", "Bearer "+picked.Token)
		}
		for k, v := range target.defaultHeaders {
			if reservedHeaders[strings.ToLower(k)] {
				continue
			}
			req.Header.Set(k, v)
		}
		return req, nil
	}

	// Per-SOURCE-IP rejections are not provider outages.
	//
	// Keyless upstreams bill and throttle the ADDRESS, not a credential:
	// pollinations answers 402 INSUFFICIENT_CREDITS when one /128 is out of x402
	// credits, OVH answers 429 when one address passes its window. Treating that
	// as "the provider is dead" parked a placeholder credential (taking 13 OVH
	// models down), tripped a per-connection breaker, and collapsed a lane able
	// to serve ~200 rps to 0.5 rps — all from ONE spent address. So: burn that
	// address, dial from a different /128, and try again.
	sendAttempts := 1
	keyless := keylessAuth(target.authKind)
	if keyless && target.egress.Mode != egress.Direct {
		sendAttempts = 3
	}
	var resp *http.Response
	var route *egress.Route
	var tracker *ipTracker
	for attempt := 0; attempt < sendAttempts; attempt++ {
		route, err = lc.h.prepareEgress(target.egress, picked.CredID)
		if err != nil {
			a.ErrorCode, a.Retryable = routing.ErrCodeProviderUnavailable, true
			a.RawMessage = err.Error()
			a.FinishedAt = time.Now()
			a.LatencyMs = a.FinishedAt.Sub(a.StartedAt).Milliseconds()
			return a
		}
		attemptCtx := reqCtx
		tracker = nil
		if keyless || route != nil {
			attemptCtx, tracker = withIPTracker(reqCtx)
		}
		upReq, rerr := newUpReq(attemptCtx)
		if rerr != nil {
			a.ErrorCode, a.Retryable = routing.ErrCodeInternalError, false
			a.RawMessage = rerr.Error()
			return a
		}
		if route != nil {
			resp, err = route.Client.Do(upReq)
		} else if keyless {
			resp, err = rotatingClient().Do(upReq)
		} else {
			resp, err = lc.h.client.Do(upReq)
		}
		if err != nil {
			// A transport error is a hard PROVIDER_UNAVAILABLE and currently leaves
			// no trace anywhere: the response body says "provider unavailable" and
			// the operator cannot tell a refused socket from a TLS failure or a
			// pool exhausted by keep-alive limits.
			lc.h.notePickFailure(cand, err)
			a.Transport = err
			a.ErrorCode, a.Retryable = routing.ErrCodeProviderUnavailable, true
			a.RawMessage = err.Error()
			a.FinishedAt = time.Now()
			a.LatencyMs = a.FinishedAt.Sub(a.StartedAt).Milliseconds()
			return a
		}
		success := resp.StatusCode >= 200 && resp.StatusCode < 300
		perIP := resp.StatusCode == 402 || resp.StatusCode == 429
		// Retire even the LAST rejected source. The old last-attempt break
		// skipped Burn, so the next request could inherit precisely the address
		// that exhausted this request's three anonymous retries.
		if route != nil {
			route.Reject(tracker.get(), resp.StatusCode)
		} else if keyless && perIP {
			sourceip.Burn(tracker.get(), egress.BurnDuration(resp.StatusCode))
			// On the last attempt classification below closes Body; dropping
			// idle sockets before that would miss the socket it returns.
			defer dropIdleConnections()
		}
		if success || !perIP || attempt == sendAttempts-1 {
			break
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 8<<10))
		_ = resp.Body.Close()
		// The transport pools sockets: without this the "retry" reuses the very
		// connection (and source address) that was just rejected.
		dropIdleConnections()
		resp = nil
	}
	a.FinishedAt = time.Now()
	a.LatencyMs = a.FinishedAt.Sub(a.StartedAt).Milliseconds()
	if resp == nil {
		a.ErrorCode, a.Retryable = routing.ErrCodeProviderUnavailable, true
		a.RawMessage = "upstream rejected every rotated source address"
		return a
	}
	a.HTTPStatus = resp.StatusCode
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		// A 2xx is NOT automatically a completion. Some upstreams answer a
		// throttled/exhausted account with HTTP 200 and an error envelope in
		// the body — tokenharbor.ai, proved live 2026-11-02:
		// 200 {"error":{"message":"Per-minute rate limit reached","code":
		// "rate_limit_exceeded"}}. Trusting the status alone made every one of
		// those a terminal SUCCESS: the walk stopped, so no failover ran; the
		// ledger recorded status='success'; and the client was handed the
		// refusal as if it were an answer. The body is sniffed BEFORE the
		// success is recorded, so an envelope becomes a retryable attempt and
		// the walk moves to a funded sibling.
		//
		// Only a buffered NON-stream response can be sniffed: a stream's answer
		// is an SSE body the upstream has not produced yet (its refusals
		// surface mid-stream), and reading it here would consume the very bytes
		// the client is waiting for.
		//
		// The check must be on the RESPONSE too, not just lc.stream: lc.stream is
		// derived from the client's request (its body's `stream` flag, or a
		// request Content-Type of event-stream), while the generic surface
		// additionally promotes to streaming when the UPSTREAM answers
		// text/event-stream — a decision it only makes after dispatch, below.
		// A client that asked for JSON but hit an upstream that streams anyway
		// therefore looks non-stream here, and sniffing it drained the live
		// stream: measured, TestGenericEventStreamIsNotTruncated saw the client
		// get application/json (an empty buffered answer) instead of the 12
		// events the upstream sent. Skipping on either signal is correct —
		// neither surface buffers a response it means to stream.
		if !lc.stream && !isEventStream(resp) && !strings.EqualFold(target.protocol, "cfp") {
			body, rerr := lc.readUpstreamBodyBounded(resp)
			_ = resp.Body.Close()
			if rerr != nil {
				// The 2xx headers arrived but its body did not: a torn
				// connection, not an answer. Retryable — Pick() rotates.
				a.ErrorCode, a.Retryable = routing.ErrCodeUpstreamError, true
				a.RawMessage = "read upstream body: " + rerr.Error()
				return a
			}
			if code, isEnv := routing.ErrorEnvelope(body); isEnv {
				ecode, retryable := routing.ClassifyErrorCode(code, body)
				a.ErrorCode, a.Retryable = ecode, retryable
				a.RawMessage = upstreamMessage(body)
				// A provider returning its 429 as HTTP 200 must not retain an
				// explicitly sticky identity just because the envelope is buffered.
				if route != nil && ecode == routing.ErrCodeRateLimited {
					route.Reject(tracker.get(), http.StatusTooManyRequests)
				} else if route != nil && (ecode == routing.ErrCodeAuthError || ecode == routing.ErrCodeAuthorization) {
					route.Reject(tracker.get(), http.StatusForbidden)
				}
				// A per-account 2xx refusal is THIS account's throttle: with a
				// sibling key the next Pick() may succeed. A single-account pool
				// keeps the honest terminal answer — retrying it would only burn
				// the budget on the same deterministic reply.
				if ecode == routing.ErrCodeRateLimited && target.pool != nil && target.pool.Len() > 1 {
					a.Retryable = true
				}
				if !a.Retryable {
					// Terminal: leave Payload nil. The walk surfaces this
					// attempt as the last failure and dispatch returns an
					// error, so fail() answers the client with the normalized
					// envelope built from this attempt's ErrorCode — the same
					// path a non-retryable non-2xx body takes. The raw envelope
					// is NOT relayed: the router never relays a provider body
					// on a failure path (writing the already-read body again
					// would also close an exhausted reader).
					return a
				}
				// Park the throttled key for the pool's short cooldown. Guarded
				// on keyless exactly like the non-2xx path below: a keyless row
				// has no secret to reject and no sibling to rotate to, so
				// MarkFailed would empty the only "account" the row has.
				if !keylessAuth(target.authKind) {
					target.pool.MarkFailed(picked.Token)
				}
				return a
			}
			// A genuine completion: hand the read body back through a
			// response-shaped payload so the buffered surfaces (they consume
			// *http.Response and read .Body) keep working unchanged.
			resp = &http.Response{
				StatusCode: resp.StatusCode,
				Header:     resp.Header,
				Body:       io.NopCloser(bytes.NewReader(body)),
			}
		}
		// A 2xx proves this credential works right now; record it (F3, see
		// reviveCredential) so a transient-401 park does not cost up to an hour
		// of capacity while the hourly probe is still a fan-out away.
		//
		// Gated on the row's status (R3): an already-healthy row is the common
		// case, and rewriting it on every 200 adds a DB round trip per success
		// for nothing — measured under 32x pool oversubscription, the
		// unconditional write starved the ledger's own writes (load_test.go).
		// Only a row that is NOT healthy (parked 'invalid', a 'rate_limited'
		// whose cooldown lapsed) needs the flip.
		if a.CredentialID != "" && !keylessAuth(target.authKind) &&
			credentialStatus(cand, a.CredentialID) != "healthy" {
			lc.h.reviveCredential(a.CredentialID)
		}
		a.Payload = resp
		return a
	}

	// Non-2xx: capture the body for the record (and the client message), then
	// classify per spec §9.
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	_ = resp.Body.Close()
	code, retryable := routing.ClassifyUpstream(resp.StatusCode)
	// An upstream that cannot DESERIALIZE a body is reporting its own parser's
	// defect, not a malformed client request: ServeCompletions already parsed
	// this body as JSON before dispatch, and a captured copy of exactly these
	// bytes (2026-11-03, prv_tokenjuice) contained no duplicate keys at all
	// while the upstream claimed `duplicate field reasoning_content`. A
	// non-retryable INVALID_REQUEST therefore fails the client for a provider
	// bug a sibling candidate would serve — so walk on instead. Bounded by the
	// normal attempt budget; if every candidate rejects it the client still
	// gets the same honest 400.
	if resp.StatusCode == http.StatusBadRequest &&
		(bytes.Contains(body, []byte("deserialize")) || bytes.Contains(body, []byte("duplicate field"))) {
		retryable = true
	}
	// A per-IP budget rejection survived every rotation: another candidate
	// (a different provider) may still serve this request, so let the router
	// walk on instead of failing the client here.
	if keyless && (resp.StatusCode == 402 || resp.StatusCode == 429) {
		retryable = true
	}
	// A 404 from ONE upstream account is not proof the model is gone.
	// Pools gate models per account — proved on tokenharbor, where
	// mimo-v2.6-flash:free answers 404 "This model is unavailable right
	// now" on throttled accounts and 200 on the rest of the same pool,
	// so the round-robin landing on a throttled account killed every
	// request that a neighbouring account would have served. With more
	// than one account the next Pick() rotates to a different one, so
	// the walk continues; a single-account pool keeps the honest
	// non-retryable 404, because retrying it would only burn the attempt
	// budget on the same deterministic answer. The parked account
	// (MarkFailed below) keeps the next request off it for failCooldown;
	// no DB cooldown is written — the account is healthy for the pool's
	// other models, the throttle is per-model.
	if resp.StatusCode == 404 && code == routing.ErrCodeModelNotFound && target.pool.Len() > 1 {
		retryable = true
	}
	// The same per-account contract for a SPENT account. A 402 from ONE account
	// is that account's budget, not the provider's: the next Pick() rotates to
	// a sibling that may still be funded. Measured on prv_zro (2026-10-30) with
	// a two-account pool holding one spent key: 6/6 requests failed (5x402 +
	// 503) before this row escalated — the same pool answered 8/8 200 with the
	// existing per-account rotation once it did. A single-account pool keeps the
	// honest non-retryable answer: retrying it would only burn the attempt
	// budget on the same deterministic response.
	//
	// Keyed on the STATUS, not on the taxonomy code. It used to test
	// `code == ErrCodeInsufficientCredits`, which coupled this rotation to the
	// client-facing classification — and that classification was wrong: an
	// upstream 402 is the PROVIDER's quota, so the client was told
	// INSUFFICIENT_CREDITS (their own balance) when their balance was untouched.
	// ClassifyUpstream now answers UPSTREAM_ERROR for a 402; the rotation is a
	// property of the status and must not depend on which code we report.
	if resp.StatusCode == 402 && target.pool.Len() > 1 {
		retryable = true
	}
	a.ErrorCode, a.Retryable = code, retryable
	a.RawMessage = upstreamMessage(body)
	// A 402 carries its body even though it is retryable: when the walk ends
	// here (a single-account pool, or every candidate spent) the client must
	// still see the provider's own message inside the normalized envelope. The
	// retryable flag decides whether the walk CONTINUES; it must not decide
	// whether the terminal answer has a body.
	if resp.StatusCode == 402 {
		a.Payload = &errorBody{status: resp.StatusCode, body: body}
	}
	// A keyless row has no secret to reject and no sibling to rotate to: the
	// placeholder IS the pool, so MarkFailed empties it (every following request
	// answers PROVIDER_UNAVAILABLE in microseconds) and a DB cooldown takes the
	// whole connection off the catalogue for a minute. Neither is true — the
	// address was spent, and the loop above already rotated away from it.
	if retryable && !keylessAuth(target.authKind) {
		// A rejected credential is parked so the next request picks another
		// (S0 behaviour, spec §5 credential state).
		target.pool.MarkFailed(picked.Token)
		// A keyless row has no real secret to reject: a 401/403 here is the
		// upstream refusing the shape of the request, not a bad credential, so
		// parking it would take a working provider off the catalogue.
		//
		// 2026-10-31: parked as 'invalid', NOT 'auth_failed'. The picker filter
		// is `status not in ('disabled','invalid')`, so an 'auth_failed' row
		// whose 5-minute cooldown expired came straight BACK into rotation:
		// prv_mistral accumulated 998 of them, ~96% of picks landed on a dead
		// key, the attempt budget burned out on 401s and the client got 502
		// while 33 live keys sat idle in the same pool. A 401/403 is a dead
		// credential, and 'invalid' is the only status the picker honours as
		// dead. Re-probed a 200-row sample -> 100% 401, zero false positives;
		// a later probe can still revive a key ('invalid' -> 'unknown' on a
		// 200), so this is not a one-way door.
		if (resp.StatusCode == 401 || resp.StatusCode == 403) && !keylessAuth(target.authKind) {
			lc.h.parkCredential(a.CredentialID, "invalid", 0)
		} else if resp.StatusCode == 429 {
			// Honour the upstream's own Retry-After when it sends one. The
			// field was declared and relayed to the client but never SET, so
			// every 429 parked for the 60s default: a provider answering
			// `retry-after: 3600` was retried 60x too early and one answering
			// `retry-after: 5` was benched 12x too long. parseRetryAfter
			// returns 0 for an absent or unusable hint, which parkCredential
			// reads as the 60s default — so this is strictly additive.
			//
			// 2026-11-03: an exhausted BALANCE also arrives as 429 here
			// ("Token balance exhausted... insufficient credit balance"), and
			// a throttle bench is a lie for it: the row came back every 60s
			// and burned 51 attempts in an hour (measured) while fresh keys
			// in the same pool went unused. A 429 whose BODY says the balance
			// is gone is the same permanent fact classify402 handles for 402s,
			// so it takes the same 'invalid' exit. The markers are specific
			// billing strings; a bare retry-after throttle is untouched.
			if permanentQuotaFailure(body) {
				lc.h.parkCredential(a.CredentialID, "invalid", 0)
			} else {
				a.RetryAfterSeconds = parseRetryAfter(resp.Header.Get("Retry-After"))
				lc.h.parkCredential(a.CredentialID, "rate_limited", a.RetryAfterSeconds)
			}
		} else if resp.StatusCode == 402 {
			// Out of credits is a budget fact, not a momentary throttle: park
			// the row long enough that the pool stops re-serving it (and stops
			// burning a rotation on it) instead of waiting for the next request
			// to rediscover it.
			//
			// The bench length comes from the BODY, not a constant. Free-tier
			// providers return two different 402s: a daily cap that clears at a
			// wall-clock reset ("used today's Free usage. It resets in 2h 11m")
			// and a permanent plan exhaustion ("used all your included credits").
			// A blanket 15-minute bench retried the first 9x before it could
			// possibly work and resurrected the second forever. classify402
			// reads the body: daily -> park until the reset it names, permanent
			// -> 'invalid' so the picker stops selecting it at all.
			if secs, permanent := classify402(body); permanent {
				lc.h.parkCredential(a.CredentialID, "invalid", 0)
			} else {
				lc.h.parkCredential(a.CredentialID, "rate_limited", secs)
			}
		}
	} else if resp.StatusCode != 402 {
		a.Payload = &errorBody{status: resp.StatusCode, body: body}
	}
	return a
}

// rewriteModelField returns body with its top-level "model" set to name. It is
// how a resolved candidate's upstream id reaches the provider. Bodies that are
// not JSON objects, or that carry no "model" key, pass through untouched, so a
// non-model endpoint is never rewritten.
func rewriteModelField(body []byte, name string) []byte {
	if name == "" {
		return body
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(body, &m); err != nil {
		return body
	}
	if _, ok := m["model"]; !ok {
		return body
	}
	enc, err := json.Marshal(name)
	if err != nil {
		return body
	}
	m["model"] = enc
	out, err := json.Marshal(m)
	if err != nil {
		return body
	}
	return out
}

// errorBody carries a non-retryable upstream failure's body so the client can
// still see the provider's own message inside the normalized envelope.
type errorBody struct {
	status int
	body   []byte
}

// upstreamMessage extracts the provider's own error message from a body, for
// the client-facing message (never the CODE — spec §8).
func upstreamMessage(body []byte) string {
	var parsed struct {
		Error any `json:"error"`
	}
	if json.Unmarshal(body, &parsed) == nil && parsed.Error != nil {
		switch e := parsed.Error.(type) {
		case string:
			return truncate(e, 200)
		case map[string]any:
			if m, ok := e["message"].(string); ok {
				return truncate(m, 200)
			}
		}
	}
	return truncate(strings.TrimSpace(string(body)), 200)
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func firstOf(ss []string) string {
	if len(ss) > 0 {
		return ss[0]
	}
	return ""
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
